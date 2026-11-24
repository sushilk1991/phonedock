import SwiftUI

// MARK: - Older iPhones: Set Up Control
//
// iPhones on iOS 26 and earlier take taps, typing and the UI tree through WebDriverAgent, a test runner on the phone.
// One button asks the service to build PhoneDock's pinned copy with the team Xcode is signed in to, start it, and keep
// it running after reboots and restarts (POST /v1/ios/wda-setup; docs/API.md "Older iPhones"). This file holds that
// flow and the three places it shows: the inspector's Info tab, the stage, and Connect a Physical Device.

/// One signing team from `GET /v1/ios/wda-teams`.
struct WdaTeam: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var name: String
    var type: String?
    var free: Bool
    /// Personal (free) teams are worth flagging: their signing lasts 7 days (PhoneDock renews it).
    var label: String { free ? "\(name) · Personal" : name }
}

struct WdaTeamsResponse: Decodable, Sendable {
    var teams: [WdaTeam]
    var xcode: Bool
    var xcodeVersion: String?
    var minIos: String?
}

/// `Device.meta.wdaControl`: what the service is doing about a phone whose WebDriverAgent it manages.
struct WdaControl: Equatable {
    var state: String
    var message: String
    var hint: String?

    init?(_ v: JSONValue?) {
        guard let v, let state = v["state"]?.stringValue, let message = v["message"]?.stringValue else { return nil }
        self.state = state
        self.message = message
        self.hint = v["hint"]?.stringValue
    }

    var isRunning: Bool { state == "running" }
    var isFailed: Bool { state == "failed" }
    /// The service is waiting on the person (unlock, plug in, trust) or the network: not a failure.
    var isWaiting: Bool { state.hasPrefix("waiting") || state == "unreachable" }
}

extension Device {
    /// A real iPhone on iOS 26 or older that this Mac has paired with, so PhoneDock can set it up here. (A phone reached
    /// only through an address, `wda-…` or a manual entry, has its WebDriverAgent run by someone else.)
    var isOlderPairedIphone: Bool {
        guard backend == "ios-device", pdIsBeta, !(nativeId ?? "").hasPrefix("wda-") else { return false }
        if case .bool(true) = meta?["manual"] { return false }
        return true
    }

    var wdaControl: WdaControl? { WdaControl(meta?["wdaControl"]) }

    var wdaAnswers: Bool { if case .bool(true) = meta?["wdaReady"] { return true }; return false }

    /// Whether to offer Set Up Control: nothing answers yet and PhoneDock isn't already looking after it (or gave up).
    var offersControlSetup: Bool {
        isOlderPairedIphone && !wdaAnswers && (wdaControl == nil || wdaControl?.isFailed == true)
    }
}

/// One run of Set Up Control, per device (`AppModel.controlSetups`).
enum ControlSetup: Equatable {
    case checking
    case chooseTeam([WdaTeam])
    case running(String)
    case done
    case failed(FriendlyError)
    /// The setup ended on something only the person can fix on the phone (unlock, trust); the service carries on by
    /// itself once that's done, so its live state replaces this as soon as it moves on.
    case handedOff(FriendlyError)
}

extension AppModel {
    /// The setup run to show for a device. A failure that left the service managing the phone (locked, untrusted:
    /// the service carries on by itself) gives way to the service's live state once that moves on.
    func controlFlow(for device: Device) -> ControlSetup? {
        let flow = controlSetups[device.id]
        if case .handedOff = flow, let c = device.wdaControl, !c.isFailed { return nil }
        return flow
    }

    /// Setup failures the service keeps working on by itself once the person has done their part.
    static let handedOffCodes: Set<String> = ["device_locked", "wda_untrusted", "no_device"]

    /// Set Up Control: read Xcode's teams; one goes straight on, several ask, none says how to sign in.
    func beginControlSetup(_ device: Device) {
        guard let c = client else { toast = Toast(title: "PhoneDock isn’t connected", message: "It reconnects automatically."); return }
        if case .running = controlSetups[device.id] { return }
        controlSetups[device.id] = .checking
        Task {
            do {
                let r = try await c.get(WdaTeamsResponse.self, "/v1/ios/wda-teams", timeout: 30)
                guard r.xcode else {
                    controlSetups[device.id] = .failed(FriendlyError(title: "Install Xcode first",
                        message: "PhoneDock builds the iPhone’s helper with Xcode. Install it from the App Store, open it once, then try again."))
                    return
                }
                switch r.teams.count {
                case 0: controlSetups[device.id] = .failed(Self.signInProblem)
                case 1: startControlSetup(device, team: r.teams[0].id)
                default: controlSetups[device.id] = .chooseTeam(r.teams)
                }
            } catch {
                controlSetups[device.id] = .failed(FriendlyError.from(error, title: "Couldn’t check Xcode’s accounts"))
            }
        }
    }

