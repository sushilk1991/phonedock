import SwiftUI

// MARK: - Older iPhones: Set Up Control
//
// iPhones on iOS 26 and older take taps, typing and the UI tree through WebDriverAgent, a test runner on the phone.
// PhoneDock remembers only the team and the build; every launch is an explicit act, and whether control is on is read
// from the phone (`meta.wdaReady`), never kept here. Set Up Control: POST /v1/ios/wda-setup. Stop Control (every
// WebDriverAgent on the phone): POST /v1/ios/wda-stop. The right-click menu's items are in PhoneDockApp.swift.

/// One signing team from `GET /v1/ios/wda-teams`.
struct WdaTeam: Codable, Hashable, Identifiable, Sendable {
    var id: String, name: String, type: String?, free: Bool
    var label: String { free ? "\(name) · Personal" : name }
}

struct WdaTeamsResponse: Decodable, Sendable { var teams: [WdaTeam]; var xcode: Bool }

extension Device {
    /// A real iPhone on iOS 26 or older that this Mac is paired with, so it can be set up here. (One reached only through
    /// a WebDriverAgent address, a `wda-…` or manual entry, has its WebDriverAgent run somewhere else.)
    var isOlderPairedIphone: Bool {
        guard backend == "ios-device", kind == "physical", pdIsBeta, !(nativeId ?? "").hasPrefix("wda-") else { return false }
        if case .bool(true) = meta?["manual"] { return false }
        return true
    }

    /// WebDriverAgent answers right now.
    var wdaReady: Bool { if case .bool(true) = meta?["wdaReady"] { return true }; return false }

    /// The team Set Up Control used for this phone on this Mac: its build is kept, so setting up again takes seconds.
    var wdaTeam: String? { meta?["wdaTeam"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } }

    /// The device list's check (about once a minute) of whether other Macs on the Wi-Fi can reach it: "shared",
    /// "not_shared", "unknown" (couldn't check), or nil while control isn't on here.
    var wdaSharing: String? { meta?["wdaSharing"]?.stringValue }
    var wdaSharedUrl: String? { meta?["wdaSharedUrl"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } }
}

/// One Set Up Control or Stop Control run for a phone (`AppModel.controlRuns`). It never says whether control is on:
/// the phone does.
enum ControlRun: Equatable {
    case checking
    /// Xcode is signed in to several teams and the phone has none yet. `share` is what the person asked for.
    case chooseTeam([WdaTeam], share: Bool)
    /// The job's latest line. `firstTime`: nothing is built for this phone yet, so it takes a few minutes.
    case running(String, firstTime: Bool)
    /// `shared`: other Macs on this Wi-Fi may control it, at `sharedUrl` when the service knows it.
    case done(shared: Bool, sharedUrl: String?)
    case stopping
    case stopped
    case failed(FriendlyError, retry: ControlRetry)

    var isBusy: Bool { switch self { case .checking, .running, .stopping: true; default: false } }
}

/// What the failure's button does: the same setup again, or Stop Control (a WebDriverAgent PhoneDock left alone, or a
/// stop it couldn't confirm).
enum ControlRetry: Equatable {
    case setUp(team: String?, share: Bool)
    case stop
}

private struct WdaStopResponse: Decodable { var confirmed: Bool? }

extension AppModel {
    func controlRun(_ d: Device) -> ControlRun? { controlRuns[d.id] }
    func controlBusy(_ d: Device) -> Bool { controlRuns[d.id]?.isBusy ?? false }

    /// Shows the phone's Control section (the right-click menu's items report there).
    func showControl(_ d: Device) { selection = d.id; requestedInspectorTab = .info }

    /// Set Up Control. A phone set up here before goes straight on (the service reuses its team); otherwise Xcode's
    /// teams decide: none says how to sign in, one goes straight on, several ask.
    func setUpControl(_ d: Device, share: Bool) {
        if controlBusy(d) { return }
        if d.wdaTeam != nil { runControlSetup(d, team: nil, share: share) } else { chooseControlTeam(d, share: share) }
    }

