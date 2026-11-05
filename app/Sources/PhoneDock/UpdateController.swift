// UpdateController.swift — auto-update through Sparkle 2, with PhoneDock's own UI instead of Sparkle's windows.
//
// Sparkle checks the appcast (SUFeedURL, on the GitHub Pages site), downloads the archive (a GitHub Release asset),
// checks its EdDSA signature against SUPublicEDKey before unpacking it, and its installer replaces the app and relaunches
// it. This file is Sparkle's user driver: Sparkle tells it what is happening and it publishes `phase`, which the
// sidebar's update item (UpdateSidebarItem.swift) and Settings › Updates (UpdatesSettingsSection.swift) show.
// UpdateVerifier.swift adds a code-signing check (same Developer ID team) before anything is installed.
// Release side: scripts/release-appcast.sh and docs/RELEASING.md.

import AppKit
import Observation
import Sparkle

/// An update the appcast offers.
struct UpdateOffer: Equatable {
    /// "0.2.0" (sparkle:shortVersionString), what people see.
    var version: String
    /// "2000" (sparkle:version, CFBundleVersion), what Sparkle compares.
    var build: String
    var releaseNotes: URL?
    /// An appcast item with a link instead of a download.
    var infoOnly = false
    var infoURL: URL?

    init(version: String, build: String, releaseNotes: URL? = nil, infoOnly: Bool = false, infoURL: URL? = nil) {
        self.version = version; self.build = build; self.releaseNotes = releaseNotes; self.infoOnly = infoOnly; self.infoURL = infoURL
    }

    init(_ item: SUAppcastItem) {
        self.init(version: item.displayVersionString, build: item.versionString,
                  releaseNotes: item.fullReleaseNotesURL ?? item.releaseNotesURL ?? item.infoURL,
                  infoOnly: item.isInformationOnlyUpdate, infoURL: item.infoURL)
    }
}

enum UpdatePhase: Equatable {
    /// Nothing to show.
    case idle
    /// A check someone asked for (menu, Settings, Try Again). Background checks show nothing until they find something.
    case checking
    case available(UpdateOffer)
    /// fraction is nil until the server says how big the download is.
    case downloading(UpdateOffer, fraction: Double?)
    /// Unpacking and verifying.
    case installing(UpdateOffer)
    /// Quitting so the installer can swap the app; `stuck` once the quit is taking long.
    case relaunching(UpdateOffer, stuck: Bool)
    case failed(UpdateOffer?, FriendlyError)

    var offer: UpdateOffer? {
        switch self {
        case .idle, .checking: return nil
        case .available(let o), .downloading(let o, _), .installing(let o), .relaunching(let o, _): return o
        case .failed(let o, _): return o
        }
    }
}

/// The feed: the app's SUFeedURL, unless a test points it at a local server. `PHONEDOCK_UPDATE_FEED_URL` is honoured only
/// for a loopback address (http://127.0.0.1:…, http://localhost:…), so it can't send anyone to another server; an update
/// from there still needs the EdDSA signature and the code-signing check.
enum UpdateFeed {
    static let override: URL? = {
        guard let raw = ProcessInfo.processInfo.environment["PHONEDOCK_UPDATE_FEED_URL"], !raw.isEmpty,
              let url = URL(string: raw), let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = url.host?.lowercased(), ["127.0.0.1", "localhost", "::1"].contains(host) else { return nil }
        return url
    }()
}

@MainActor
@Observable
final class UpdateController {
    static let shared = UpdateController()

    enum Origin { case background, menu, settings }

    private(set) var phase: UpdatePhase = .idle
    /// Why this build can't update itself (a development build, no public key); nil once the updater runs.
    private(set) var unavailableReason: String? = "Checking for updates starts with the app."
    /// Sparkle can start a check now (false while one runs).
    private(set) var canCheck = false
    private(set) var lastChecked: Date?
    /// What the last check this session found, whoever started it (Settings › Updates shows it); nil until one ends.
    private(set) var lastResult: CheckResult?
    /// Sparkle's "check automatically" setting (also kept in the app's defaults by Sparkle).
    var automaticChecks = true {
        didSet { if let updater, updater.automaticallyChecksForUpdates != automaticChecks { updater.automaticallyChecksForUpdates = automaticChecks } }
    }