    func startControlSetup(_ device: Device, team: String?) {
        guard let c = client, let udid = device.nativeId else {
            controlSetups[device.id] = .failed(FriendlyError(title: "PhoneDock isn’t connected", message: "It reconnects automatically. Try again in a moment."))
            return
        }
        controlSetups[device.id] = .running("Checking Xcode and the iPhone…")
        Task {
            do {
                var body: [String: Any] = ["udid": udid]
                if let team { body["team"] = team }
                let job = try await c.sendJob("POST", "/v1/ios/wda-setup", json: body)
                let end = try await c.follow(job) { [weak self] j in
                    guard let self, case .running = self.controlSetups[device.id], let l = j.lastLine else { return }
                    self.controlSetups[device.id] = .running(Self.plainProgress(l))
                }
                await refresh()
                if end.isDone {
                    controlSetups[device.id] = .done
                    try? await Task.sleep(for: .seconds(4))
                    if controlSetups[device.id] == .done { controlSetups[device.id] = nil }
                } else if let code = end.apiError?.code, Self.handedOffCodes.contains(code) {
                    controlSetups[device.id] = .handedOff(Self.controlProblem(end))
                } else {
                    controlSetups[device.id] = .failed(Self.controlProblem(end))
                }
            } catch is CancellationError {
                controlSetups[device.id] = nil
            } catch {
                controlSetups[device.id] = .failed(FriendlyError.from(error, title: "Couldn’t set up control"))
            }
        }
    }

    func dismissControlSetup(_ device: Device) { controlSetups[device.id] = nil }

    static let signInProblem = FriendlyError(
        title: "Sign in to Xcode first",
        message: "Open Xcode › Settings › Accounts and add your Apple ID (a free one works), then try again.",
        details: "PhoneDock signs the iPhone’s helper with your Apple ID. Without one in Xcode, run `phonedock ios wda-setup` with an App Store Connect API key (--api-key-path, --api-key-id, --api-key-issuer).")

    /// "21:04:05 Building WebDriverAgent…" → "Building WebDriverAgent…"
    static func plainProgress(_ line: String) -> String {
        var t = line
        if let r = t.range(of: #"^\d\d:\d\d:\d\d "#, options: .regularExpression) { t.removeSubrange(r) }
        return t
    }

    /// A failed setup job in words: titles for the codes a person fixes on the phone or the Mac, the service's own
    /// sentence and hint otherwise.
    static func controlProblem(_ job: Job) -> FriendlyError {
        var p = FriendlyError.from(job: job, title: "Couldn’t set up control")
        guard let e = job.apiError else { return p }
        switch e.code {
        case "xcode_account_missing": p = FriendlyError(title: signInProblem.title, message: signInProblem.message, details: p.details)
        case "developer_mode_off":
            p.title = "Turn on Developer Mode"
            p.message = "On the iPhone open Settings › Privacy & Security › Developer Mode. It restarts; then try again."
        case "device_locked":
            p.title = "Unlock the iPhone"
            p.message = "PhoneDock carries on by itself once it’s unlocked."
        case "not_found", "not_paired":
            p.title = "Trust this Mac on the iPhone"
            p.message = "Plug it in by USB, unlock it and tap Trust, then try again."
        case "wda_untrusted":
            p.title = "Trust the developer on the iPhone"
            p.message = "Open Settings › General › VPN & Device Management, tap your Apple ID and tap Trust. PhoneDock carries on by itself."
        case "no_device":
            p.title = "Can’t reach the iPhone"
            p.message = "Plug it in by USB, or wake it on the same Wi-Fi as this Mac."
        default:
            break
        }
        return p
    }
}

// MARK: - Inspector (Info tab) and Connect sheet

/// Set Up Control and its progress for one older iPhone. `compact`: a row in Connect a Physical Device.
struct ControlSetupPanel: View {
    @Environment(AppModel.self) private var model
    let device: Device
    var compact = false
    @State private var team: String?

