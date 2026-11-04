import AppKit
import SwiftUI

// Connect an Agent › Set Up: runs the bundled CLI's `phonedock setup --agent <id> --json` (src/cli/setup.ts) and shows
// what it changed and its six checks, with a fix for anything that failed. The CLI does all the work, so the app,
// `phonedock setup` in Terminal and the docs can never disagree.

// MARK: - The report (`SetupReport` in src/cli/setup.ts)

struct SetupReport: Decodable, Sendable, Equatable {
    struct Client: Decodable, Sendable, Equatable, Identifiable {
        var id: String
        var name: String
        var found: Bool
        var binary: String?
        var config: String
        var how: String
        /// yes · outdated (this PhoneDock, needs an update) · other (another copy) · no
        var registered: String?
    }
    struct Change: Decodable, Sendable, Equatable {
        var item: String        // mcp | skill | path
        var agents: [String]
        var action: String      // add | update | remove | none | conflict | manual | error
        var target: String
        var detail: String
        var steps: [String]
        var forceable: Bool?
    }
    struct Stage: Decodable, Sendable, Equatable {
        var n: Int
        var id: String
        var agent: String?
        var status: String      // ok | warn | fail | skip
        var title: String
        var detail: String
        var fix: String?
    }
    struct Restart: Decodable, Sendable, Equatable { var agent: String; var note: String }

    var ok: Bool
    var mode: String
    var dryRun: Bool
    var cli: String
    var clients: [Client]
    var agents: [String]
    var changes: [Change]
    var backups: [String]
    var stages: [Stage]
    var tryPrompt: String?
    var restart: [Restart]
    var manual: [String: String]
}

// MARK: - Running the CLI

enum SetupRunner {
    struct Failure: Error, Equatable { var message: String; var details: String }

    /// The app's own environment, plus what the CLI can't work out from it. PHONEDOCK_SETUP_HOME (dev/test only)
    /// points every agent config at a scratch folder, so a test run never touches the real ones.
    static var environment: [String: String] {
        var env = ProcessInfo.processInfo.environment
        if DaemonLocator.port != DaemonLocator.defaultPort { env["PHONEDOCK_PORT"] = String(DaemonLocator.port) }
        if let h = env["PHONEDOCK_SETUP_HOME"], !h.isEmpty { env["PHONEDOCK_SETUP_HOME"] = (h as NSString).expandingTildeInPath }
        // From source, bin/phonedock needs Node; an app opened from Finder has no shell PATH to find it on.
        if !DaemonLocator.isBundled, env["PHONEDOCK_NODE"] == nil, let node = DaemonLocator.findNode() { env["PHONEDOCK_NODE"] = node }
        for k in env.keys where k.hasPrefix("PHONEDOCK_APP_") { env.removeValue(forKey: k) }
        return env
    }

    static func run(_ args: [String]) async -> Result<SetupReport, Failure> {
        let cli = DaemonLocator.cliPath
        let argv = ["setup"] + args + ["--json"]
        let env = environment
        return await Task.detached(priority: .userInitiated) { runBlocking(cli, argv, env) }.value
    }

    /// Off the main thread only: waits for the CLI to exit.
    private nonisolated static func runBlocking(_ cli: String, _ argv: [String], _ env: [String: String]) -> Result<SetupReport, Failure> {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: cli)
        p.arguments = argv
        p.environment = env
        p.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch {
            return .failure(Failure(message: "PhoneDock’s command-line tool didn’t start.", details: "\(cli): \(error.localizedDescription)"))
        }
        // Drain both pipes before waiting, so a long report can't fill one and stall the CLI.
        var errData = Data()
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global(qos: .userInitiated).async { errData = err.fileHandleForReading.readDataToEndOfFile(); group.leave() }
        let outData = out.fileHandleForReading.readDataToEndOfFile()
        group.wait()
        p.waitUntilExit()
        // Exit 1 still carries a report (a conflict, a failed check); only a missing report is a failure here.
        if let r = try? JSONDecoder().decode(SetupReport.self, from: outData) { return .success(r) }
        let stderr = String(decoding: errData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        let stdout = String(decoding: outData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        let tail = (stderr.isEmpty ? stdout : stderr).split(separator: "\n").suffix(12).joined(separator: "\n")
        return .failure(Failure(message: "Setup didn’t finish.",
                                details: "$ \(cli) \(argv.joined(separator: " "))\nexit \(p.terminationStatus)\n\(tail)"))
    }
}

// MARK: - State shared by the sheet and the first-run guide

@MainActor
@Observable
final class AgentSetupModel {
    static let shared = AgentSetupModel()