    enum CheckResult: Equatable {
        case upToDate
        case found(String)
        case failed(FriendlyError)
    }

    var currentVersion: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev" }
    var currentBuild: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "" }

    @ObservationIgnored private var updater: SPUUpdater?
    @ObservationIgnored private var driver: UpdateUserDriver?
    @ObservationIgnored private var delegate: UpdaterDelegate?
    @ObservationIgnored private weak var model: AppModel?
    @ObservationIgnored private var observations: [NSKeyValueObservation] = []
    /// Sparkle's answer handlers, kept until the person acts.
    @ObservationIgnored private var foundReply: ((SPUUserUpdateChoice) -> Void)?
    @ObservationIgnored private var errorAcknowledgement: (() -> Void)?
    @ObservationIgnored private var cancelDownloadHandler: (() -> Void)?
    @ObservationIgnored private var retryTermination: (() -> Void)?
    @ObservationIgnored private var expectedBytes: UInt64 = 0
    @ObservationIgnored private var receivedBytes: UInt64 = 0
    @ObservationIgnored private var origin: Origin = .background
    /// The person already chose Update; install as soon as Sparkle offers it again (after Try Again or a cancelled download).
    @ObservationIgnored private var installWhenFound = false
    /// Try Again: start a new check once Sparkle has closed the failed session.
    @ObservationIgnored private var checkAfterCycle = false
    /// A check shortly after every launch, on top of Sparkle's daily schedule (SUScheduledCheckInterval).
    @ObservationIgnored private let launchCheckDelay: Duration = .seconds(8)

    private init() {}

    /// The app delegate calls this once the app has finished launching.
    func start() {
        guard updater == nil else { return }
        guard DaemonLocator.isBundled else {
            unavailableReason = "Updates work in the PhoneDock app, not in a development build."
            return
        }
        let key = (Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !key.isEmpty, Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") != nil || UpdateFeed.override != nil else {
            unavailableReason = "This build of PhoneDock doesn’t check for updates."
            return
        }
        // UI self-tests run scratch builds behind the person's work: they never reach the real feed.
        guard !SelfTest.enabled || UpdateFeed.override != nil else {
            unavailableReason = "Updates are off during a self-test."
            return
        }
        let driver = UpdateUserDriver(self), delegate = UpdaterDelegate(self)
        let updater = SPUUpdater(hostBundle: .main, applicationBundle: .main, userDriver: driver, delegate: delegate)
        do {
            try updater.start()
        } catch {
            unavailableReason = "PhoneDock can’t check for updates in this build."
            NSLog("PhoneDock updates: Sparkle didn’t start: %@", String(describing: error))
            return
        }
        self.updater = updater; self.driver = driver; self.delegate = delegate
        unavailableReason = nil
        automaticChecks = updater.automaticallyChecksForUpdates
        lastChecked = updater.lastUpdateCheckDate
        observations = [
            updater.observe(\.canCheckForUpdates, options: [.initial, .new]) { [weak self] u, _ in
                let can = u.canCheckForUpdates
                Task { @MainActor in self?.canCheck = can }
            },
        ]
        if let feed = UpdateFeed.override { note("test feed \(feed.absoluteString)") }
        Task { [weak self] in
            try? await Task.sleep(for: self?.launchCheckDelay ?? .seconds(8))
            self?.checkAfterLaunch()
        }
    }

    /// The window's model, for toasts and to bring the sidebar back. Called by the sidebar item.
    func attach(_ model: AppModel) { self.model = model }

    private func checkAfterLaunch() {
        guard let u = updater, u.automaticallyChecksForUpdates, u.canCheckForUpdates, !u.sessionInProgress else { return }
        // Sparkle's own schedule may just have checked. Only a moment ago, though: Sparkle doesn't remember what a
        // check found, so an update found before a quick quit and reopen would otherwise stay hidden for a day.
        if let last = u.lastUpdateCheckDate, Date().timeIntervalSince(last) < 60 { return }
        origin = .background
        u.checkForUpdatesInBackground()
    }

    // MARK: Actions

    /// Check for Updates… (app menu) and Check Now (Settings).
    func checkForUpdates(from origin: Origin) {
        guard let u = updater else { return }
        switch phase {
        case .downloading, .installing, .relaunching:
            revealSidebar()
            return
        case .available where foundReply != nil:
            // Already offered: bring it into view rather than asking the server again.
            revealSidebar()
            return
        default:
            break
        }
        self.origin = origin
        u.checkForUpdates()
    }

    /// The sidebar's Update button: download, verify, install and relaunch.
    func install() {
        guard case .available(let offer) = phase else { return }
        if offer.infoOnly {
            if let url = offer.infoURL ?? offer.releaseNotes, !SelfTest.blocksForeground("open \(url.absoluteString)") { NSWorkspace.shared.open(url) }
            foundReply?(.dismiss); foundReply = nil
            phase = .idle
            return
        }
        guard let reply = foundReply else {
            // Sparkle's session for this offer has ended (a cancelled download): find it again and go straight on.
            installWhenFound = true
            phase = .downloading(offer, fraction: nil)
            origin = .menu
            updater?.checkForUpdates()
            return
        }
        foundReply = nil
        phase = .downloading(offer, fraction: nil)
        reply(.install)
    }

    func cancelDownload() {
        guard case .downloading(let offer, _) = phase, let cancel = cancelDownloadHandler else { return }
        cancelDownloadHandler = nil
        installWhenFound = false
        // Keep offering it: Update finds it again (`install()` without a reply).
        phase = .available(offer)
        cancel()
    }

    func dismissError() {
        guard case .failed = phase else { return }
        phase = .idle
        acknowledgeError()
    }

    func retry() {
        guard case .failed(let offer, _) = phase else { return }
        installWhenFound = offer != nil
        phase = offer.map { .downloading($0, fraction: nil) } ?? .checking
        origin = .menu
        if errorAcknowledgement != nil {
            checkAfterCycle = true
            acknowledgeError()       // Sparkle closes the session, then `cycleFinished` checks again
        } else {
            updater?.checkForUpdates()
        }
    }

    /// The quit Sparkle asked for hasn't happened yet (an open sheet or alert holds it): ask again.
    func retryRestart() { retryTermination?() }

    func openReleaseNotes() {
        guard let url = phase.offer?.releaseNotes ?? phase.offer?.infoURL, !SelfTest.blocksForeground("open \(url.absoluteString)") else { return }
        NSWorkspace.shared.open(url)
    }

    private func acknowledgeError() {
        let ack = errorAcknowledgement
        errorAcknowledgement = nil
        ack?()
    }

    private func revealSidebar() {
        if let model, !model.sidebarVisible { model.sidebarVisible = true }
    }

    private func toast(_ t: Toast) { model?.toast = t }

    /// The system log (and a self-test's log): what happened to a check or an update, in a line.
    private func note(_ s: String) {
        NSLog("PhoneDock updates: %@", s)
        if SelfTest.enabled { SelfTest.log("updates: \(s)") }
    }

    // MARK: Sparkle → UI (UpdateUserDriver forwards here)

    fileprivate func userInitiatedCheckStarted() {
        if phase.offer == nil { phase = .checking }
    }

    fileprivate func found(_ item: SUAppcastItem, state: SPUUserUpdateState, reply: @escaping (SPUUserUpdateChoice) -> Void) {
        lastChecked = Date()
        let offer = UpdateOffer(item)
        lastResult = .found(offer.version)
        if installWhenFound, !offer.infoOnly {
            installWhenFound = false
            phase = .downloading(offer, fraction: nil)
            reply(.install)
            return
        }
        foundReply?(.dismiss)
        foundReply = reply
        phase = .available(offer)
        if state.userInitiated { revealSidebar() }
    }

    fileprivate func notFound(_ error: Error) {
        lastChecked = Date()
        let wasRetry = installWhenFound
        installWhenFound = false
        if case .checking = phase { phase = .idle }
        if case .downloading = phase, wasRetry { phase = .idle }
        let reason = ((error as NSError).userInfo[SPUNoUpdateFoundReasonKey] as? NSNumber)?.int32Value
        let message: String
        switch reason {
        case SPUNoUpdateFoundReason.systemIsTooOld.rawValue: message = "The newest version needs a newer version of macOS."
        case SPUNoUpdateFoundReason.hardwareDoesNotSupportARM64.rawValue: message = "The newest version needs a Mac with Apple silicon."
        default: message = "Version \(currentVersion) is the newest."
        }
        lastResult = .upToDate
        switch origin {
        case .settings: break
        case .menu: toast(Toast(kind: .success, title: "PhoneDock is up to date", message: message))
        case .background: break
        }
    }

    fileprivate func failed(_ error: Error, acknowledgement: @escaping () -> Void) {
        let ns = error as NSError
        let offer = phase.offer
        let friendly = UpdateErrors.friendly(ns, offer: offer)
        let inUpdate: Bool
        switch phase {
        case .downloading, .installing, .relaunching: inUpdate = true
        default: inUpdate = installWhenFound
        }
        installWhenFound = false
        note("\(inUpdate ? "update" : "check") failed: \(friendly.details ?? friendly.title)")
        if !inUpdate {
            // A check failed. A check someone asked for says so where they asked.
            acknowledgement()
            if case .checking = phase { phase = .idle }
            // Settings › Updates shows it, from any check; a background check never interrupts.
            lastResult = .failed(friendly)
            switch origin {
            case .settings: break
            case .menu: toast(Toast(kind: .error, title: friendly.title, message: friendly.message, details: friendly.details))
            case .background: break
            }
            return
        }
        errorAcknowledgement = acknowledgement
        phase = .failed(offer, friendly)
        revealSidebar()
    }

    fileprivate func downloadStarted(cancel: @escaping () -> Void) {
        cancelDownloadHandler = cancel
        expectedBytes = 0; receivedBytes = 0
        if let offer = phase.offer { phase = .downloading(offer, fraction: nil) }
    }

    fileprivate func downloadExpects(_ length: UInt64) {
        expectedBytes = length
        receivedBytes = 0
    }

    fileprivate func downloadReceived(_ length: UInt64) {
        receivedBytes += length
        guard expectedBytes > 0, case .downloading(let offer, let old) = phase else { return }
        let f = min(1, Double(receivedBytes) / Double(expectedBytes))
        // Whole percents: the bar moves smoothly without redrawing the sidebar for every packet.
        if old.map({ Int($0 * 100) }) != Int(f * 100) { phase = .downloading(offer, fraction: f) }
    }

    fileprivate func extracting() {
        cancelDownloadHandler = nil
        if let offer = phase.offer { phase = .installing(offer) }
    }

    /// Sparkle has unpacked the update and checked its EdDSA signature. Check who signed the app before it's installed.
    fileprivate func readyToInstall(reply: @escaping (SPUUserUpdateChoice) -> Void) {
        guard let offer = phase.offer else { reply(.dismiss); return }
        phase = .installing(offer)
        let bundleID = Bundle.main.bundleIdentifier ?? ""
        let build = offer.build
        Task.detached(priority: .userInitiated) {
            // `checked`: the new copy was found and examined (a failure then means it's signed by someone else).
            let (result, checked): (Result<Void, UpdateVerifier.Failure>, Bool) = {
                guard let me = UpdateVerifier.runningIdentity() else {
                    return (.failure(.init(description: "This copy of PhoneDock isn’t code signed")), false)
                }
                guard let staged = UpdateVerifier.stagedUpdate(bundleIdentifier: bundleID, build: build) else {
                    return (.failure(.init(description: "Couldn’t find the unpacked update (build \(build)) in Sparkle’s cache")), false)
                }
                return (UpdateVerifier.verify(bundle: staged, expected: me, expectedBuild: build), true)
            }()
            await MainActor.run {
                switch result {
                case .success:
                    self.note("build \(build) is signed like this copy; installing")
                    self.phase = .relaunching(offer, stuck: false)
                    reply(.install)
                case .failure(let why):
                    self.note("refusing build \(build): \(why.description)")
                    // .skip cancels the prepared installation; nothing on disk changes.
                    self.phase = .failed(offer, FriendlyError(
                        title: "Couldn’t verify the update",
                        message: checked ? "It isn’t signed by PhoneDock’s developer, so PhoneDock didn’t install it."
                                         : "PhoneDock couldn’t check the download, so it didn’t install it.",
                        details: why.description))
                    reply(.skip)
                }
            }
        }
    }

    fileprivate func installing(retry: @escaping () -> Void) {
        retryTermination = retry
        guard let offer = phase.offer else { return }
        phase = .relaunching(offer, stuck: false)
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(10))
            guard let self, case .relaunching(let o, false) = self.phase else { return }
            self.phase = .relaunching(o, stuck: true)
        }
    }

    fileprivate func installedAndRelaunched() {
        phase = .idle
    }

    fileprivate func showInFocus() { revealSidebar() }

    fileprivate func dismissed() {
        foundReply = nil
        cancelDownloadHandler = nil
        retryTermination = nil
        switch phase {
        case .failed: break                                  // stays until the person dismisses it
        case .available where installWhenFound == false && foundReply == nil:
            break                                            // a cancelled download: still offered
        default: if !installWhenFound { phase = .idle }
        }
    }

    fileprivate func cycleFinished() {
        lastChecked = updater?.lastUpdateCheckDate ?? lastChecked
        guard checkAfterCycle else { return }
        checkAfterCycle = false
        updater?.checkForUpdates()
    }
}