    private func chooseControlTeam(_ d: Device, share: Bool) {
        guard let c = client else { controlRuns[d.id] = .failed(Self.controlOffline, retry: .setUp(team: nil, share: share)); return }
        controlRuns[d.id] = .checking
        Task {
            do {
                let r = try await c.get(WdaTeamsResponse.self, "/v1/ios/wda-teams", timeout: 30)
                if !r.xcode {
                    controlRuns[d.id] = .failed(FriendlyError(title: "Install Xcode to set up this iPhone",
                        message: "Install Xcode from the App Store, open it once, then try again."), retry: .setUp(team: nil, share: share))
                } else if r.teams.isEmpty {
                    controlRuns[d.id] = .failed(Self.signInToXcode, retry: .setUp(team: nil, share: share))
                } else if r.teams.count == 1 {
                    runControlSetup(d, team: r.teams[0].id, share: share)
                } else {
                    controlRuns[d.id] = .chooseTeam(r.teams, share: share)
                }
            } catch {
                controlRuns[d.id] = .failed(FriendlyError.from(error, title: "Couldn’t check Xcode’s accounts"), retry: .setUp(team: nil, share: share))
            }
        }
    }

    /// `POST /v1/ios/wda-setup`. No `team`: the service reuses the phone's remembered team, or the only one.
    func runControlSetup(_ d: Device, team: String?, share: Bool) {
        let again = ControlRetry.setUp(team: team, share: share)
        guard let c = client, let udid = d.nativeId else { controlRuns[d.id] = .failed(Self.controlOffline, retry: again); return }
        if case .running = controlRuns[d.id] { return }
        if case .stopping = controlRuns[d.id] { return }
        let first = d.wdaTeam == nil
        controlRuns[d.id] = .running("Checking Xcode and the iPhone…", firstTime: first)
        Task {
            do {
                var body: [String: Any] = ["udid": udid, "share": share]
                if let team { body["team"] = team }
                let job = try await c.sendJob("POST", "/v1/ios/wda-setup", json: body)
                let end = try await c.follow(job) { j in
                    guard case .running = self.controlRuns[d.id], let l = j.lastLine else { return }
                    self.controlRuns[d.id] = .running(Self.plainLine(l), firstTime: first)
                }
                await refresh()
                if end.isDone {
                    // What the service did, not what was asked: the address only when it says it shared.
                    func yes(_ k: String) -> Bool { if case .bool(true) = end.result?[k] { return true }; return false }
                    controlRuns[d.id] = .done(shared: yes("shared"), sharedUrl: yes("shared") ? end.result?["sharedUrl"]?.stringValue : nil)
                    return
                }
                let cause = end.apiError?.specificCode
                if team == nil, cause == "team_required" || cause == "team_unknown" {
                    chooseControlTeam(d, share: share)   // the remembered team left Xcode, or there never was one
                    return
                }
                controlRuns[d.id] = .failed(Self.controlProblem(end.apiError, job: end, title: "Couldn’t set up control"),
                                            retry: cause == "wda_running" ? .stop : again)
            } catch is CancellationError {
                controlRuns[d.id] = nil
            } catch let e as APIError where e.status != 410 {   // refused before it started (410: the job was lost)
                controlRuns[d.id] = .failed(Self.controlProblem(e, title: "Couldn’t set up control"), retry: e.specificCode == "wda_running" ? .stop : again)
            } catch {
                controlRuns[d.id] = .failed(FriendlyError.from(error, title: "Couldn’t set up control"), retry: again)
            }
        }
    }