    /// What a dry run found: each client, and whether it already runs this PhoneDock.
    private(set) var detected: SetupReport?
    private(set) var detecting = false
    private(set) var detectFailure: SetupRunner.Failure?
    /// The last Set Up run for each client, and runs that produced no report.
    private(set) var results: [String: SetupReport] = [:]
    private(set) var failures: [String: SetupRunner.Failure] = [:]
    private(set) var running: String?

    var clients: [SetupReport.Client] { detected?.clients ?? [] }
    var connected: [SetupReport.Client] { clients.filter { $0.registered == "yes" } }

    func detect() async {
        guard !detecting, running == nil else { return }
        detecting = true
        defer { detecting = false }
        switch await SetupRunner.run(["--dry-run"]) {
        case .success(let r): detected = r; detectFailure = nil
        case .failure(let f): if detected == nil { detectFailure = f }
        }
    }

    func setUp(_ agent: String, force: Bool = false) async {
        guard running == nil else { return }
        running = agent
        defer { running = nil }
        failures[agent] = nil
        switch await SetupRunner.run(["--agent", agent] + (force ? ["--force"] : [])) {
        case .success(let r):
            results[agent] = r
            // Every client's state as it is after this run.
            if var d = detected { d.clients = r.clients; detected = d } else { detected = r }
        case .failure(let f):
            failures[agent] = f
        }
    }
}

// MARK: - The sheet

struct AgentSetupSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var setup = AgentSetupModel.shared
    /// The client whose results show: the last one set up.
    @State private var focus: String?
    @State private var replace: SetupReport.Client?
    @State private var showManual = false
    @State private var showOther = false

    private static let order = ["claude", "codex", "cursor", "pi"]