// MARK: - Errors in plain words

enum UpdateErrors {
    /// Translocated or on a disk image: Try Again can't help until the app is moved.
    static let moveTitle = "Move PhoneDock to Applications"

    static func canRetry(_ problem: FriendlyError) -> Bool { problem.title != moveTitle }

    /// The EdDSA signature didn't match: a broken download, or an archive someone changed.
    private static let damaged = "The download was damaged or changed, so PhoneDock didn’t install it."

    static func friendly(_ error: NSError, offer: UpdateOffer?) -> FriendlyError {
        let details = describe(error)
        let installing = offer != nil
        let title = installing ? "Couldn’t update PhoneDock" : "Couldn’t check for updates"
        if isNetwork(error) {
            return FriendlyError(title: title, message: "Check your internet connection and try again.", details: details)
        }
        if error.domain == SUSparkleErrorDomain {
            switch Int32(truncatingIfNeeded: error.code) {
            case SUError.runningTranslocated.rawValue, SUError.runningFromDiskImageError.rawValue:
                return FriendlyError(title: moveTitle,
                                     message: "PhoneDock can’t update itself where it is. Drag it to Applications and open it from there.",
                                     details: details)
            case SUError.signatureError.rawValue, SUError.validationError.rawValue, SUError.unarchivingError.rawValue,
                 SUError.notValidUpdateError.rawValue:
                return FriendlyError(title: "Couldn’t verify the update", message: damaged, details: details)
            case SUError.installationWriteNoPermissionError.rawValue, SUError.authenticationFailure.rawValue, SUError.fileCopyFailure.rawValue:
                return FriendlyError(title: title, message: "Your account can’t replace PhoneDock in its folder. Ask an administrator, or reinstall it.", details: details)
            case SUError.downgradeError.rawValue:
                return FriendlyError(title: title, message: "This copy is newer than the update.", details: details)
            default:
                break
            }
            // The installer reports validation failures in its own error, with the cause underneath.
            if containsValidationFailure(error) {
                return FriendlyError(title: "Couldn’t verify the update", message: damaged, details: details)
            }
        }
        return FriendlyError(title: title, message: "Try again later.", details: details)
    }

