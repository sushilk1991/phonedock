import SwiftUI
import AppKit

// MARK: - Screen recording (toolbar)

/// Toolbar item: `record.circle` when idle; while recording, a static red dot + ticking timer + `stop.fill`; while
/// saving, a spinner + "Saving…". When the daemon confirms the file (`model.savedRecordings` changes) it posts a
/// "Recording saved" toast with Show in Finder. Renders nothing when the device can't record.
struct RecordControl: View {
    @Environment(AppModel.self) private var model
    let device: Device

    private var supported: Bool { device.can("record") && !model.recordingUnsupported.contains(device.id) }

    var body: some View {
        Group {
            if supported {
                if let rec = model.recordings[device.id] {
                    recordingPill(rec)
                } else {
                    Button { model.startRecording(device) } label: {
                        Label("Record Screen", systemImage: "record.circle")
                    }
                    .disabled(!device.isRunning)
                    .help("Record Screen (⌘R)")
                    .testAnchor("Record Screen")
                }
            }
        }
        .task(id: "\(device.id)|\(device.state)") {
            // Pick up recordings an agent started, and notice ones that ended on their own (maxSeconds).
            guard supported else { return }
            while !Task.isCancelled {
                await model.syncRecording(device)
                try? await Task.sleep(for: .seconds(model.recordings[device.id] != nil ? 3 : 15))
            }
        }
        .onChange(of: model.savedRecordings[device.id]?.path) { old, new in
            guard let new, new != old else { return }
            announceSaved(path: new, size: model.savedRecordings[device.id]?.sizeBytes)
        }
    }

    @ViewBuilder private func recordingPill(_ rec: RecordingState) -> some View {
        let agent = device.leasedByAgent ? device.controllerName : nil
        Button { model.stopRecording(device) } label: {
            HStack(spacing: Theme.Space.s) {
                if rec.stopping {
                    ProgressView().controlSize(.mini)
                    Text("Saving…").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.primary)
                } else {
                    Circle().fill(Theme.Status.recording).frame(width: 8, height: 8).accessibilityHidden(true)
                    if agent != nil {
                        Image(systemName: "sparkles").font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(Theme.Status.agent).accessibilityHidden(true)
                    }
                    TimelineView(.periodic(from: rec.startedAt, by: 1)) { ctx in
                        Text(PDTime.clock(ctx.date.timeIntervalSince(rec.startedAt)))
                            .font(Theme.Fonts.numeric)
                            .foregroundStyle(Theme.Ink.primary)
                    }
                    Image(systemName: "stop.fill").font(.system(size: 10, weight: .bold))
                        .foregroundStyle(Theme.Ink.primary).accessibilityHidden(true)
                }
            }
            .padding(.horizontal, Theme.Space.xs)
            .fixedSize()
        }
        .disabled(rec.starting || rec.stopping)
        .help(rec.stopping ? "Saving the recording…" : agent.map { "\($0) is recording. Click to stop." } ?? "Stop Recording (⌘R)")
        .accessibilityLabel(rec.stopping ? "Saving recording" : "Stop Recording")
        .testAnchor("Stop Recording")
    }

    private func announceSaved(path: String, size: Double?) {
        model.announceSaved(.recording, url: URL(fileURLWithPath: path), size: size)
    }
}

// MARK: - Crashes

/// A crash row, prepared once per load (no date parsing in `body`).
private struct CrashRow: Identifiable, Equatable {
    let report: CrashReport
    let date: Date?
    var id: String { report.id }

    var symbol: String {
        switch report.kind {
        case "anr": return "hourglass"
        case "jetsam": return "memorychip"
        default: return "exclamationmark.octagon.fill"
        }
    }
    var tint: Color {
        switch report.kind {
        case "anr": return Theme.Status.booting
        case "jetsam": return Theme.Ink.secondary
        default: return Theme.Status.error
        }
    }
    var kindLabel: String {
        switch report.kind {
        case "anr": return "Not responding"
        case "jetsam": return "Out of memory"
        default: return "Crash"
        }
    }
}