    /// The middle's natural height, and the most it may take: the sheet stays inside its window and the middle scrolls.
    @State private var middleHeight: CGFloat = 0
    @State private var parentHeight: CGFloat?
    private var middleLimit: CGFloat {
        // Title and Done, the margins and the gaps between them (measured), plus room above and below the sheet.
        max(240, (parentHeight ?? 640) - 180)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: Theme.Space.xs) {
                Text("Connect an Agent").font(Theme.Fonts.title).foregroundStyle(Theme.Ink.primary)
                Text("Set Up adds PhoneDock to your coding agent, then checks that it answers.")
                    .font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
            }
            .padding([.horizontal, .top], Theme.Space.xxl)
            .padding(.bottom, Theme.Space.l)
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: Theme.Space.l) {
                        clientList
                        if let focus { results(for: focus).id("results") }
                        disclosures
                        Text("When an agent is using a device, you’ll see it above the screen. You can take over at any time. If it needs your help while you’re in another app, PhoneDock sends a notification.")
                            .font(Theme.Fonts.callout)
                            .foregroundStyle(Theme.Ink.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.horizontal, Theme.Space.xxl)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { middleHeight = $0 }
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(height: min(max(middleHeight, 1), middleLimit))
                // Set Up's checklist and Try It appear under the agent rows: bring them into view when they don't fit.
                .onChange(of: setup.running) { old, new in
                    guard old != nil, new == nil, middleHeight > middleLimit else { return }
                    withAnimation(Theme.Motion.standard) { proxy.scrollTo("results", anchor: .top) }
                }
            }
            HStack {
                Spacer()
                Button("Done") { dismiss() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .testAnchor("Close Agent Sheet")
            }
            .padding([.horizontal, .bottom], Theme.Space.xxl)
            .padding(.top, Theme.Space.l)
        }
        .background(SheetParentHeight(height: $parentHeight))
        .frame(width: 600)
        .onExitCommand { dismiss() }
        .task { await setup.detect() }
        .confirmationDialog("Replace the other PhoneDock registration?", isPresented: Binding(get: { replace != nil }, set: { if !$0 { replace = nil } }), presenting: replace) { c in
            Button("Replace") { run(c.id, force: true) }
            Button("Cancel", role: .cancel) {}
        } message: { c in
            Text("\(c.name) already runs a “phonedock” server from another copy of PhoneDock. Setup backs up \(Self.tilde(c.config)) first."
                 + (editedSkill(c.id) ? " Skill files you edited are replaced too (also backed up)." : ""))
        }
    }

    // MARK: Clients

    @ViewBuilder private var clientList: some View {
        VStack(spacing: 0) {
            if let failure = setup.detectFailure, setup.detected == nil {
                ProblemView(problem: FriendlyError(title: "Couldn’t look for agents", message: "Set them up by hand below.", details: failure.details),
                            retry: { Task { await setup.detect() } })
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Theme.Space.l)
                    .onAppear { showManual = true }
            } else if setup.detected == nil {
                HStack(spacing: Theme.Space.s) {
                    ProgressView().controlSize(.small)
                    Text("Looking for agents on this Mac…").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                }
                .frame(maxWidth: .infinity, minHeight: 4 * 44, alignment: .center)
            } else {
                let clients = Self.order.compactMap { id in setup.clients.first { $0.id == id } }
                ForEach(Array(clients.enumerated()), id: \.element.id) { i, c in
                    if i > 0 { Divider().padding(.leading, Theme.Space.l) }
                    clientRow(c)
                }
            }
        }
        .background(Theme.Surface.card, in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous).strokeBorder(Theme.Line.card, lineWidth: 1))
        .testAnchor("agent-clients")
    }

    private func clientRow(_ c: SetupReport.Client) -> some View {
        HStack(alignment: .center, spacing: Theme.Space.m) {
            VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                Text(c.name).font(Theme.Fonts.body).foregroundStyle(c.found ? Theme.Ink.primary : Theme.Ink.secondary)
                Text(c.found ? Self.tilde(c.how) : "Not found on this Mac")
                    .font(Theme.Fonts.meta).foregroundStyle(Theme.Ink.secondary)
                    .lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: Theme.Space.m)
            if c.found { clientState(c) }
        }
        .padding(.horizontal, Theme.Space.l)
        .padding(.vertical, Theme.Space.m)
        .frame(minHeight: 44)
        .accessibilityElement(children: .contain)
        .testAnchor("agent-row-\(c.id)")
    }

    @ViewBuilder private func clientState(_ c: SetupReport.Client) -> some View {
        if setup.running == c.id {
            HStack(spacing: Theme.Space.s) {
                ProgressView().controlSize(.small)
                Text("Setting up and checking…").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
            }
            .testAnchor("agent-running")
        } else {
            HStack(spacing: Theme.Space.m) {
                switch c.registered {
                case "yes":
                    Label("Connected", systemImage: "checkmark.circle.fill")
                        .labelStyle(StatusLabelStyle(tint: Theme.Status.running))
                    Button("Check Again") { run(c.id) }
                        .testAnchor("Set Up \(c.name)")
                case "other":
                    Label("Another copy is registered", systemImage: "exclamationmark.triangle.fill")
                        .labelStyle(StatusLabelStyle(tint: Theme.Status.handoff))
                    Button("Replace…") { replace = c }
                        .testAnchor("Set Up \(c.name)")
                case "outdated":
                    Text("Needs an update").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                    Button("Update") { run(c.id) }
                        .testAnchor("Set Up \(c.name)")
                default:
                    Button("Set Up") { run(c.id) }
                        .testAnchor("Set Up \(c.name)")
                }
            }
            .controlSize(.small)
            .disabled(setup.running != nil)
        }
    }

    /// --force replaces every conflict in the run: say so when the skill has edits of the user's.
    private func editedSkill(_ agent: String) -> Bool {
        let reports = [setup.results[agent], setup.detected].compactMap { $0 }
        return reports.first.map { $0.changes.contains { $0.item == "skill" && $0.agents.contains(agent) && $0.action == "conflict" } } ?? false
    }

    private func run(_ agent: String, force: Bool = false) {
        focus = agent
        // Setting up an agent is the moment to ask for notifications: help requests come through them.
        HandoffNotifier.shared.requestPermissionIfNeeded()
        Task { await setup.setUp(agent, force: force) }
    }

    // MARK: Results

    @ViewBuilder private func results(for agent: String) -> some View {
        let name = setup.clients.first { $0.id == agent }?.name ?? agent
        if let f = setup.failures[agent] {
            ProblemView(problem: FriendlyError(title: "Couldn’t set up \(name)", message: "Set it up by hand below, or try again.", details: f.details),
                        retry: { run(agent) })
                .frame(maxWidth: .infinity, alignment: .leading)
                .onAppear { showManual = true }
        } else if let r = setup.results[agent], setup.running != agent {
            VStack(alignment: .leading, spacing: Theme.Space.l) {
                SetupResultList(report: r, agent: agent, onReplace: { if let c = setup.clients.first(where: { $0.id == agent }) { replace = c } })
                if r.ok, let prompt = r.tryPrompt {
                    TryItCard(prompt: prompt, agentName: name, restart: r.restart.first { $0.agent == agent }?.note)
                }
            }
            .testAnchor("agent-results")
        }
    }

    // MARK: By hand · Other MCP

    @ViewBuilder private var disclosures: some View {
        VStack(alignment: .leading, spacing: Theme.Space.m) {
            DisclosureRow(title: "Set Up by Hand", isExpanded: $showManual) {
                VStack(alignment: .leading, spacing: Theme.Space.m) {
                    ForEach(Self.order, id: \.self) { id in
                        VStack(alignment: .leading, spacing: Theme.Space.xs) {
                            Text(AgentClient(cliId: id)?.rawValue ?? id).font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                            CommandWell(command: AgentCommands.display(setup.detected?.manual[id] ?? AgentClient(cliId: id).map(AgentCommands.command) ?? ""),
                                        anchor: "Copy \(id) Command",
                                        onCopy: { HandoffNotifier.shared.requestPermissionIfNeeded() })
                        }
                    }
                    Text("Or in Terminal, for every agent at once: \(AgentCommands.cli) setup")
                        .font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            DisclosureRow(title: "Other MCP Client", isExpanded: $showOther) {
                VStack(alignment: .leading, spacing: Theme.Space.s) {
                    Text("Any MCP client can run PhoneDock over stdio with this command:")
                        .font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.primary)
                    CommandWell(command: AgentCommands.command(.other), anchor: "Copy Command")
                    Text("Clients that take JSON:").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.primary)
                    CommandWell(command: AgentCommands.mcpJSON, anchor: "Copy JSON")
                }
            }
        }
    }

    static func tilde(_ s: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return s.replacingOccurrences(of: home + "/", with: "~/")
    }
}

