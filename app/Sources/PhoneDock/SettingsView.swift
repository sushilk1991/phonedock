import SwiftUI
import AppKit
import ServiceManagement

// Settings (⌘,): General, Agents and Advanced, as native toolbar tabs. Each tab is a column of sections in the main
// window's own language: headline section titles, opaque cards with hairline-separated rows (the Connect an Agent
// sheet's agent list), status as a coloured glyph plus a word, raw detail one click away. DESIGN.md › Settings.

// MARK: - Window

struct SettingsView: View {
    @AppStorage(Prefs.settingsTab) private var tab = "general"

    var body: some View {
        TabView(selection: $tab) {
            GeneralSettings()
                .tabItem { Label("General", systemImage: "gearshape") }
                .tag("general")
            AgentSettings()
                .tabItem { Label("Agents", systemImage: "sparkles") }
                .tag("agents")
            AdvancedSettings()
                .tabItem { Label("Advanced", systemImage: "gearshape.2") }
                .tag("advanced")
        }
        .frame(width: SettingsMetrics.width)
    }
}

enum SettingsMetrics {
    static let width: CGFloat = 560
    /// The tallest a tab gets before its column scrolls: room for the toolbar and the Dock on a 13-inch screen.
    @MainActor static var maxHeight: CGFloat { min(760, (NSScreen.main?.visibleFrame.height ?? 900) - 140) }
}

// MARK: - Building blocks

/// One tab: its sections in a column. The window takes the column's height, so each tab fits its content; past
/// `maxHeight` (an open "How to Set Up", a check result) the column scrolls and a fade marks the bottom edge.
struct SettingsPane<Content: View>: View {
    @ViewBuilder var content: Content
    @State private var height: CGFloat?
    @State private var moreBelow = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Space.xxl) { content }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Theme.Space.xxl)
                .padding(.top, Theme.Space.windowTop)
                .padding(.bottom, Theme.Space.xxl)
                .background(ScrollerFlash())
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(height: min(height ?? 420, SettingsMetrics.maxHeight))
        // The main window's content surface: cards read the same here as on the stage, in light and dark.
        .background(Theme.Surface.stage, ignoresSafeAreaEdges: [])
        .onScrollGeometryChange(for: Bool.self) { g in
            g.visibleRect.maxY < g.contentSize.height - 8
        } action: { _, more in moreBelow = more }
        .overlay(alignment: .bottom) {
            if moreBelow {
                LinearGradient(colors: [Theme.Surface.stage.opacity(0), Theme.Surface.stage], startPoint: .top, endPoint: .bottom)
                    .frame(height: 40)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
    }
}

/// A titled group: headline title (with an optional trailing accessory), its card, and an optional note under it.
/// Title and note line up with the text inside the card's rows.
struct SettingsSection<Content: View, Accessory: View>: View {
    let title: String
    var note: String? = nil
    @ViewBuilder var accessory: Accessory
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.m) {
            HStack(alignment: .firstTextBaseline, spacing: Theme.Space.m) {
                Text(title)
                    .font(Theme.Fonts.headline)
                    .foregroundStyle(Theme.Ink.primary)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: Theme.Space.m)
                accessory
            }
            .padding(.horizontal, Theme.Space.l)
            content
            if let note { SettingsNote(note).padding(.horizontal, Theme.Space.l) }
        }
    }
}

extension SettingsSection where Accessory == EmptyView {
    init(_ title: String, note: String? = nil, @ViewBuilder content: () -> Content) {
        self.init(title: title, note: note, accessory: { EmptyView() }, content: content)
    }
}

/// The card a section's rows sit in: `Surface.card`, a `Line.card` hairline, radius 10, and a separator between
/// rows (inset like the agent list in Connect an Agent).
struct SettingsCard<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Group(subviews: content) { rows in
                ForEach(Array(rows.enumerated()), id: \.element.id) { i, row in
                    if i > 0 { Divider().padding(.leading, Theme.Space.l) }
                    row
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .pdCard(padding: 0)
    }
}

/// A row: what it is (and a sentence about it) on the leading side, its control on the trailing side, centred.
struct SettingsRow<Leading: View, Trailing: View>: View {
    @ViewBuilder var leading: Leading
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(alignment: .center, spacing: Theme.Space.l) {
            leading.frame(maxWidth: .infinity, alignment: .leading)
            trailing.fixedSize()
        }
        .padding(.horizontal, Theme.Space.l)
        .padding(.vertical, Theme.Space.m)
        .frame(minHeight: 40)
    }
}