    /// Stop Control: ends every WebDriverAgent on the phone, also one started elsewhere. No confirmation: Set Up Control
    /// starts it again in seconds.
    func stopControl(_ d: Device) {
        if controlBusy(d) { return }
        guard let c = client, let udid = d.nativeId else { controlRuns[d.id] = .failed(Self.controlOffline, retry: .stop); return }
        controlRuns[d.id] = .stopping
        Task {
            do {
                // Over Wi-Fi, devicectl may take up to a minute to end WebDriverAgent and confirm it's gone.
                let data = try await c.send("POST", "/v1/ios/wda-stop", json: ["udid": udid], timeout: 120)
                await refresh()
                if (try? JSONDecoder().decode(WdaStopResponse.self, from: data))?.confirmed == false {
                    controlRuns[d.id] = .failed(Self.stopUnconfirmed, retry: .stop)
                } else {
                    controlRuns[d.id] = .stopped
                }
            } catch let e as APIError {
                controlRuns[d.id] = .failed(Self.controlProblem(e, title: "Couldn’t stop control"), retry: .stop)
            } catch {
                controlRuns[d.id] = .failed(FriendlyError.from(error, title: "Couldn’t stop control"), retry: .stop)
            }
        }
    }

    func retryControl(_ d: Device, _ retry: ControlRetry) {
        controlRuns[d.id] = nil
        switch retry {
        case .setUp(let team?, let share): runControlSetup(d, team: team, share: share)
        case .setUp(nil, let share): setUpControl(d, share: share)
        case .stop: stopControl(d)
        }
    }

    func dismissControlRun(_ d: Device) { controlRuns[d.id] = nil }

    /// A finished run is about the WebDriverAgent it set up or stopped. Once the phone turns the other way (a restart,
    /// a setup from the CLI) it's dropped, so an old "shared at …" address never returns with a later WebDriverAgent.
    /// Only a turn counts: a list read just before the job's end may still say the old thing.
    func settleControlRuns(_ next: [Device]) {
        guard !controlRuns.isEmpty else { return }
        for d in next where devices.first(where: { $0.id == d.id })?.wdaReady == !d.wdaReady {
            if case .done? = controlRuns[d.id], !d.wdaReady { controlRuns[d.id] = nil }
            if case .stopped? = controlRuns[d.id], d.wdaReady { controlRuns[d.id] = nil }
        }
    }

    static let controlOffline = FriendlyError(title: "PhoneDock isn’t connected", message: "It reconnects automatically. Try again in a moment.")

    static let stopUnconfirmed = FriendlyError(title: "Couldn’t confirm control stopped",
        message: "PhoneDock asked the iPhone to end WebDriverAgent but couldn’t confirm it did. Keep the iPhone connected and unlocked, then press Stop Control again.")

    static let signInToXcode = FriendlyError(title: "Sign in to Xcode to set up this iPhone",
        message: "Open Xcode › Settings › Accounts and add your Apple ID (a free one works), then try again.",
        details: "Or use an App Store Connect API key: phonedock ios wda-setup --udid <udid> --team <TEAMID> --api-key-path <AuthKey.p8> --api-key-id <KEY ID> --api-key-issuer <ISSUER ID>")

    /// The service words setup failures for people: its message is the title ("Unlock the iPhone") and its first plain
    /// hint the next step. Two hints name a command, which stays under Details, so they get the app's words instead.
    static func controlProblem(_ e: APIError?, job: Job? = nil, title: String) -> FriendlyError {
        guard let e else { return job.map { FriendlyError.from(job: $0, title: title) } ?? FriendlyError(title: title, message: FriendlyError.generic) }
        let m = e.message.trimmingCharacters(in: .whitespacesAndNewlines)
        var p = FriendlyError(title: !m.isEmpty && m.count <= 100 && FriendlyError.isHumanHint(m) ? m : title,
                              message: e.hints.first(where: FriendlyError.isHumanHint) ?? FriendlyError.generic,
                              details: e.rawDetails + (job?.lastLine.map { "\nLast step: " + $0 } ?? ""))
        if e.specificCode == "wda_running" {
            p.message = "PhoneDock leaves a running WebDriverAgent alone. Stop Control ends it; then Set Up Control starts PhoneDock’s."
        } else if e.specificCode == "signing_expired" {
            p.message = "Press Try Again and PhoneDock signs it again. A personal team’s signing lasts 7 days."
        }
        return p
    }

