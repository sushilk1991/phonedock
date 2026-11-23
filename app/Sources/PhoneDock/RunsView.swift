import SwiftUI
import AppKit

/// Recorded flow runs inspector tab (`GET /v1/runs`, SSE `event: run`) and detail sheet (`GET /v1/runs/:id`).
struct RunsTab: View {
    @Environment(AppModel.self) private var model
    let device: Device
    @State private var scope: Scope = .device
    @State private var rows: [RunRow] = []
    @State private var state: LoadState = .idle
    @State private var open: RunSummary?

    private enum Scope: String, CaseIterable {
        case device = "This device"
        case all = "All devices"
    }

    private enum LoadState: Equatable {
        case idle, loading, loaded, outdated
        case failed(FriendlyError)
    }

    private struct RunRow: Identifiable, Hashable {
        let summary: RunSummary
        let date: Date?
        var id: String { summary.id }
    }

    var body: some View {
        VStack(spacing: 0) {
            SectionHeader("Runs") {
                Picker("Scope", selection: $scope) {
                    ForEach(Scope.allCases, id: \.self) { s in
                        Text(s.rawValue)
                            .accessibilityLabel(s.rawValue)
                            .tag(s)
                    }
                }
                .labelsHidden()
                .pickerStyle(.segmented)
                .controlSize(.small)
                .fixedSize()
                .accessibilityLabel("Run scope")
                .help(scope == .device ? "Showing runs on \(device.name)" : "Showing runs across all devices")
                .testAnchor("Runs scope")

                Button { Task { await load() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                    .labelStyle(.iconOnly)
                    .help("Refresh")
                    .disabled(state == .loading)
                    .testAnchor("Refresh Runs")
            }
            content
        }
        .task(id: "\(device.id)|\(scope.rawValue)") {
            await load()
            let updates = NotificationCenter.default.notifications(named: .phoneDockRun)
            for await _ in updates {
                if Task.isCancelled { break }
                await load()
            }
        }
        .sheet(item: $open) { run in
            RunDetailSheet(summary: run).environment(model)
        }
    }

    @ViewBuilder private var content: some View {
        if state == .outdated {
            InspectorMessage(
                title: "Flow runs need a newer PhoneDock service",
                actionTitle: "Restart Service…",
                action: { model.restartDaemonFromApp() }
            )
        } else if case .failed(let p) = state, rows.isEmpty {
            ScrollView { ProblemView(problem: p, retry: { Task { await load() } }).padding(Theme.Space.l) }
        } else if rows.isEmpty {
            if state == .loading || state == .idle {
                DelayedSpinner()
            } else {
                InspectorMessage(
                    symbol: "checklist",
                    title: scope == .device ? "No runs on this device" : "No flow runs yet",
                    message: "Runs from phonedock test and MCP run_flow appear here with app and commit provenance."
                )
                .testAnchor("Runs empty")
            }
        } else {
            List(Array(rows.enumerated()), id: \.element.id) { i, r in
                Button { open = r.summary } label: { rowView(r) }
                    .buttonStyle(.plain)
                    .testAnchor("run-\(i)")
                    .contextMenu {
                        Button("Inspect Run") { open = r.summary }
                        Button("Copy PR Summary") { Task { await copyMarkdown(r.summary.id) } }
                        Button("Copy Run ID") { Pasteboard.copy(r.summary.id) }
                    }
            }
            .listStyle(.inset)
            .scrollContentBackground(.hidden)
        }
    }

    private func rowView(_ r: RunRow) -> some View {
        let s = r.summary
        return HStack(alignment: .firstTextBaseline, spacing: Theme.Space.m) {
            Image(systemName: RunFormat.symbol(s.status))
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(RunFormat.tint(s.status))
                .frame(width: 16)
                .accessibilityLabel(RunFormat.statusLabel(s.status))
            VStack(alignment: .leading, spacing: 2) {
                Text(s.flowName)
                    .font(Theme.Fonts.body)
                    .foregroundStyle(Theme.Ink.primary)
                    .lineLimit(1)
                Text(subtitle(for: s))
                    .font(Theme.Fonts.meta)
                    .foregroundStyle(Theme.Ink.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: Theme.Space.s)
            VStack(alignment: .trailing, spacing: 2) {
                if let d = r.date {
                    Text(PDTime.ago(d))
                        .font(Theme.Fonts.meta.monospacedDigit())
                        .foregroundStyle(Theme.Ink.secondary)
                        .help(PDTime.dayTime(d))
                }
                Text(RunFormat.duration(s.durationMs))
                    .font(Theme.Fonts.caption.monospacedDigit())
                    .foregroundStyle(Theme.Ink.tertiary)
            }
        }
        .padding(.vertical, Theme.Space.xxs)
        .contentShape(Rectangle())
    }

    private func subtitle(for s: RunSummary) -> String {
        var parts: [String] = []
        if scope == .all { parts.append(s.deviceName) }
        if s.appId != "unknown" {
            let ver = s.appVersion == "unknown" && s.appBuild == "unknown" ? "" : " \(s.appVersion) (\(s.appBuild))"
            parts.append("\(s.appId)\(ver)")
        } else {
            parts.append("\(s.passedSteps)/\(s.stepCount) steps")
        }
        if s.commit != "unknown" {
            parts.append(String(s.commit.prefix(7)) + (s.dirty == .dirty ? "*" : ""))
        }
        return parts.joined(separator: " · ")
    }

    private func load() async {
        guard let c = model.client else { return }
        if rows.isEmpty { state = .loading }
        do {
            var q: [String: String] = ["limit": "50"]
            if scope == .device { q["device"] = device.id }
            let list = try await c.get([RunSummary].self, "/v1/runs", query: q, timeout: 30)
            rows = list.map { RunRow(summary: $0, date: ISO8601DateFormatter.flexible($0.startedAt)) }
            state = .loaded
        } catch let e as APIError where e.status == 404 && e.message.hasPrefix("No route") {
            rows = []; state = .outdated
        } catch {
            if rows.isEmpty { state = .failed(FriendlyError.from(error, title: "Couldn’t load flow runs", device: device)) }
        }
    }

    private func copyMarkdown(_ id: String) async {
        guard let c = model.client else { return }
        if let md = try? await c.text("/v1/runs/\(DaemonClient.enc(id))/export", query: ["format": "md"]) {
            Pasteboard.copy(md)
        }
    }
}

struct RunDetailSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let summary: RunSummary
    @State private var record: RunRecord?
    @State private var problem: FriendlyError?
    @State private var copied = false
    @State private var existingReportPath: String?
    @State private var existingArtifactsDir: String?
    @State private var expandedSteps: Set<Int> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            Group {
                if let record {
                    detailBody(record)
                } else if let problem {
                    ProblemView(problem: problem, retry: { Task { await load() } })
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    DelayedSpinner()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            footer
        }
        .background {
            Button("Close") { dismiss() }
                .keyboardShortcut(.cancelAction)
                .opacity(0)
                .accessibilityHidden(true)
        }
        .onExitCommand { dismiss() }
        .frame(width: 760, height: 600)
        .testAnchor(record == nil ? "Run detail loading" : "Run detail ready")
        .task { await load() }
    }

    private var header: some View {
        let status = record?.status ?? summary.status
        let started = ISO8601DateFormatter.flexible(record?.startedAt ?? summary.startedAt).map(PDTime.dayTime)
        let osText = RunFormat.osLabel(
            platform: record?.device.platform ?? summary.platform,
            osVersion: record?.device.osVersion ?? summary.osVersion
        )
        let meta = [
            record?.device.name ?? summary.deviceName,
            osText,
            RunFormat.duration(record?.durationMs ?? summary.durationMs),
            started,
        ].compactMap { $0 }.joined(separator: " · ")

        return HStack(alignment: .center, spacing: Theme.Space.m) {
            Image(systemName: RunFormat.symbol(status))
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(RunFormat.tint(status))
                .accessibilityLabel(RunFormat.statusLabel(status))
            VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                Text(record?.flow.name ?? summary.flowName)
                    .font(Theme.Fonts.title)
                    .foregroundStyle(Theme.Ink.primary)
                    .lineLimit(1)
                Text(meta)
                    .font(Theme.Fonts.callout)
                    .foregroundStyle(Theme.Ink.secondary)
                    .lineLimit(1)
            }
            Spacer()
            Text(RunFormat.statusLabel(status).uppercased())
                .font(Theme.Fonts.eyebrow)
                .foregroundStyle(RunFormat.tint(status))
                .padding(.horizontal, Theme.Space.m)
                .padding(.vertical, Theme.Space.xs)
                .background(RunFormat.tint(status).opacity(0.14), in: RoundedRectangle(cornerRadius: Theme.Radius.badge, style: .continuous))
        }
        .padding(.horizontal, Theme.Space.xxl)
        .padding(.top, Theme.Space.xxl)
        .padding(.bottom, Theme.Space.l)
    }

    private func detailBody(_ r: RunRecord) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Space.l) {
                if let msg = r.message, !msg.isEmpty {
                    HStack(alignment: .top, spacing: Theme.Space.m) {
                        Image(systemName: r.status == "fail" ? "exclamationmark.triangle.fill" : "info.circle.fill")
                            .foregroundStyle(RunFormat.tint(r.status))
                            .accessibilityHidden(true)
                        Text(msg)
                            .font(Theme.Fonts.callout)
                            .foregroundStyle(Theme.Ink.primary)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(Theme.Space.l)
                    .background(RunFormat.tint(r.status).opacity(0.10), in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
                }

                VStack(alignment: .leading, spacing: Theme.Space.s) {
                    Text("PROVENANCE")
                        .font(Theme.Fonts.eyebrow)
                        .foregroundStyle(Theme.Ink.secondary)
                    VStack(alignment: .leading, spacing: Theme.Space.xs) {
                        provenanceRow("Run ID", r.id, mono: true)
                        provenanceRow("Flow", "\(r.flow.fileDisplay)  (\(r.flow.sha256 == "unknown" ? "unknown" : String(r.flow.sha256.prefix(12))))", mono: true)
                        provenanceRow("App", "\(r.app.id) (\(r.app.name)) · v\(r.app.version) (\(r.app.build))")
                        provenanceRow("Source", sourceSummary(r.source), mono: true)
                        provenanceRow("Device", "\(r.device.name) · \(r.device.model) · \(RunFormat.osLabel(platform: r.device.platform, osVersion: r.device.osVersion)) (\(r.device.backend))")
                        provenanceRow("Owner", "\(r.owner) · \(r.attempts) attempt\(r.attempts == 1 ? "" : "s")")
                    }
                    .padding(Theme.Space.l)
                    .background(Theme.Surface.content, in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous).strokeBorder(Theme.Line.separator, lineWidth: 1))
                }

                VStack(alignment: .leading, spacing: Theme.Space.s) {
                    Text("STEPS (\(r.steps.filter { $0.status == "pass" }.count)/\(r.steps.count) PASSED)")
                        .font(Theme.Fonts.eyebrow)
                        .foregroundStyle(Theme.Ink.secondary)
                    if r.steps.isEmpty {
                        Text("No steps were executed.")
                            .font(Theme.Fonts.callout)
                            .foregroundStyle(Theme.Ink.secondary)
                            .padding(.vertical, Theme.Space.s)
                    } else {
                        VStack(spacing: 0) {
                            ForEach(Array(r.steps.enumerated()), id: \.element.id) { idx, st in
                                if idx > 0 { Divider() }
                                VStack(alignment: .leading, spacing: Theme.Space.xs) {
                                    HStack(alignment: .firstTextBaseline, spacing: Theme.Space.m) {
                                        Text("\(st.index).")
                                            .font(Theme.Fonts.meta.monospacedDigit())
                                            .foregroundStyle(Theme.Ink.tertiary)
                                            .frame(width: 24, alignment: .trailing)
                                        Image(systemName: RunFormat.symbol(st.status))
                                            .font(.system(size: 11, weight: .semibold))
                                            .foregroundStyle(RunFormat.tint(st.status))
                                            .accessibilityLabel(RunFormat.statusLabel(st.status))
                                        Text(st.description)
                                            .font(Theme.Fonts.body)
                                            .foregroundStyle(Theme.Ink.primary)
                                            .textSelection(.enabled)
                                        Spacer(minLength: Theme.Space.m)
                                        Text(RunFormat.duration(st.ms))
                                            .font(Theme.Fonts.meta.monospacedDigit())
                                            .foregroundStyle(Theme.Ink.secondary)
                                    }
                                    if let note = st.message, !note.isEmpty {
                                        let isExpanded = expandedSteps.contains(st.index)
                                        let isLong = note.count > 180 || note.contains("\n")
                                        VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                                            Text(note)
                                                .font(Theme.Fonts.callout)
                                                .foregroundStyle(Theme.Ink.secondary)
                                                .lineLimit(isExpanded ? nil : 3)
                                                .textSelection(.enabled)
                                            if isLong {
                                                Button(isExpanded ? "Show less" : "Show more") {
                                                    if isExpanded { expandedSteps.remove(st.index) }
                                                    else { expandedSteps.insert(st.index) }
                                                }
                                                .buttonStyle(.plain)
                                                .font(Theme.Fonts.meta)
                                                .foregroundStyle(Theme.Accent.text)
                                            }
                                        }
                                        .padding(.leading, 46)
                                    }
                                }
                                .padding(.horizontal, Theme.Space.l)
                                .padding(.vertical, Theme.Space.m)
                            }
                        }
                        .background(Theme.Surface.content, in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous).strokeBorder(Theme.Line.separator, lineWidth: 1))
                    }
                }
            }
            .padding(Theme.Space.xxl)
        }
        .background(Theme.Surface.window)
    }

    private func provenanceRow(_ label: String, _ value: String, mono: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Space.m) {
            Text(label)
                .font(Theme.Fonts.callout)
                .foregroundStyle(Theme.Ink.secondary)
                .frame(width: 72, alignment: .leading)
            Text(value)
                .font(mono ? Theme.Fonts.mono : Theme.Fonts.callout)
                .foregroundStyle(Theme.Ink.primary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func sourceSummary(_ s: RunSourceProvenance) -> String {
        if s.commit == "unknown" && s.branch == "unknown" && s.dirty == .unknown { return "unknown" }
        let rev = s.commit == "unknown" ? "unknown" : String(s.commit.prefix(12))
        return "\(rev) on \(s.branch) (\(s.dirty.label))"
    }

    private var footer: some View {
        HStack(spacing: Theme.Space.m) {
            Button {
                Task { await copyPrSummary() }
            } label: {
                Label(copied ? "Copied PR Summary" : "Copy PR Summary", systemImage: copied ? "checkmark" : "doc.on.doc")
            }
            .disabled(record == nil)
            .testAnchor("Copy PR Summary")
            .task(id: copied) { if copied { try? await Task.sleep(for: .seconds(1.5)); copied = false } }

            if let reportPath = existingReportPath {
                Button {
                    let url = URL(fileURLWithPath: reportPath)
                    if !SelfTest.blocksForeground("open flow report \(url.lastPathComponent)") {
                        NSWorkspace.shared.open(url)
                    }
                } label: {
                    Label("Open Report", systemImage: "doc.text")
                }
                .testAnchor("Open Run Report")
            }

            if let dirPath = existingArtifactsDir {
                Button {
                    let url = URL(fileURLWithPath: dirPath)
                    if !SelfTest.blocksForeground("show run artifacts \(url.lastPathComponent)") {
                        NSWorkspace.shared.activateFileViewerSelecting([url])
                    }
                } label: {
                    Label("Show Artifacts", systemImage: "folder")
                }
                .testAnchor("Show Run Artifacts")
            }

            Spacer()
            Button("Done") { dismiss() }
                .keyboardShortcut(.defaultAction)
                .testAnchor("Close Run Detail")
        }
        .padding(.horizontal, Theme.Space.xxl)
        .padding(.vertical, Theme.Space.l)
    }

    private func load() async {
        guard let c = model.client else {
            problem = FriendlyError(title: "PhoneDock isn’t connected", message: "It reconnects automatically.")
            return
        }
        do {
            let loaded = try await c.get(RunRecord.self, "/v1/runs/\(DaemonClient.enc(summary.id))", timeout: 30)
            let reportCandidate = loaded.artifacts?.report ?? summary.report
            let dirCandidate = loaded.artifacts?.dir
            let (validReport, validDir) = await Task.detached(priority: .utility) { () -> (String?, String?) in
                let fm = FileManager.default
                let r = reportCandidate.flatMap { fm.fileExists(atPath: $0) ? $0 : nil }
                let d = dirCandidate.flatMap { fm.fileExists(atPath: $0) ? $0 : nil }
                return (r, d)
            }.value
            record = loaded
            existingReportPath = validReport
            existingArtifactsDir = validDir
            problem = nil
        } catch {
            problem = FriendlyError.from(error, title: "Couldn’t load run details")
        }
    }

    private func copyPrSummary() async {
        guard let c = model.client else { return }
        do {
            let md = try await c.text("/v1/runs/\(DaemonClient.enc(summary.id))/export", query: ["format": "md"])
            Pasteboard.copy(md)
            copied = true
        } catch {
            model.fail("Couldn’t export run summary", error)
        }
    }
}

private enum RunFormat {
    static func symbol(_ status: String) -> String {
        switch status {
        case "pass": return "checkmark.circle.fill"
        case "fail": return "xmark.circle.fill"
        case "warn": return "exclamationmark.triangle.fill"
        default: return "minus.circle.fill"
        }
    }

    static func tint(_ status: String) -> Color {
        switch status {
        case "pass": return Theme.Status.running
        case "fail": return Theme.Status.error
        case "warn", "skip": return Theme.Status.booting
        default: return Theme.Ink.secondary
        }
    }

    static func statusLabel(_ status: String) -> String {
        switch status {
        case "pass": return "Pass"
        case "fail": return "Fail"
        case "warn": return "Warn"
        case "skip": return "Skip"
        default: return status
        }
    }

    static func duration(_ ms: Double) -> String {
        if ms < 1000 { return "\(Int(ms.rounded())) ms" }
        return String(format: "%.1f s", ms / 1000.0)
    }

    static func osLabel(platform: String, osVersion: String) -> String {
        if osVersion == "unknown" || osVersion.isEmpty { return platform }
        if osVersion.lowercased().hasPrefix(platform.lowercased()) { return osVersion }
        return "\(platform) \(osVersion)"
    }
}
