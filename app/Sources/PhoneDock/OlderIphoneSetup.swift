import SwiftUI

// MARK: - Older iPhones: Set Up Control
//
// iPhones on iOS 26 and earlier take taps, typing and the UI tree through WebDriverAgent, a test runner on the phone.
// One button asks the service to build PhoneDock's pinned copy with the team Xcode is signed in to, start it, and keep
// it running after reboots and restarts (POST /v1/ios/wda-setup; docs/API.md "Older iPhones"). Stop Control ends it
// and keeps the phone listed (POST /v1/ios/wda-stop); a sharing switch lets other Macs on the Wi-Fi reach it. This file
// holds that flow and the places it shows: the inspector's Info tab, the stage, and Connect a Physical Device (the
// sidebar's context menu is in PhoneDockApp.swift).

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
    /// Other Macs on this Wi-Fi may reach WebDriverAgent (`wda-setup { share }`). Missing (an older service) means off.
    var shared: Bool
    /// What another Mac passes to `phonedock connect --ios`, e.g. `http://Old-iPhone.local:8100`.
    var sharedUrl: String?

    init?(_ v: JSONValue?) {
        guard let v, let state = v["state"]?.stringValue, let message = v["message"]?.stringValue else { return nil }
        self.state = state
        self.message = message
        self.hint = v["hint"]?.stringValue
        if case .bool(true) = v["shared"] { shared = true } else { shared = false }
        sharedUrl = v["sharedUrl"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
    }

    var isRunning: Bool { state == "running" }
    var isFailed: Bool { state == "failed" }
    /// The service is waiting on the person (unlock, plug in, trust) or the network: not a failure.
    var isWaiting: Bool { state.hasPrefix("waiting") || state == "unreachable" }
    /// Waiting on the person (unlock, plug in, trust); `unreachable` is the network, which no one presses Retry for.
    var waitsOnPerson: Bool { state.hasPrefix("waiting_") }

    /// The command another Mac runs to use this phone: the host of `sharedUrl`, with the port only when it isn't
    /// WebDriverAgent's usual 8100.
    var connectCommand: String? { connectTarget.map { "phonedock connect --ios " + $0 } }

    /// `connectCommand`'s address: the host (shell-quoted only if it needs it), plus a port other than 8100.
    var connectTarget: String? {
        guard shared, let s = sharedUrl else { return nil }
        var target = s
        if let u = URL(string: s), let host = u.host, !host.isEmpty {
            target = host.contains(":") ? "[\(host)]" : host
            if let port = u.port, port != 8100 { target += ":\(port)" }
        }
        let plain = target.allSatisfy { $0.isLetter || $0.isNumber || "-._:[]/".contains($0) }
        return plain ? target : "'" + target.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
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

    /// The person stopped control (Stop Control) and hasn't set it up again. The service remembers the team, so Set Up
    /// Control starts it again without asking for one.
    var wdaStopped: Bool { if case .object = meta?["wdaStopped"] { return true }; return false }
    /// A paired phone with WebDriverAgent PhoneDock doesn't manage here (an earlier setup, or connected by address): it
    /// may still answer on the Wi-Fi. The service's plain note, with Stop Control next to it.
    var wdaNotice: String? { meta?["wdaNotice"]?.stringValue }

    /// Whether to offer Set Up Control: nothing answers yet and PhoneDock isn't already looking after it (or gave up).
    var offersControlSetup: Bool {
        isOlderPairedIphone && !wdaAnswers && (wdaControl == nil || wdaControl?.isFailed == true)
    }
}

/// One run of Set Up Control (or Stop Control, or a sharing change), per device (`AppModel.controlSetups`).
enum ControlSetup: Equatable {
    case checking
    case chooseTeam([WdaTeam])
    /// A setup job's latest line. `firstTime`: nothing was built for this phone yet, so it takes minutes. `share`:
    /// the run turns LAN sharing on or off (the stage says so rather than "Setting up control").
    case running(String, firstTime: Bool = false, share: Bool? = nil)
    /// Finished: "Control is set up", "Sharing is on"… Clears itself after a few seconds.
    case done(String)
    case stopping
    /// Stop Control finished. Clears itself after a few seconds; the idle panel then says control is stopped.
    case stopped
    case failed(FriendlyError, retry: ControlRetry = .setUp)

    /// Something is in flight: no second setup or stop until it ends.
    var isBusy: Bool {
        switch self {
        case .checking, .running, .stopping: return true
        default: return false
        }
    }
}

/// What Try Again does after a failure.
enum ControlRetry: Equatable {
    /// Set Up Control from the start: Xcode's teams (a stopped phone reuses its own team).
    case setUp
    /// The same request again: the phone needed something done (unlock it, trust the developer), not another team.
    case same(team: String?, share: Bool?)
    case stop
}

extension AppModel {
    /// The setup run to show for a device.
    func controlFlow(for device: Device) -> ControlSetup? { controlSetups[device.id] }

    func controlBusy(_ device: Device) -> Bool { controlSetups[device.id]?.isBusy ?? false }

    /// Setup failures the service may keep working on, if it then reports a `waiting_*` state for the phone. A
    /// preflight rejection before the phone was managed leaves nobody retrying.
    static let carriesOnCodes: Set<String> = ["device_locked", "wda_untrusted", "no_device"]
    /// Failures fixed on the phone (or its cable), where Try Again repeats the same request rather than asking for a team.
    static let phoneSideCodes: Set<String> = carriesOnCodes.union(["not_found", "not_paired", "developer_mode_off"])
    /// A setup without a team that the service couldn't match to one (the remembered team left Xcode): ask.
    static let needsTeamCodes: Set<String> = ["team_required", "team_unknown"]

    /// Set Up Control. A phone the person stopped starts again with the team the service remembers (no picker, no
    /// rebuild); otherwise read Xcode's teams: one goes straight on, several ask, none says how to sign in.
    func beginControlSetup(_ device: Device) {
        guard client != nil else { toast = Toast(title: "PhoneDock isn’t connected", message: "It reconnects automatically."); return }
        if controlBusy(device) { return }
        if device.wdaStopped { startControlSetup(device, team: nil); return }
        chooseTeamThenSetUp(device)
    }

    private func chooseTeamThenSetUp(_ device: Device) {
        guard let c = client else { return }
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

    /// Runs `POST /v1/ios/wda-setup`. No `team`: the service reuses the phone's current or last one. `share` turns
    /// LAN sharing on or off; nil keeps the phone's setting.
    func startControlSetup(_ device: Device, team: String?, share: Bool? = nil) {
        guard let c = client, let udid = device.nativeId else {
            controlSetups[device.id] = .failed(FriendlyError(title: "PhoneDock isn’t connected", message: "It reconnects automatically. Try again in a moment."),
                                               retry: .same(team: team, share: share))
            return
        }
        if case .running = controlSetups[device.id] { return }
        if case .stopping = controlSetups[device.id] { return }
        let first = share == nil && device.wdaControl == nil && !device.wdaStopped
        let opening = share == true ? "Turning on sharing…" : share == false ? "Turning off sharing…" : "Checking Xcode and the iPhone…"
        controlSetups[device.id] = .running(opening, firstTime: first, share: share)
        Task {
            do {
                var body: [String: Any] = ["udid": udid]
                if let team { body["team"] = team }
                if let share { body["share"] = share }
                let job = try await c.sendJob("POST", "/v1/ios/wda-setup", json: body)
                let end = try await c.follow(job) { [weak self] j in
                    guard let self, case .running = self.controlSetups[device.id], let l = j.lastLine else { return }
                    self.controlSetups[device.id] = .running(Self.plainProgress(l), firstTime: first, share: share)
                }
                await refresh()
                let live = devices.first { $0.id == device.id }?.wdaControl
                if end.isDone, let share, live?.shared != share {
                    // Say what the service did, not what was asked: an older service ignores `share`.
                    controlSetups[device.id] = .failed(FriendlyError(title: share ? "Sharing didn’t turn on" : "Sharing didn’t turn off",
                        message: "Control is set up, but PhoneDock’s service didn’t change sharing. Try again, or update PhoneDock if it keeps happening."),
                        retry: .same(team: nil, share: share))
                    return
                }
                if end.isDone {
                    let said = share == true ? "Sharing is on" : share == false ? "Sharing is off" : "Control is set up"
                    controlSetups[device.id] = .done(said)
                    try? await Task.sleep(for: .seconds(4))
                    if controlSetups[device.id] == .done(said) { controlSetups[device.id] = nil }
                    return
                }
                let code = end.apiError?.specificCode ?? ""
                if team == nil, share == nil, Self.needsTeamCodes.contains(code) {
                    chooseTeamThenSetUp(device)
                    return
                }
                // Only the service's state after the failure says whether anyone carries on (#13). When it waits for the
                // phone, its live state says what to do (and keeps Stop Control in reach), so the failure isn't kept.
                if Self.carriesOnCodes.contains(code), live?.waitsOnPerson == true {
                    controlSetups[device.id] = nil
                } else {
                    let again: ControlRetry = share != nil || Self.phoneSideCodes.contains(code) ? .same(team: team, share: share) : .setUp
                    controlSetups[device.id] = .failed(Self.controlProblem(end), retry: again)
                }
            } catch is CancellationError {
                controlSetups[device.id] = nil
            } catch {
                controlSetups[device.id] = .failed(FriendlyError.from(error, title: share == nil ? "Couldn’t set up control" : "Couldn’t change sharing"),
                                                   retry: .same(team: team, share: share))
            }
        }
    }

    /// Lets other Macs on this Wi-Fi reach the phone's WebDriverAgent, or stops that: a setup with the same team.
    func setControlSharing(_ device: Device, _ on: Bool) { startControlSetup(device, team: nil, share: on) }

    /// Stop Control (`POST /v1/ios/wda-stop`): ends WebDriverAgent and its supervision. The phone stays paired and
    /// listed; screenshots, apps and installs still work. No confirmation: Set Up Control starts it again in seconds.
    func stopControl(_ device: Device) {
        guard let c = client, let udid = device.nativeId else {
            controlSetups[device.id] = .failed(FriendlyError(title: "PhoneDock isn’t connected", message: "It reconnects automatically. Try again in a moment."), retry: .stop)
            return
        }
        if controlBusy(device) { return }
        controlSetups[device.id] = .stopping
        Task {
            do {
                let data = try await c.send("POST", "/v1/ios/wda-stop", json: ["udid": udid], timeout: 60)
                await refresh()
                // Stopped on this Mac either way; say so when the runner on the iPhone couldn't be confirmed gone.
                let r = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                if r?["ownedElsewhere"] as? Bool == true {
                    controlSetups[device.id] = .failed(FriendlyError(title: "Another PhoneDock runs control for this iPhone",
                        message: "Stop it in that PhoneDock; this one left it running."), retry: .stop)
                    return
                }
                if r?["confirmed"] as? Bool == false {
                    controlSetups[device.id] = .failed(FriendlyError(title: "Control stopped on this Mac",
                        message: "PhoneDock couldn’t confirm it also stopped on the iPhone. Keep the iPhone connected and press Try Again."), retry: .stop)
                    return
                }
                controlSetups[device.id] = .stopped
                try? await Task.sleep(for: .seconds(4))
                if controlSetups[device.id] == .stopped { controlSetups[device.id] = nil }
            } catch {
                controlSetups[device.id] = .failed(FriendlyError.from(error, title: "Couldn’t stop control"), retry: .stop)
            }
        }
    }

    func retryControl(_ device: Device, _ retry: ControlRetry) {
        controlSetups[device.id] = nil
        switch retry {
        case .setUp: beginControlSetup(device)
        case .same(let team, let share): startControlSetup(device, team: team, share: share)
        case .stop: stopControl(device)
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

    /// Trust the developer, in the words of the iPhone's Settings. Trust is never retried on a timer: the person says
    /// when it's done.
    static let trustSteps = "On the iPhone open Settings › General › VPN & Device Management, tap your Apple ID and tap Trust."

    /// A failed setup job in words: titles for the codes a person fixes on the phone or the Mac, the service's own
    /// sentence and hint otherwise. Shown only when nothing retries by itself, so the text says to press Try Again.
    static func controlProblem(_ job: Job) -> FriendlyError {
        var p = FriendlyError.from(job: job, title: "Couldn’t set up control")
        guard let e = job.apiError else { return p }
        switch e.specificCode {
        case "xcode_account_missing": p = FriendlyError(title: signInProblem.title, message: signInProblem.message, details: p.details)
        case "developer_mode_off":
            p.title = "Turn on Developer Mode"
            p.message = "On the iPhone open Settings › Privacy & Security › Developer Mode. It restarts; then try again."
        case "device_locked":
            p.title = "Unlock the iPhone"
            p.message = "Unlock the iPhone, then press Try Again."
        case "not_found", "not_paired":
            p.title = "Trust this Mac on the iPhone"
            p.message = "Plug it in by USB, unlock it and tap Trust, then try again."
        case "wda_untrusted":
            p.title = "Trust the developer on the iPhone"
            p.message = trustSteps + " Then press Try Again."
        case "no_device":
            p.title = "Can’t reach the iPhone"
            p.message = "Plug it in by USB, or wake it on the same Wi-Fi as this Mac, then press Try Again."
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
            case .running(let line, let firstTime, _):
                working(line, note: firstTime ? "The first time takes a few minutes. Keep the iPhone unlocked." : "Keep the iPhone unlocked.")
            case .stopping:
                working("Stopping control…")
            case .chooseTeam(let teams):
                teamPicker(teams)
            case .done(let said):
                ConnectStatusView(status: .ok(said)).testAnchor("control-setup-done")
            case .stopped:
                ConnectStatusView(status: .ok("Control stopped")).testAnchor("control-stopped")
            case .failed(let p, let again):
                ProblemView(problem: p, retry: { model.retryControl(device, again) },
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
            VStack(alignment: .leading, spacing: Theme.Space.l) {
                controlStatus(c)
                if !compact {
                    sharing(c)
                    stopControl
                }
            }
        } else if let n = device.wdaNotice {
            VStack(alignment: .leading, spacing: Theme.Space.l) {
                if device.wdaAnswers { statusLine("Taps and typing work through WebDriverAgent", dot: .running) }
                note(n).testAnchor("control-notice")
                if !compact { stopControl }
            }
        } else if device.wdaAnswers {
            statusLine("Taps and typing work through WebDriverAgent", dot: .running)
        } else if device.wdaStopped {
            VStack(alignment: .leading, spacing: Theme.Space.xs) {
                statusLine("Control is stopped", dot: .stopped)
                if !compact {
                    note("Set Up Control starts it again with the same team.").padding(.leading, 14)
                }
            }
            .testAnchor("control-stopped-idle")
            setUpButton
        } else {
            if !compact {
                Text("Taps, typing and the UI tree need a one-time setup. PhoneDock builds a small helper with your Apple ID in Xcode, puts it on the iPhone, and keeps it running.")
                    .font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            setUpButton
            if !compact {
                note("Needs Developer Mode on the iPhone, and the iPhone trusted once over USB.")
            }
        }
    }

    private var setUpButton: some View {
        Button("Set Up Control") { model.beginControlSetup(device) }
            .controlSize(compact ? .small : .regular)
            .disabled(!device.isRunning)
            .help(!device.isRunning ? "Connect and unlock the iPhone first"
                  : device.wdaStopped ? "Start WebDriverAgent again on \(device.name), with the same team"
                  : "Build and start WebDriverAgent on \(device.name)")
            .testAnchor("Set Up Control")
    }

    /// What the service reports while it manages the phone.
    @ViewBuilder private func controlStatus(_ c: WdaControl) -> some View {
        if c.isFailed {
            // "Control failed", not "stopped": stopped is what Stop Control does.
            ProblemView(problem: FriendlyError(title: "Control failed", message: [c.message, c.hint].compactMap { $0 }.map(sentence).joined(separator: " ")),
                        retryTitle: "Set Up Again", retry: { model.beginControlSetup(device) })
                .testAnchor("control-failed")
        } else {
            VStack(alignment: .leading, spacing: Theme.Space.xs) {
                statusLine(c.isRunning ? "Control is set up" : c.message,
                           dot: c.isRunning ? .running : .booting, working: !c.isRunning && !c.isWaiting)
                if c.state == "waiting_trust" {
                    // The service waits for Retry (or the phone reconnecting) here, never a timer, so its own hint
                    // may still say otherwise: these are the steps.
                    Text(AppModel.trustSteps + " Then press Retry.")
                        .font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.leading, 14)
                    Button("Retry") { model.startControlSetup(device, team: nil) }
                        .controlSize(.small)
                        .disabled(!device.isRunning)
                        .help(device.isRunning ? "Start WebDriverAgent again with the same team" : "Connect and unlock the iPhone first")
                        .padding(.leading, 14)
                        .padding(.top, Theme.Space.xxs)
                        .testAnchor("Retry trust")
                } else if !c.isRunning, let h = c.hint {
                    Text(h).font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.leading, 14)
                }
                if c.isRunning && !compact {
                    note("PhoneDock keeps it running, also after the iPhone or this Mac restarts.").padding(.leading, 14)
                }
            }
            .testAnchor("control-status")
        }
    }

    /// LAN sharing: off by default; turning it on or off is a quick setup with the same team.
    private func sharing(_ c: WdaControl) -> some View {
        VStack(alignment: .leading, spacing: Theme.Space.xs) {
            HStack(alignment: .top, spacing: Theme.Space.m) {
                Text("Let other Macs on this Wi-Fi control this iPhone")
                    .font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.primary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Toggle("Let other Macs on this Wi-Fi control this iPhone",
                       isOn: Binding(get: { c.shared }, set: { model.setControlSharing(device, $0) }))
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .controlSize(.small)
                    .disabled(!device.isRunning || model.controlBusy(device))
                    .testAnchor("Share control")
            }
            note("Anyone on this Wi-Fi can then control the iPhone, without a password.")
            if c.shared {
                if let cmd = c.connectCommand, let target = c.connectTarget {
                    note("On the other Mac, run:").padding(.top, Theme.Space.xs)
                    // The host on its own line: never cut in the middle or broken at a hyphen, and it's the part
                    // people check.
                    CommandWell(command: cmd, anchor: "Copy connect command", display: "phonedock connect --ios\n" + target)
                } else {
                    note("The address for other Macs shows here once control is running.").padding(.top, Theme.Space.xs)
                }
            }
        }
        .testAnchor("control-sharing")
    }

    private var stopControl: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            Button("Stop Control") { model.stopControl(device) }
                .disabled(model.controlBusy(device))
                .help("Stop WebDriverAgent on \(device.name)")
                .testAnchor("Stop Control")
            note("Stops WebDriverAgent on the iPhone. The iPhone stays paired and listed; Set Up Control starts it again in seconds.")
        }
    }

    private func note(_ s: String) -> some View {
        Text(s).font(Theme.Fonts.meta).foregroundStyle(Theme.Ink.secondary)
            .fixedSize(horizontal: false, vertical: true)
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

/// Bottom-of-stage capsule for an older iPhone that can’t take taps yet: Set Up, the setup’s progress, what the
/// service is waiting for (with Stop Control), or that the person stopped it. A choice of team or an error opens the
/// inspector, where there’s room for it.
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
            case .running(_, _, let share?):
                ProgressView().controlSize(.mini).id(scheme)
                Text(share ? "Turning on sharing…" : "Turning off sharing…").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.primary)
            case .checking, .running:
                ProgressView().controlSize(.mini).id(scheme)
                Text("Setting up control…").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.primary)
            case .stopping:
                ProgressView().controlSize(.mini).id(scheme)
                Text("Stopping control…").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.primary)
            case .chooseTeam:
                Image(systemName: "person.2").foregroundStyle(Theme.Ink.secondary).accessibilityHidden(true)
                Text("Choose a team").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.primary)
                Text("·").foregroundStyle(Theme.Ink.secondary)
                Button("Show") { showInspector() }.buttonStyle(.pdLink).font(Theme.Fonts.callout)
            case .done(let said):
                doneLine(said)
            case .stopped:
                doneLine("Control stopped")
            case .failed(_, .stop):
                failedLine("Stop failed")
            case .failed:
                failedLine("Setup failed")
            case nil:
                if let c = device.wdaControl, !c.isRunning {
                    // The capsule is as narrow as the phone: Stop Control in words when it fits, else as a symbol.
                    ViewThatFits(in: .horizontal) {
                        managedLine(c, stopInWords: true)
                        managedLine(c, stopInWords: false)
                    }
                } else if device.wdaStopped {
                    // Not stop.circle: that's the Stop Control button's symbol.
                    Image(systemName: "hand.tap").foregroundStyle(Theme.Ink.secondary).accessibilityHidden(true)
                    Text("Control is stopped").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.primary)
                    Text("·").foregroundStyle(Theme.Ink.secondary)
                    Button("Set Up") { model.beginControlSetup(device); showInspector() }
                        .buttonStyle(.pdLink).font(Theme.Fonts.callout)
                        .help("Start WebDriverAgent again with the same team")
                        .testAnchor("Set Up Control (stage)")
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

    /// What the service is doing about a managed phone that isn't running yet, then Stop Control.
    private func managedLine(_ c: WdaControl, stopInWords: Bool) -> some View {
        HStack(spacing: Theme.Space.xs) {
            if c.isFailed {
                failedLine("Control failed")
            } else {
                if !c.isWaiting {
                    ProgressView().controlSize(.mini).id(scheme)
                } else if stopInWords {   // narrow: the label needs the room more than the symbol does
                    Image(systemName: c.state == "waiting_unlock" ? "lock.fill" : c.state == "unreachable" ? "wifi.exclamationmark" : "hourglass")
                        .foregroundStyle(Theme.Ink.secondary).accessibilityHidden(true)
                }
                // A short label; the full sentence is in the inspector.
                Text(Self.shortLabel(c)).font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.primary)
                if c.state != "waiting_unlock" {
                    Text("·").foregroundStyle(Theme.Ink.secondary)
                    Button("Details") { showInspector() }.buttonStyle(.pdLink).font(Theme.Fonts.callout)
                }
            }
            Text("·").foregroundStyle(Theme.Ink.secondary)
            if stopInWords {
                Button("Stop Control") { model.stopControl(device) }
                    .buttonStyle(.pdLink).font(Theme.Fonts.callout)
                    .help("Stop WebDriverAgent on \(device.name). The iPhone stays paired and listed.")
                    .testAnchor("Stop Control (stage)")
            } else {
                Button { model.stopControl(device) } label: {
                    Image(systemName: "stop.circle").font(Theme.Fonts.callout)
                }
                .buttonStyle(.pdLink)
                .help("Stop Control: stops WebDriverAgent on \(device.name). The iPhone stays paired and listed.")
                .accessibilityLabel("Stop Control")
                .testAnchor("Stop Control (stage)")
            }
        }
    }

    @ViewBuilder private func doneLine(_ said: String) -> some View {
        Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.Status.running).accessibilityHidden(true)
        Text(said).font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.primary)
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