    /// "21:04:05 Building WebDriverAgent…" → "Building WebDriverAgent…"
    static func plainLine(_ line: String) -> String {
        line.replacingOccurrences(of: #"^\d\d:\d\d:\d\d "#, with: "", options: .regularExpression)
    }
}

// MARK: - Inspector (Info tab)

/// Set Up Control, Stop Control and what the phone says for one older iPhone.
struct OlderIphoneControlPanel: View {
    @Environment(AppModel.self) private var model
    let device: Device
    /// Per setup, never saved: it starts off each time, and turning sharing off is Stop Control, then Set Up Control.
    @State private var share = false
    @State private var team: String?

    /// The run to show. A result shows only while the phone agrees with it: "Control is on" while WebDriverAgent
    /// answers, "Control stopped" while it doesn't.
    private var run: ControlRun? {
        switch model.controlRun(device) {
        case .done? where !device.wdaReady: return nil
        case .stopped? where device.wdaReady: return nil
        case let r: return r
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.m) {
            switch run {
            case .checking:
                working("Checking Xcode’s accounts…")
            case .running(let line, let first):
                working(line, note: first ? "The first time builds for a few minutes. Keep the iPhone unlocked." : "Keep the iPhone unlocked.")
            case .stopping:
                working("Stopping control…", note: "Over Wi-Fi this can take up to a minute.")
            case .chooseTeam(let teams, let share):
                teamPicker(teams, share: share)
            case .failed(let p, let retry):
                ProblemView(problem: p, retryTitle: retry == .stop ? "Stop Control" : "Try Again", retry: { model.retryControl(device, retry) },
                            otherTitle: "Dismiss", other: { model.dismissControlRun(device) })
                    .environment(\.pdProblemFullWidth, true)
                    .testAnchor("control-problem")
            case .done(let shared, let url):
                // The setup's answer, or the phone's if it says shared (the warning errs towards showing).
                on(shared: shared || device.wdaSharing == "shared", sharedUrl: url ?? device.wdaSharedUrl,
                   unchecked: !shared && device.wdaSharing == "unknown")
            case .stopped:
                ConnectStatusView(status: .ok("Control stopped")).testAnchor("control-stopped")
                off
            case nil:
                if device.wdaReady {
                    on(shared: device.wdaSharing == "shared", sharedUrl: device.wdaSharedUrl, unchecked: device.wdaSharing == "unknown")
                } else { status; off }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Control is off: why, in a line.
    @ViewBuilder private var status: some View {
        if device.wdaTeam != nil {
            statusLine("Control is off", dot: .stopped, note: "It doesn’t come back by itself after the iPhone or PhoneDock restarts.")
        } else {
            Text("Taps, typing and the UI tree need WebDriverAgent on the iPhone. PhoneDock builds it with your Apple ID in Xcode and starts it when you set up control.")
                .font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func on(shared: Bool, sharedUrl: String?, unchecked: Bool) -> some View {
        VStack(alignment: .leading, spacing: Theme.Space.m) {
            statusLine("Control is on", dot: .running, note: "Taps, typing and the UI tree work through WebDriverAgent.")
            if shared {
                VStack(alignment: .leading, spacing: Theme.Space.xs) {
                    if let sharedUrl {
                        note("Other Macs on this Wi-Fi connect with:")
                        // The address on its own line: it's the part people check, and it never shares a line with the flag.
                        CommandWell(command: "phonedock connect --ios " + sharedUrl, anchor: "Copy connect command",
                                    display: "phonedock connect --ios\n" + sharedUrl)
                    }
                    note("Anyone on this Wi-Fi can control the iPhone, without a password, until you press Stop Control or restart the iPhone. To stop sharing, press Stop Control, then Set Up Control.")
                }
            } else if unchecked {
                // Never "private": a probe that can't tell (Local Network permission, no answer) says so.
                note("PhoneDock couldn’t check whether other Macs on this Wi-Fi can control the iPhone. Allow PhoneDock under System Settings › Privacy & Security › Local Network. Stop Control ends any sharing.")
                    .testAnchor("control-sharing-unknown")
            }
            Button("Stop Control") { model.stopControl(device) }
                .buttonStyle(.borderedProminent)
                .help("End WebDriverAgent on \(device.name)")
                .testAnchor("Stop Control")
        }
    }

    /// Set Up Control (with the sharing choice) and Stop Control, which ends a WebDriverAgent from somewhere else too.
    private var off: some View {
        VStack(alignment: .leading, spacing: Theme.Space.m) {
            VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                Toggle("Let other Macs on this Wi-Fi control this iPhone", isOn: $share)
                    .toggleStyle(.checkbox)
                    .font(Theme.Fonts.callout)
                    .testAnchor("Share control")
                note("Anyone on this Wi-Fi can then control the iPhone, without a password, until you press Stop Control or restart the iPhone.")
                    .padding(.leading, 20)   // under the checkbox's label
            }
            HStack(spacing: Theme.Space.m) {
                Button("Set Up Control") {
                    model.setUpControl(device, share: share)
                    share = false   // the run carries the choice; the next setup starts private again
                }
                .buttonStyle(.borderedProminent)
                .disabled(!device.isRunning)
                .help(device.wdaTeam != nil ? "Start WebDriverAgent on \(device.name) (about 8 seconds)" : "Build and start WebDriverAgent on \(device.name)")
                .testAnchor("Set Up Control")
                // Never gated on the phone's state: a WebDriverAgent from elsewhere may run whatever devicectl says.
                Button("Stop Control") { model.stopControl(device) }
                    .help("End any WebDriverAgent on \(device.name), also one started elsewhere")
                    .testAnchor("Stop Control")
            }
            note(!device.isRunning ? "Connect and unlock the iPhone first."
                 : device.wdaTeam != nil ? "Set Up Control takes about 8 seconds."
                 : "Needs Developer Mode on the iPhone. The first time builds for a few minutes.")
        }
    }

    private func teamPicker(_ teams: [WdaTeam], share: Bool) -> some View {
        VStack(alignment: .leading, spacing: Theme.Space.m) {
            Text("Xcode is signed in to \(teams.count) teams. Which one signs WebDriverAgent?")
                .font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.primary)
                .fixedSize(horizontal: false, vertical: true)
            Picker("Team", selection: Binding(get: { team ?? teams[0].id }, set: { team = $0 })) {
                ForEach(teams) { t in Text(t.label).tag(t.id) }
            }
            .labelsHidden()
            .accessibilityLabel("Signing team")
            .testAnchor("Signing team")
            HStack(spacing: Theme.Space.m) {
                Spacer(minLength: 0)
                Button("Cancel") { model.dismissControlRun(device) }
                Button("Set Up") { model.runControlSetup(device, team: team ?? teams[0].id, share: share) }
                    .buttonStyle(.borderedProminent)
                    .testAnchor("Set Up With Team")
            }
        }
    }

    private func working(_ line: String, note text: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: Theme.Space.xxs) {
            HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s) {
                ProgressView().controlSize(.small)
                Text(line).font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.primary)
                    .lineLimit(2).fixedSize(horizontal: false, vertical: true)
            }
            if let text { note(text).padding(.leading, 22) }
        }
    }

    private func statusLine(_ text: String, dot: PDStatus, note text2: String) -> some View {
        VStack(alignment: .leading, spacing: Theme.Space.xxs) {
            HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s) {
                StatusDot(status: dot)
                Text(text).font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.primary)
            }
            note(text2).padding(.leading, 14)   // under the text, past the dot
        }
    }

    private func note(_ s: String) -> some View {
        Text(s).font(Theme.Fonts.meta).foregroundStyle(Theme.Ink.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}