/// A status word with a coloured glyph, the text in the primary ink.
private struct StatusLabelStyle: LabelStyle {
    var tint: Color
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: Theme.Space.xs) {
            configuration.icon.foregroundStyle(tint).accessibilityHidden(true)
            configuration.title.foregroundStyle(Theme.Ink.primary)
        }
        .font(Theme.Fonts.callout)
    }
}

/// What setup changed, then its checks: a line each, the fix under anything that needs one.
private struct SetupResultList: View {
    let report: SetupReport
    let agent: String
    var onReplace: () -> Void

    private struct Row: Identifiable {
        let id: String
        let status: String
        let title: String
        let detail: String
        var fix: String? = nil
        var command: String? = nil
        var replace = false
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            ForEach(rows) { row in
                HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s) {
                    Image(systemName: Self.symbol(row.status))
                        .foregroundStyle(Self.tint(row.status))
                        .frame(width: 14)
                        .accessibilityLabel(Self.word(row.status))
                    VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                        HStack(alignment: .firstTextBaseline, spacing: Theme.Space.m) {
                            Text(row.title).foregroundStyle(Theme.Ink.primary)
                                .frame(width: 150, alignment: .leading)
                            // A passed check's detail is a path or a version: one line, middle cut. A warning
                            // or a failure is a sentence the person has to read: it wraps.
                            Text(row.detail).foregroundStyle(Theme.Ink.secondary)
                                .lineLimit(row.status == "ok" ? 1 : nil).truncationMode(.middle)
                                .fixedSize(horizontal: false, vertical: row.status != "ok")
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .help(row.detail)
                        }
                        if let fix = row.fix {
                            Text(fix)
                                .foregroundStyle(row.status == "fail" ? Theme.Status.errorText : Theme.Ink.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                                .textSelection(.enabled)
                        }
                        if let command = row.command { CommandWell(command: command, oneLine: true) }
                        if row.replace {
                            Button("Replace…", action: onReplace).controlSize(.small)
                        }
                    }
                }
                .font(Theme.Fonts.callout)
                .accessibilityElement(children: .combine)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .pdCard()
    }