    private var flow: ControlSetup? { model.controlFlow(for: device) }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            switch flow {
            case .checking:
                working("Checking Xcode’s accounts…")
            case .running(let line):
                working(line, note: "The first time takes a few minutes. Keep the iPhone unlocked.")
            case .chooseTeam(let teams):
                teamPicker(teams)
            case .done:
                ConnectStatusView(status: .ok("Control is set up")).testAnchor("control-setup-done")
            case .failed(let p), .handedOff(let p):
                ProblemView(problem: p, retry: { model.beginControlSetup(device) },
                            otherTitle: "Dismiss", other: { model.dismissControlSetup(device) })
                    .testAnchor("control-setup-problem")
            case nil:
                idle
            }
        }
        .onAppear { if team == nil, case .chooseTeam(let t) = flow { team = t.first?.id } }
    }

    @ViewBuilder private var idle: some View {
        if let c = device.wdaControl {
            controlStatus(c)
        } else if device.wdaAnswers {
            statusLine("Taps and typing work through WebDriverAgent", dot: .running)
        } else {
            if !compact {
                Text("Taps, typing and the UI tree need a one-time setup. PhoneDock builds a small helper with your Apple ID in Xcode, puts it on the iPhone, and keeps it running.")
                    .font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button("Set Up Control") { model.beginControlSetup(device) }
                .controlSize(compact ? .small : .regular)
                .disabled(!device.isRunning)
                .help(device.isRunning ? "Build and start WebDriverAgent on \(device.name)" : "Connect and unlock the iPhone first")
                .testAnchor("Set Up Control")
            if !compact {
                Text("Needs Developer Mode on the iPhone, and the iPhone trusted once over USB.")
                    .font(Theme.Fonts.meta).foregroundStyle(Theme.Ink.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// What the service reports while it manages the phone.
    @ViewBuilder private func controlStatus(_ c: WdaControl) -> some View {
        if c.isFailed {
            ProblemView(problem: FriendlyError(title: "Control stopped", message: [c.message, c.hint].compactMap { $0 }.map(sentence).joined(separator: " ")),
                        retryTitle: "Set Up Again", retry: { model.beginControlSetup(device) })
                .testAnchor("control-failed")
        } else {
            VStack(alignment: .leading, spacing: Theme.Space.xs) {
                statusLine(c.isRunning ? "Control is set up" : c.message,
                           dot: c.isRunning ? .running : c.isWaiting ? .booting : .booting, working: !c.isRunning && !c.isWaiting)
                if !c.isRunning, let h = c.hint {
                    Text(h).font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.leading, 14)
                }
                if c.isRunning && !compact {
                    Text("PhoneDock keeps it running, also after the iPhone or this Mac restarts.")
                        .font(Theme.Fonts.meta).foregroundStyle(Theme.Ink.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.leading, 14)
                }
            }
            .testAnchor("control-status")
        }
    }

    private func teamPicker(_ teams: [WdaTeam]) -> some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            Text("Xcode is signed in to \(teams.count) teams. Which one signs the helper?")
                .font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                .fixedSize(horizontal: false, vertical: true)
            // One row when the team names fit, the buttons under the menu when they don't.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Theme.Space.s) { teamMenu(teams); teamButtons(teams) }
                VStack(alignment: .leading, spacing: Theme.Space.s) { teamMenu(teams); HStack(spacing: Theme.Space.s) { teamButtons(teams) } }
            }
        }
        .onAppear { if team == nil { team = teams.first?.id } }
    }

    private func teamMenu(_ teams: [WdaTeam]) -> some View {
        Picker("Team", selection: Binding(get: { team ?? teams.first?.id ?? "" }, set: { team = $0 })) {
            ForEach(teams) { t in Text(t.label).tag(t.id) }
        }
        .labelsHidden()
        .fixedSize()
        .accessibilityLabel("Signing team")
        .testAnchor("Signing team")
    }

    @ViewBuilder private func teamButtons(_ teams: [WdaTeam]) -> some View {
        Button("Set Up") { model.startControlSetup(device, team: team ?? teams.first?.id) }
            .keyboardShortcut(compact ? nil : .defaultAction)
            .testAnchor("Set Up With Team")
        Button("Cancel") { model.dismissControlSetup(device) }
            .buttonStyle(.borderless)
            .foregroundStyle(Theme.Ink.secondary)
    }

    private func working(_ line: String, note: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: Theme.Space.xs) {
            HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s) {
                ProgressView().controlSize(.small)
                Text(line).font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.primary)
                    .lineLimit(2).fixedSize(horizontal: false, vertical: true)
            }
            if let note, !compact {
                Text(note).font(Theme.Fonts.meta).foregroundStyle(Theme.Ink.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .testAnchor("control-setup-working")
    }

    private func statusLine(_ text: String, dot: PDStatus, working: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s) {
            if working { ProgressView().controlSize(.mini) } else { StatusDot(status: dot) }
            Text(text).font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.primary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func sentence(_ s: String) -> String {
        let t = s.trimmingCharacters(in: .whitespaces)
        guard let last = t.last else { return t }
        return ".!?".contains(last) ? t : t + "."
    }
}

// MARK: - Stage

/// Bottom-of-stage capsule for an older iPhone that can't take taps yet: Set Up, the setup's progress, or what the
/// service is waiting for. A choice of team or an error opens the inspector, where there's room for it.
struct OlderIphoneControlCapsule: View {
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var scheme
    let device: Device

    static func shows(_ d: Device, flow: ControlSetup?) -> Bool {
        guard d.isOlderPairedIphone, d.isRunning else { return false }
        if flow != nil { return true }
        if let c = d.wdaControl { return !c.isRunning }
        return !d.wdaAnswers
    }

    var body: some View {
        HStack(spacing: Theme.Space.xs) {
            switch model.controlFlow(for: device) {
            case .checking, .running:
                ProgressView().controlSize(.mini).id(scheme)
                Text("Setting up control…").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.primary)
            case .chooseTeam:
                Image(systemName: "person.2").foregroundStyle(Theme.Ink.secondary).accessibilityHidden(true)
                Text("Choose a team").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.primary)
                Text("·").foregroundStyle(Theme.Ink.secondary)
                Button("Show") { showInspector() }.buttonStyle(.pdLink).font(Theme.Fonts.callout)
            case .done:
                Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.Status.running).accessibilityHidden(true)
                Text("Control is set up").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.primary)
            case .failed, .handedOff:
                failedLine("Setup failed")
            case nil:
                if let c = device.wdaControl, !c.isRunning {
                    if c.isFailed { failedLine("Control stopped") }
                    else {
                        if c.isWaiting {
                            Image(systemName: c.state == "waiting_unlock" ? "lock.fill" : c.state == "unreachable" ? "wifi.exclamationmark" : "hourglass")
                                .foregroundStyle(Theme.Ink.secondary).accessibilityHidden(true)
                        } else { ProgressView().controlSize(.mini).id(scheme) }
                        // The capsule is as narrow as the phone: a short label, the full sentence in the inspector.
                        Text(Self.shortLabel(c)).font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.primary)
                        if c.state != "waiting_unlock" {
                            Text("·").foregroundStyle(Theme.Ink.secondary)
                            Button("Details") { showInspector() }.buttonStyle(.pdLink).font(Theme.Fonts.callout)
                        }
                    }
                } else {
                    Image(systemName: "hand.tap").foregroundStyle(Theme.Ink.secondary).accessibilityHidden(true)
                    Text("Set up control to tap and type").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.primary)
                    Text("·").foregroundStyle(Theme.Ink.secondary)
                    Button("Set Up") { model.beginControlSetup(device); showInspector() }
                        .buttonStyle(.pdLink).font(Theme.Fonts.callout)
                        .testAnchor("Set Up Control (stage)")
                }
            }
        }
        .lineLimit(1)
        .minimumScaleFactor(0.85)
        .padding(.horizontal, Theme.Space.m)
        .padding(.vertical, Theme.Space.xs + 1)
        .background(Theme.Surface.card, in: Capsule())
        .overlay(Capsule().strokeBorder(Theme.Line.card, lineWidth: 1))
        .padding(.horizontal, Theme.Space.s)
        .accessibilityElement(children: .contain)
        .testAnchor("older-iphone-control")
    }

    @ViewBuilder private func failedLine(_ title: String) -> some View {
        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.Status.error).accessibilityHidden(true)
        Text(title).font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.primary)
        Text("·").foregroundStyle(Theme.Ink.secondary)
        Button("Details") { showInspector() }.buttonStyle(.pdLink).font(Theme.Fonts.callout)
    }

    private func showInspector() { model.requestedInspectorTab = .info }

    static func shortLabel(_ c: WdaControl) -> String {
        switch c.state {
        case "waiting_unlock": return "Unlock the iPhone"
        case "waiting_phone": return "Waiting for the iPhone"
        case "waiting_trust": return "Trust the developer"
        case "unreachable": return "Can’t reach the iPhone"
        default: return "Starting control…"
        }
    }
}