    private static func underlying(_ e: NSError) -> [NSError] {
        var out: [NSError] = []
        if let u = e.userInfo[NSUnderlyingErrorKey] as? NSError { out.append(u); out += underlying(u) }
        for u in (e.userInfo[NSMultipleUnderlyingErrorsKey] as? [NSError]) ?? [] { out.append(u); out += underlying(u) }
        return out
    }

    private static func isNetwork(_ e: NSError) -> Bool {
        ([e] + underlying(e)).contains { $0.domain == NSURLErrorDomain }
    }

    private static func containsValidationFailure(_ e: NSError) -> Bool {
        ([e] + underlying(e)).contains { err in
            err.domain == SUSparkleErrorDomain && [SUError.signatureError.rawValue, SUError.validationError.rawValue]
                .contains(Int32(truncatingIfNeeded: err.code))
        }
    }

    /// The raw chain for Details: domain, code and message of each error.
    static func describe(_ e: NSError) -> String {
        ([e] + underlying(e)).map { "\($0.domain) \($0.code): \($0.localizedDescription)" }.joined(separator: "\n")
    }
}

// MARK: - Sparkle plumbing

/// Sparkle's user driver: every call arrives on the main thread and goes straight to the controller.
@MainActor
private final class UpdateUserDriver: NSObject, SPUUserDriver {
    private unowned let c: UpdateController
    init(_ controller: UpdateController) { c = controller }