    private var rows: [Row] {
        var out: [Row] = []
        for (i, c) in report.changes.enumerated() where c.item != "mcp" || c.agents.contains(agent) {
            out.append(Self.row(i, c))
        }
        for (i, s) in report.stages.enumerated() where s.id != "try" && (s.agent == nil || s.agent == agent) {
            var fix = s.fix
            var command: String?
            // A fix that is one shell command gets a Copy button.
            if let f = fix, let cmd = Self.command(in: f) { command = cmd; fix = f == "Run: \(cmd)" ? nil : f }
            out.append(Row(id: "stage-\(i)", status: s.status, title: s.title, detail: s.detail, fix: fix, command: command))
        }
        return out
    }

    private static func row(_ i: Int, _ c: SetupReport.Change) -> Row {
        let id = "change-\(i)"
        let status = ["conflict", "manual"].contains(c.action) ? "warn" : c.action == "error" ? "fail" : "ok"
        // The CLI's detail starts with the folder for skills ("~/.claude/skills/phonedock: up to date").
        let detail = c.detail.prefix(1).uppercased() + c.detail.dropFirst()
        switch c.item {
        case "mcp":
            let title = "MCP server"
            if c.action == "conflict" { return Row(id: id, status: status, title: title, detail: detail, replace: c.forceable == true) }
            return Row(id: id, status: status, title: title, detail: detail)
        case "skill":
            return Row(id: id, status: status, title: "Agent skill", detail: detail)
        default:
            if c.action == "manual", let line = c.steps.first {   // optional: an info mark, not a warning
                return Row(id: id, status: "info", title: "On your PATH", detail: "Optional: agents use the full path. To type “phonedock” in Terminal, add this to your shell profile:", command: line)
            }
            return Row(id: id, status: status, title: "On your PATH", detail: detail)
        }
    }

    private static func command(in fix: String) -> String? {
        let t = fix.hasPrefix("Run: ") ? String(fix.dropFirst(5)) : fix
        let first = t.split(separator: " ").first.map(String.init) ?? ""
        guard !t.contains("\n"), ["phonedock", "sudo", "brew", "xcode-select", "xcodebuild", "claude", "codex", "pi", "cursor-agent"].contains(first) || first.hasSuffix("/phonedock") else { return nil }
        // Drop a trailing explanation in brackets: "… --force (replaces it; the old entry is backed up)".
        if let r = t.range(of: " (") { return String(t[..<r.lowerBound]) }
        return t
    }