struct CrashesTab: View {
    @Environment(AppModel.self) private var model
    let device: Device
    @State private var rows: [CrashRow] = []
    @State private var state: LoadState = .idle
    /// The report on screen and the device it came from, fixed when it opens: the sheet keeps naming the device that
    /// crashed even if the sidebar selection changes behind it.
    @State private var open: OpenCrash?

    struct OpenCrash: Identifiable {
        let crash: CrashReport
        let device: Device
        var id: String { crash.id }
    }

    private enum LoadState: Equatable {
        case idle, loading, loaded, unavailable, outdated
        case failed(FriendlyError)
    }

    var body: some View {
        VStack(spacing: 0) {
            SectionHeader("Crashes") {
                Button { Task { await load() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                    .labelStyle(.iconOnly)
                    .help("Refresh")
                    .disabled(state == .loading || !device.can("crashes"))
                    .testAnchor("Refresh Crashes")
            }
            content
        }
        .task(id: device.id) { await load() }
        .sheet(item: $open) { o in CrashReportSheet(device: o.device, crash: o.crash).environment(model) }
    }

    @ViewBuilder private var content: some View {
        if !device.can("crashes") || state == .unavailable {
            InspectorMessage(title: "Crash reports aren’t available for this device")
        } else if state == .outdated {
            InspectorMessage(title: "Crash reports need a newer PhoneDock service",
                             actionTitle: "Restart Service…", action: { model.restartDaemonFromApp() })
        } else if case .failed(let p) = state {
            ScrollView { ProblemView(problem: p, retry: { Task { await load() } }).padding(Theme.Space.l) }
        } else if rows.isEmpty {
            if state == .loading || state == .idle { DelayedSpinner() }
            else { InspectorMessage(symbol: "checkmark.circle", title: "No crashes") }
        } else {
            List(Array(rows.enumerated()), id: \.element.id) { i, r in
                Button { open = OpenCrash(crash: r.report, device: device) } label: { row(r) }
                    .buttonStyle(.plain)
                    .testAnchor("crash-\(i)")
                    .contextMenu {
                        Button("Open Report") { open = OpenCrash(crash: r.report, device: device) }
                        Button("Copy Report ID") { Pasteboard.copy(r.report.id) }
                    }
            }
            .listStyle(.inset)
            .scrollContentBackground(.hidden)
        }
    }

    private func row(_ r: CrashRow) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Space.m) {
            Image(systemName: r.symbol)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(r.tint)
                .frame(width: 16)
                .accessibilityLabel(r.kindLabel)
            VStack(alignment: .leading, spacing: 1) {
                Text(r.report.title).font(Theme.Fonts.body).foregroundStyle(Theme.Ink.primary).lineLimit(1)
                if let s = r.report.summary, s != r.report.title {
                    Text(s).font(Theme.Fonts.meta).foregroundStyle(Theme.Ink.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: Theme.Space.s)
            if let d = r.date {
                Text(PDTime.ago(d)).font(Theme.Fonts.meta.monospacedDigit()).foregroundStyle(Theme.Ink.secondary)
                    .help(PDTime.dayTime(d))
            }
        }
        .padding(.vertical, Theme.Space.xxs)
        .contentShape(Rectangle())
    }

    private func load() async {
        guard device.can("crashes") else { state = .unavailable; return }
        guard let c = model.client else { return }
        state = .loading
        do {
            let list = try await c.get([CrashReport].self, c.dev(device.id, "/crashes"), query: ["limit": "20"], timeout: 60)
            rows = list.map { CrashRow(report: $0, date: $0.time.flatMap(ISO8601DateFormatter.flexible)) }
            state = .loaded
        } catch let e as APIError where e.status == 501 || e.code == "not_supported" {
            rows = []; state = .unavailable
        } catch let e as APIError where e.status == 404 && e.message.hasPrefix("No route") {
            rows = []; state = .outdated
        } catch {
            rows = []; state = .failed(FriendlyError.from(error, title: "Couldn’t load crash reports", device: device))
        }
    }
}

struct CrashReportSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let device: Device
    let crash: CrashReport
    @State private var text: String?
    @State private var truncated = false
    @State private var loadingFull = false
    @State private var problem: FriendlyError?
    @State private var copied = false

    private var kindLabel: String {
        switch crash.kind { case "anr": return "Not responding"; case "jetsam": return "Out of memory"; default: return "Crash" }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                Text(crash.title).font(Theme.Fonts.title).foregroundStyle(Theme.Ink.primary).lineLimit(1)
                Text(([device.name, kindLabel] + [crash.time.flatMap(ISO8601DateFormatter.flexible).map(PDTime.dayTime)].compactMap { $0 })
                    .joined(separator: " · "))
                    .font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary).lineLimit(1)
            }
            .padding(.horizontal, Theme.Space.xxl)
            .padding(.top, Theme.Space.xxl)
            .padding(.bottom, Theme.Space.l)
            Divider()
            Group {
                if let text {
                    ScrollView([.vertical, .horizontal]) {
                        Text(text).font(Theme.Fonts.mono).foregroundStyle(Theme.Ink.primary).textSelection(.enabled)
                            .fixedSize(horizontal: true, vertical: false)
                            .padding(Theme.Space.l)
                    }
                    .defaultScrollAnchor(.topLeading)
                    .background(Theme.Surface.content)
                } else if let problem {
                    ProblemView(problem: problem, retry: { Task { await load(full: false) } })
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    DelayedSpinner()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            HStack(spacing: Theme.Space.m) {
                Button {
                    if let text { Pasteboard.copy(text); copied = true }
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                }
                .disabled(text == nil)
                .task(id: copied) { if copied { try? await Task.sleep(for: .seconds(1.5)); copied = false } }
                if truncated {
                    Button { Task { await load(full: true) } } label: {
                        Label(loadingFull ? "Loading…" : "Show Full Report", systemImage: "arrow.down.doc")
                    }
                    .disabled(loadingFull)
                    Text("Showing the first part of the report").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                }
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction).testAnchor("Close Crash Report")
            }
            .padding(.horizontal, Theme.Space.xxl)
            .padding(.vertical, Theme.Space.l)
        }
        // Escape closes it too, as in every other sheet (Done keeps Return). Invisible, but its shortcut is live.
        .background {
            Button("Close") { dismiss() }
                .keyboardShortcut(.cancelAction)
                .opacity(0)
                .accessibilityHidden(true)
        }
        .onExitCommand { dismiss() }
        .frame(width: 760, height: 600)
        .testAnchor(text == nil ? "Crash report loading" : "Crash report text")
        .task { await load(full: false) }
    }

    /// The daemon answers `{id, text, truncated, length}` (long reports are shortened unless `full=1`); plain text
    /// is accepted too.
    private func load(full: Bool) async {
        guard let c = model.client else {
            problem = FriendlyError(title: "PhoneDock isn’t connected", message: "It reconnects automatically.")
            return
        }
        loadingFull = full; defer { loadingFull = false }
        do {
            let raw = try await c.text(c.dev(device.id, "/crashes/\(DaemonClient.enc(crash.id))"), query: full ? ["full": "1"] : [:])
            if let obj = try? JSONDecoder().decode(JSONValue.self, from: Data(raw.utf8)), let t = obj["text"]?.stringValue {
                text = t
                if case .bool(let b)? = obj["truncated"] { truncated = b } else { truncated = false }
            } else { text = raw; truncated = false }
            problem = nil
        } catch {
            if text == nil { problem = FriendlyError.from(error, title: "Couldn’t open this report", device: device) }
            else { model.fail("Couldn’t load the full report", error, device: device) }
        }
    }
}