extension SettingsRow where Leading == SettingsRowText {
    init(_ title: String, detail: String? = nil, @ViewBuilder trailing: () -> Trailing) {
        self.init(leading: { SettingsRowText(title: title, detail: detail) }, trailing: trailing)
    }
}

struct SettingsRowText: View {
    let title: String
    var detail: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.xxs) {
            Text(title).font(Theme.Fonts.body).foregroundStyle(Theme.Ink.primary)
            if let detail {
                Text(detail)
                    .font(Theme.Fonts.callout)
                    .foregroundStyle(Theme.Ink.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// What a status headline says about its subject. Each has its own glyph, so colour is never the only signal.
enum SettingsHealth {
    case ready, working, problem, missing
    /// Something new to install (General › Updates): the sidebar update item's glyph.
    case available

    var word: String {
        switch self {
        case .ready: return "Ready"
        case .working: return "Working"
        case .problem: return "Needs attention"
        case .missing: return "Not set up"
        case .available: return "Update available"
        }
    }
}

/// The headline of a status card: a large glyph, the state in words, and a quieter line of detail.
struct SettingsStatusHeadline: View {
    let health: SettingsHealth
    let title: String
    var detail: String? = nil

    var body: some View {
        HStack(alignment: .center, spacing: Theme.Space.m) {
            glyph
                .font(Theme.Fonts.display)
                .frame(width: 22, height: 22)
                .accessibilityLabel(health.word)
            VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                Text(title).font(Theme.Fonts.headline).foregroundStyle(Theme.Ink.primary)
                if let detail {
                    Text(detail)
                        .font(Theme.Fonts.meta)
                        .foregroundStyle(Theme.Ink.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.vertical, Theme.Space.xxs)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var glyph: some View {
        switch health {
        case .ready: Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.Status.running)
        case .working: ProgressView().controlSize(.small)
        case .problem: Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.Status.error)
        case .missing: Image(systemName: "circle.dashed").foregroundStyle(Theme.Ink.secondary)
        case .available:
            Image(systemName: "arrow.down.circle.fill")
                .symbolRenderingMode(.palette)
                .foregroundStyle(Theme.Ink.onFill, Theme.Accent.fill)
        }
    }
}

/// A row's state at its trailing edge: an optional coloured glyph and a word in secondary ink ("✓ Ready").
struct SettingsStateLabel: View {
    let text: String
    var symbol: String? = nil
    var tint: Color = Theme.Ink.secondary

    var body: some View {
        HStack(spacing: Theme.Space.xs) {
            if let symbol { Image(systemName: symbol).foregroundStyle(tint).accessibilityHidden(true) }
            Text(text).foregroundStyle(Theme.Ink.secondary)
        }
        .font(Theme.Fonts.callout)
        .accessibilityElement(children: .combine)
    }
}

/// A note under a section: callout, secondary, leading-aligned.
struct SettingsNote: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(Theme.Fonts.callout)
            .foregroundStyle(Theme.Ink.secondary)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - General

private struct GeneralSettings: View {
    @AppStorage(Prefs.notifyOnHandoff) private var notify = true
    @State private var notificationsOff = false

    var body: some View {
        SettingsPane {
            SettingsSection("Notifications", note: "The Dock icon shows a badge while a request is waiting, even with notifications off.") {
                SettingsCard {
                    SettingsRow("Notify me when an agent needs help",
                                detail: "Answer right from the notification with Take Over, Done or Can’t Do It.") {
                        Toggle("Notify me when an agent needs help", isOn: $notify)
                            .labelsHidden()
                            .toggleStyle(.switch)
                    }
                    if notify && notificationsOff {
                        SettingsRow {
                            Label {
                                Text("Notifications for PhoneDock are off in System Settings.")
                                    .font(Theme.Fonts.callout)
                                    .foregroundStyle(Theme.Ink.primary)
                                    .fixedSize(horizontal: false, vertical: true)
                            } icon: {
                                Image(systemName: "bell.slash.fill").foregroundStyle(Theme.Status.handoff)
                            }
                        } trailing: {
                            Button("Open System Settings") { HandoffNotifier.openNotificationSettings() }
                                .controlSize(.small)
                        }
                    }
                }
            }
            SettingsSection("Startup") {
                SettingsCard { OpenAtLoginRow() }
            }
            UpdatesSettingsSection()   // UpdatesSettingsSection.swift
        }
        .onChange(of: notify) { _, on in
            // Turning it on is the moment the system prompt makes sense (never at launch).
            if on { HandoffNotifier.shared.requestPermissionIfNeeded() }
        }
        .task { notificationsOff = await HandoffNotifier.shared.isDenied() }
        // Back from System Settings › Notifications: show what's true now.
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { notificationsOff = await HandoffNotifier.shared.isDenied() }
        }
    }
}

/// General › Open at login, through the system's Login Items (SMAppService). Only a bundled app can register.
private struct OpenAtLoginRow: View {
    @State private var on = SMAppService.mainApp.status == .enabled
    @State private var problem: String?

    var body: some View {
        SettingsRow {
            VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                SettingsRowText(title: "Open at login", detail: "Help requests reach you without opening PhoneDock first.")
                if let problem {
                    Text(problem)
                        .font(Theme.Fonts.callout)
                        .foregroundStyle(Theme.Status.errorText)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        } trailing: {
            Toggle("Open at login", isOn: Binding(get: { on }, set: set))
                .labelsHidden()
                .toggleStyle(.switch)
                .disabled(!DaemonLocator.isBundled)
                .help(DaemonLocator.isBundled ? "" : "Available in the PhoneDock app bundle")
        }
    }

    private func set(_ want: Bool) {
        let app = SMAppService.mainApp
        do {
            if want { try app.register() } else { try app.unregister() }
            problem = nil
        } catch {
            problem = want ? "Couldn’t add PhoneDock to your login items." : "Couldn’t remove PhoneDock from your login items."
        }
        if app.status == .requiresApproval {
            problem = "Allow PhoneDock in System Settings › General › Login Items."
            SMAppService.openSystemSettingsLoginItems()
        }
        on = app.status == .enabled || app.status == .requiresApproval
    }
}

// MARK: - Agents

private struct AgentSettings: View {
    @Environment(AppModel.self) private var model
    @State private var setup = AgentSetupModel.shared
    @State private var showManual = false

    private static let order = ["claude", "codex", "cursor", "pi"]

    var body: some View {
        SettingsPane {
            SettingsSection("Coding agents", note: "When an agent is using a device, you’ll see it above the screen. You can take over at any time.") {
                SettingsCard {
                    SettingsRow("Add PhoneDock to your agents",
                                detail: "Set Up installs PhoneDock’s skill in each agent and checks that it answers.") {
                        Button("Set Up…") { openSetUp() }
                            .buttonStyle(.borderedProminent)
                            .testAnchor("Settings Set Up")
                    }
                    agentRows
                }
            }
            DisclosureRow(title: "Set Up by Hand", isExpanded: $showManual) {
                VStack(alignment: .leading, spacing: Theme.Space.l) {
                    command("Every agent at once, in Terminal", "\(AgentCommands.cli) setup")
                    command("Claude Code", AgentCommands.command(.claude))
                    command("Codex", AgentCommands.command(.codex))
                    command("Pi", AgentCommands.command(.pi))
                    command("Other MCP clients, over stdio", AgentCommands.command(.other),
                            note: "Cursor and other clients that take JSON: Connect an Agent › Other MCP Client.")
                    command("List devices from Terminal", AgentCommands.listDevices)
                }
                .padding(.top, Theme.Space.xs)
            }
            .padding(.horizontal, Theme.Space.l)
        }
        .task { if setup.detected == nil { await setup.detect() } }
    }

    /// Each agent and whether it can use PhoneDock, from setup's dry run (the same list the Set Up sheet shows).
    @ViewBuilder private var agentRows: some View {
        if let failure = setup.detectFailure, setup.detected == nil {
            SettingsRow {
                SettingsStateLabel(text: "Couldn’t look for agents on this Mac. Set Up shows what went wrong.",
                                   symbol: "exclamationmark.triangle.fill", tint: Theme.Status.error)
                    .help(failure.details)
            } trailing: { EmptyView() }
        } else if setup.detected == nil {
            SettingsRow {
                HStack(spacing: Theme.Space.s) {
                    ProgressView().controlSize(.small)
                    Text("Looking for agents on this Mac…").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                }
            } trailing: { EmptyView() }
        } else {
            ForEach(Self.order.compactMap { id in setup.clients.first { $0.id == id } }) { c in
                SettingsRow {
                    Text(c.name).font(Theme.Fonts.body).foregroundStyle(c.found ? Theme.Ink.primary : Theme.Ink.secondary)
                } trailing: {
                    state(c)
                }
            }
        }
    }

    @ViewBuilder private func state(_ c: SetupReport.Client) -> some View {
        if setup.running == c.id {
            HStack(spacing: Theme.Space.s) {
                ProgressView().controlSize(.small)
                Text("Setting up…").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
            }
        } else if !c.found {
            SettingsStateLabel(text: "Not found on this Mac")
        } else {
            switch c.registered {
            case "yes": SettingsStateLabel(text: "Connected", symbol: "checkmark.circle.fill", tint: Theme.Status.running)
            case "other": SettingsStateLabel(text: "Another copy is registered", symbol: "exclamationmark.triangle.fill", tint: Theme.Status.handoff)
            case "outdated": SettingsStateLabel(text: "Needs an update")
            default: SettingsStateLabel(text: "Not set up")
            }
        }
    }

    private func command(_ label: String, _ command: String, note: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: Theme.Space.xs) {
            Text(label).font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
            // One line, cut in the middle (the tooltip and Copy have all of it), so the tab stays compact.
            CommandWell(command: command, oneLine: true)
            if let note { SettingsNote(note) }
        }
    }

    private func openSetUp() {
        model.showAgentSetup = true
        if !SelfTest.blocksForeground("bring the main window forward for Set Up") {
            NSApp.activate()
            NSApp.windows.first { $0.isVisible && $0.canBecomeMain && $0.identifier?.rawValue.contains("Settings") != true }?.makeKeyAndOrderFront(nil)
        }
    }
}

// MARK: - Advanced

private struct AdvancedSettings: View {
    @Environment(AppModel.self) private var model
    @State private var host = ""
    @State private var checking = false
    @State private var check: NetworkCheck?
    @State private var diagnosticsCopied = false
    @State private var showBackends = false
    /// The last refresh of `/v1/backends` since the tab opened failed (a cached list may still be showing).
    @State private var backendsFailed = false

    struct NetworkCheck: Equatable {
        var ok: Bool
        var title: String
        var message: String?
        var details: String?
    }

    var body: some View {
        SettingsPane {
            SettingsSection("Background service") {
                SettingsCard {
                    SettingsRow {
                        SettingsStatusHeadline(health: service.health, title: service.title, detail: service.detail)
                    } trailing: {
                        Button(model.restartingDaemon ? "Restarting…" : "Restart Service…") { model.restartDaemonFromApp() }
                            .disabled(model.restartingDaemon)
                    }
                    SettingsRow("Data folder", detail: "Emulators, snapshots, recordings and logs.") {
                        Button("Show in Finder") {
                            try? FileManager.default.createDirectory(at: DaemonLocator.home, withIntermediateDirectories: true)
                            if !SelfTest.blocksForeground("Show data folder in Finder") { NSWorkspace.shared.activateFileViewerSelecting([DaemonLocator.home]) }
                        }
                        .help(DaemonLocator.home.path)
                    }
                    SettingsRow("Diagnostics", detail: "Versions and service details, to paste into a bug report.") {
                        Button(diagnosticsCopied ? "Copied" : "Copy Diagnostics") {
                            Clipboard.copy(diagnostics)
                            diagnosticsCopied = true
                        }
                        .help("Copies versions, the service address and device support for a bug report")
                        .testAnchor("Copy Diagnostics")
                    }
                }
            }
            SettingsSection("Device support") {
                SettingsCard {
                    SettingsRow {
                        SettingsStatusHeadline(health: support.health, title: support.title, detail: support.detail)
                    } trailing: {
                        if supportFailed {
                            Button("Try Again") { Task { await loadBackends() } }
                        } else if !model.backends.isEmpty, model.connection.isConnected {
                            Button(showBackends ? "Hide Details" : "Show Details") { Theme.Motion.expand { showBackends.toggle() } }
                                .buttonStyle(.pdLink)
                                .font(Theme.Fonts.callout)
                                .testAnchor("Device support details")
                        }
                    }
                    if showBackends, model.connection.isConnected, !supportFailed {
                        ForEach(model.backends) { b in BackendRow(backend: b) }
                    }
                }
            }
            SettingsSection("Wi-Fi phones") {
                LocalNetworkWarning()
                SettingsCard { networkCheck }
                if let check, !check.ok {
                    ProblemView(problem: FriendlyError(title: check.title, message: check.message, details: check.details))
                }
            }
            .environment(\.pdProblemFullWidth, true)
        }
        .task { await loadBackends() }
        .task(id: diagnosticsCopied) {
            guard diagnosticsCopied else { return }
            try? await Task.sleep(for: .seconds(1.5))
            diagnosticsCopied = false
        }
    }

    // MARK: Service

    private var service: (health: SettingsHealth, title: String, detail: String?) {
        switch model.connection {
        case .connected(let version):
            let parts = [version.map { "Version \($0)" }, startedBy.map { "Started by \($0)" }].compactMap { $0 }
            return (.ready, "Running", parts.isEmpty ? nil : parts.joined(separator: " · "))
        case .connecting:
            return (.working, "Starting…", nil)
        case .failed:
            return (.problem, "Not running", "Devices and agents are unavailable until it runs.")
        }
    }

    private var startedBy: String? {
        switch model.daemonOrigin {
        case .app: return "PhoneDock"
        case .other(let p): return p.map { ($0 as NSString).lastPathComponent } ?? "Terminal or another app"
        case .unknown: return nil
        }
    }

    // MARK: Device support

    private func loadBackends() async {
        backendsFailed = false
        backendsFailed = !(await model.loadBackends())
    }

    /// The service is up but didn't list its backends: say so, rather than show a list that may be out of date.
    private var supportFailed: Bool { model.connection.isConnected && backendsFailed }

    /// One line for every backend, in state words: all ready, ready apart from optional extras, or what isn't set
    /// up. Each backend's own row is under Show Details.
    private var support: (health: SettingsHealth, title: String, detail: String?) {
        guard model.connection.isConnected else {
            return (.missing, "Not available", "Shown once PhoneDock’s service is running.")
        }
        if supportFailed { return (.problem, "Couldn’t check device support", "The service didn’t answer.") }
        let all = model.backends
        guard !all.isEmpty else { return (.working, "Checking what this Mac can run…", nil) }
        let missing = all.filter { !$0.isAvailable }
        if missing.isEmpty { return (.ready, "Everything is ready", nil) }
        let verb = missing.count == 1 ? "isn’t" : "aren’t"
        let names = missing.count <= 2 ? ListFormatter.localizedString(byJoining: missing.map(\.plainName))
                                       : "\(missing.count) kinds of device"
        // Beta and experimental extras are optional: without them PhoneDock is still ready.
        if missing.allSatisfy({ $0.stageLabel != nil }) { return (.ready, "Ready", "Optional: \(names) \(verb) set up.") }
        return (.missing, "\(names) \(verb) set up", missing.count < all.count ? "Everything else is ready." : nil)
    }

    // MARK: Wi-Fi check

    private var networkCheck: some View {
        VStack(alignment: .leading, spacing: Theme.Space.m) {
            SettingsRowText(title: "Check a phone’s connection",
                            detail: "Enter a phone’s IP address to see whether macOS lets PhoneDock reach it, and what’s in the way if it can’t.")
            HStack(spacing: Theme.Space.m) {
                TextField("Phone’s IP address", text: $host, prompt: Text("IP address, such as 192.168.1.20"))
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(runCheck)
                    .onChange(of: host) { check = nil }
                    .testAnchor("Check host")
                Button(checking ? "Checking…" : "Check") { runCheck() }
                    .disabled(checking || host.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            if let check, check.ok {
                Label {
                    VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                        Text(check.title).foregroundStyle(Theme.Ink.primary)
                        // The check runs as the app would start the service; one started elsewhere stays blocked.
                        if model.wifiBlocked {
                            Text("The background service still can’t until you restart it.")
                                .foregroundStyle(Theme.Ink.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                } icon: {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.Status.running)
                }
                .font(Theme.Fonts.callout)
            }
        }
        .padding(Theme.Space.l)
    }

    private var diagnostics: String {
        var lines = ["PhoneDock " + (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev")]
        lines.append("Service: \(model.connection.label)")
        if let c = model.client { lines.append("Endpoint: \(c.base.absoluteString)") }
        lines.append("Port: \(DaemonLocator.port)")
        if let pid = model.daemonPid { lines.append("PID: \(pid)") }
        switch model.daemonOrigin {
        case .app(let p): lines.append("Started by: \(p)")
        case .other(let p): lines.append("Started by: \(p ?? "itself (no responsible app)")")
        case .unknown: lines.append("Started by: unknown")
        }
        lines.append("Data folder: \(DaemonLocator.home.path)")
        lines.append("CLI: \(DaemonLocator.cliPath)")
        lines.append("macOS: \(ProcessInfo.processInfo.operatingSystemVersionString)")
        for b in model.backends {
            lines.append("Backend \(b.id): " + (b.isAvailable ? "ready \(b.availability?.version ?? "")" : "unavailable \(b.availability?.reason ?? "")"))
        }
        return lines.joined(separator: "\n")
    }

    private func runCheck() {
        let h = host.trimmingCharacters(in: .whitespaces)
        guard !h.isEmpty, !checking else { return }
        checking = true
        check = nil
        Task {
            // Any TCP answer — even "refused" — proves macOS lets PhoneDock reach the phone.
            let r = await DaemonLocator.localNetworkCheck(host: h, port: 62078)
            checking = false
            // The address changed while it ran: this answer is about another phone.
            guard host.trimmingCharacters(in: .whitespaces) == h else { return }
            switch r.code {
            case "CONNECTED", "ECONNREFUSED":
                check = NetworkCheck(ok: true, title: "PhoneDock can reach \(h)")
            case "EHOSTUNREACH":
                check = NetworkCheck(ok: false, title: "Can’t reach \(h)",
                                     message: "Allow PhoneDock in System Settings › Privacy & Security › Local Network, and check the phone is on the same Wi-Fi.",
                                     details: r.message)
            case "ETIMEDOUT":
                check = NetworkCheck(ok: false, title: "No answer from \(h)",
                                     message: "Check the address and that the phone is on the same Wi-Fi.", details: r.message)
            default:
                check = NetworkCheck(ok: false, title: "Couldn’t check \(h)", message: "Try again.", details: "\(r.code): \(r.message)")
            }
        }
    }
}

/// Advanced › Device support › Show Details: one kind of device, as the sidebar draws it (platform glyph, name, Beta
/// badge), and whether this Mac is set up for it. "How to Set Up" holds the service's hints for one that isn't.
private struct BackendRow: View {
    let backend: BackendInfo
    @State private var expanded = false

    private var hints: [String] {
        ([backend.availability?.reason].compactMap { $0 } + (backend.availability?.hints ?? [])).filter { !$0.isEmpty }
    }

    private var symbol: String {
        if backend.kind == "cloud" { return "cloud" }
        switch backend.platform {
        case "ios": return "iphone"
        case "linux": return "terminal"
        default: return "smartphone"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.xs) {
            HStack(spacing: Theme.Space.m) {
                PlatformGlyph(platform: backend.platform, symbol: symbol)
                    .foregroundStyle(Theme.Ink.secondary)
                    .frame(width: 22)
                    .accessibilityHidden(true)
                Text(backend.plainName).font(Theme.Fonts.body).foregroundStyle(Theme.Ink.primary)
                // The service's `stage` field becomes the same Beta label the sidebar and Connect use.
                if let stage = backend.stageLabel { BetaBadge(label: stage) }
                Spacer(minLength: Theme.Space.m)
                if backend.isAvailable {
                    SettingsStateLabel(text: "Ready", symbol: "checkmark.circle.fill", tint: Theme.Status.running)
                        .help(backend.availability?.version ?? "")
                } else {
                    SettingsStateLabel(text: "Not set up", symbol: "circle.dashed")
                        .help(backend.availability?.reason ?? "")
                }
            }
            .frame(minHeight: 24)
            if !backend.isAvailable, !hints.isEmpty {
                DisclosureRow(title: "How to Set Up", isExpanded: $expanded, anchor: "How to set up \(backend.id)") {
                    VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                        ForEach(hints, id: \.self) { h in
                            Text(h)
                                .font(Theme.Fonts.callout)
                                .foregroundStyle(Theme.Ink.secondary)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.leading, 22 + Theme.Space.m)
            }
        }
        .padding(.horizontal, Theme.Space.l)
        .padding(.vertical, Theme.Space.m)
    }
}