    static func symbol(_ s: String) -> String {
        switch s {
        case "ok": return "checkmark.circle.fill"
        case "warn": return "exclamationmark.triangle.fill"
        case "fail": return "xmark.circle.fill"
        case "info": return "info.circle.fill"
        default: return "minus.circle"
        }
    }
    static func tint(_ s: String) -> Color {
        switch s {
        case "ok": return Theme.Status.running
        case "warn": return Theme.Status.handoff
        case "fail": return Theme.Status.error
        case "info": return Theme.Ink.secondary
        default: return Theme.Ink.tertiary
        }
    }
    static func word(_ s: String) -> String {
        switch s {
        case "ok": return "Done"
        case "warn": return "Needs attention"
        case "fail": return "Failed"
        case "info": return "Optional"
        default: return "Skipped"
        }
    }
}

/// After a good setup: the first thing to ask, ready to copy, and what to restart.
private struct TryItCard: View {
    let prompt: String
    let agentName: String
    let restart: String?
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            Label("Try it", systemImage: "sparkles")
                .font(Theme.Fonts.headline).foregroundStyle(Theme.Ink.primary)
            // What to restart comes first (it already says "start a new session"), then what to ask.
            if let restart {
                Text(restart)
                    .font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(restart == nil ? "Ask \(agentName):" : "Then ask:")
                .font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
            HStack(alignment: .firstTextBaseline, spacing: Theme.Space.m) {
                Text("“\(prompt)”")
                    .font(Theme.Fonts.body).foregroundStyle(Theme.Ink.primary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button(copied ? "Copied" : "Copy") {
                    Clipboard.copy(prompt)
                    copied = true
                }
                .controlSize(.small)
                .frame(minWidth: 56)
                .testAnchor("Copy Prompt")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .pdCard()
        .testAnchor("Try it")
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(1.5))
            copied = false
        }
    }
}

// MARK: - First run: this Mac → a device → your agent

/// The "No Devices Yet" guide: what this Mac can run (with the exact fix for what it can't), New Device…, then
/// Connect an Agent. Each step shows a check once it's done.
struct FirstRunGuide: View {
    @Environment(AppModel.self) private var model
    @State private var setup = AgentSetupModel.shared

    private var macReady: Bool { model.backends.contains { ["ios-simulator", "android-emulator"].contains($0.id) && $0.isAvailable } }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.xl) {
            GuideStep(number: 1, title: "This Mac", done: macReady) {
                PlatformReadiness()
            }
            GuideStep(number: 2, title: "A device", done: false) {
                HStack(spacing: Theme.Space.m) {
                    Button("New Device…") { model.showCreate = true }
                        .buttonStyle(.borderedProminent)
                    Button("Connect a Phone…") { model.showConnect = true }
                }
                .fixedSize()   // each button its own width: the empty state's actions stretch the last one
            }
            GuideStep(number: 3, title: "Your agent", done: !setup.connected.isEmpty) {
                VStack(alignment: .leading, spacing: Theme.Space.s) {
                    if !setup.connected.isEmpty {
                        Text(ListFormatter.localizedString(byJoining: setup.connected.map(\.name)) + " can use PhoneDock.")
                            .font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                    }
                    // Its own width, like the buttons of step 2 (ContentUnavailableView's actions stretch buttons).
                    Button(setup.connected.isEmpty ? "Connect an Agent…" : "Connect Another Agent…") { model.showAgentSetup = true }
                        .fixedSize()
                }
            }
        }
        .frame(maxWidth: 440, alignment: .leading)
        .pdCard(padding: Theme.Space.xl)
        .testAnchor("first-run-guide")
        .task { if setup.detected == nil { await setup.detect() } }
    }
}