    func show(_ request: SPUUpdatePermissionRequest, reply: @escaping (SUUpdatePermissionResponse) -> Void) {
        // SUEnableAutomaticChecks is in Info.plist, so Sparkle shouldn't ask; if it does, the answer is the default.
        reply(SUUpdatePermissionResponse(automaticUpdateChecks: true, sendSystemProfile: false))
    }

    func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) { c.userInitiatedCheckStarted() }

    func showUpdateFound(with appcastItem: SUAppcastItem, state: SPUUserUpdateState, reply: @escaping (SPUUserUpdateChoice) -> Void) {
        c.found(appcastItem, state: state, reply: reply)
    }

    func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {}
    func showUpdateReleaseNotesFailedToDownloadWithError(_ error: Error) {}

    func showUpdateNotFoundWithError(_ error: Error, acknowledgement: @escaping () -> Void) {
        c.notFound(error)
        acknowledgement()
    }

    func showUpdaterError(_ error: Error, acknowledgement: @escaping () -> Void) { c.failed(error, acknowledgement: acknowledgement) }

    func showDownloadInitiated(cancellation: @escaping () -> Void) { c.downloadStarted(cancel: cancellation) }
    func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) { c.downloadExpects(expectedContentLength) }
    func showDownloadDidReceiveData(ofLength length: UInt64) { c.downloadReceived(length) }
    func showDownloadDidStartExtractingUpdate() { c.extracting() }
    func showExtractionReceivedProgress(_ progress: Double) {}

    func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) { c.readyToInstall(reply: reply) }

    func showInstallingUpdate(withApplicationTerminated applicationTerminated: Bool, retryTerminatingApplication: @escaping () -> Void) {
        c.installing(retry: retryTerminatingApplication)
    }

    func showUpdateInstalledAndRelaunched(_ relaunched: Bool, acknowledgement: @escaping () -> Void) {
        c.installedAndRelaunched()
        acknowledgement()
    }

    func showUpdateInFocus() { c.showInFocus() }
    func dismissUpdateInstallation() { c.dismissed() }
}

@MainActor
private final class UpdaterDelegate: NSObject, SPUUpdaterDelegate {
    private unowned let c: UpdateController
    init(_ controller: UpdateController) { c = controller }

    func feedURLString(for updater: SPUUpdater) -> String? { UpdateFeed.override?.absoluteString }

    /// The sidebar links to the release notes instead of showing them.
    func updater(_ updater: SPUUpdater, shouldDownloadReleaseNotesForUpdate updateItem: SUAppcastItem) -> Bool { false }

    func updater(_ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: Error?) {
        c.cycleFinished()
    }
}