private struct GuideStep<Content: View>: View {
    let number: Int
    let title: String
    let done: Bool
    @ViewBuilder var content: Content

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Space.l) {
            ZStack {
                if done {
                    Image(systemName: "checkmark.circle.fill").font(.system(size: 18)).foregroundStyle(Theme.Status.running)
                } else {
                    Circle().strokeBorder(Theme.Ink.tertiary, lineWidth: 1.5)
                    Text("\(number)").font(Theme.Fonts.meta.weight(.semibold)).foregroundStyle(Theme.Ink.secondary)
                }
            }
            .frame(width: 20, height: 20)
            .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
            .accessibilityLabel(done ? "Step \(number), done" : "Step \(number)")
            VStack(alignment: .leading, spacing: Theme.Space.s) {
                Text(title).font(Theme.Fonts.headline).foregroundStyle(Theme.Ink.primary)
                content
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .contain)
    }
}

/// Which kinds of virtual device this Mac can make now, and the exact step for any it can't yet (from
/// `/v1/backends`). Nothing until the service has answered, so it never flashes "not installed".
struct PlatformReadiness: View {
    @Environment(AppModel.self) private var model

    private struct Platform { let id, name, fix: String }
    private static let platforms = [
        Platform(id: "ios-simulator", name: "iPhone simulators", fix: "Install Xcode from the App Store, then open it once"),
        Platform(id: "android-emulator", name: "Android emulators", fix: "Install the Android SDK command-line tools"),
    ]
    /// The commands behind the fixes above, for a Copy button (the service's own hint wins when it has one).
    private static let commands = ["android-emulator": "brew install --cask android-commandlinetools"]

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            if model.backends.isEmpty {
                HStack(spacing: Theme.Space.s) {
                    ProgressView().controlSize(.small)
                    Text("Checking what this Mac can run…").foregroundStyle(Theme.Ink.secondary)
                }
            }
            ForEach(Self.platforms, id: \.id) { p in
                if let b = model.backends.first(where: { $0.id == p.id }) {
                    VStack(alignment: .leading, spacing: Theme.Space.xs) {
                        HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s) {
                            Image(systemName: b.isAvailable ? "checkmark.circle.fill" : "arrow.down.circle")
                                .foregroundStyle(b.isAvailable ? Theme.Status.running : Theme.Ink.secondary)
                                .accessibilityHidden(true)
                            Text(p.name).foregroundStyle(Theme.Ink.primary)
                            Text(b.isAvailable ? "Ready" : fixText(p, b))
                                .foregroundStyle(Theme.Ink.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                                .help(b.isAvailable ? (b.availability?.version ?? "") : (b.availability?.reason ?? ""))
                        }
                        .accessibilityElement(children: .combine)
                        if !b.isAvailable, let cmd = command(p, b) {
                            CommandWell(command: cmd, anchor: "Copy \(p.id) Fix", oneLine: true)
                                .padding(.leading, 20)
                        }
                    }
                }
            }
        }
        .font(Theme.Fonts.callout)
        .testAnchor("platform-readiness")
        .task { if model.backends.isEmpty { await model.loadBackends() } }
    }

    private func hint(_ b: BackendInfo) -> String? { b.availability?.hints?.first { !$0.isEmpty } }
    private static func isCommand(_ s: String) -> Bool {
        let first = s.split(separator: " ").first.map(String.init) ?? ""
        return ["sudo", "brew", "xcode-select", "xcodebuild", "uv", "pipx", "sdkmanager"].contains(first)
    }
    private func fixText(_ p: Platform, _ b: BackendInfo) -> String {
        if let h = hint(b), !Self.isCommand(h) { return h }
        return p.fix
    }
    private func command(_ p: Platform, _ b: BackendInfo) -> String? {
        if let h = hint(b), Self.isCommand(h) { return h }
        return Self.commands[p.id]
    }
}
