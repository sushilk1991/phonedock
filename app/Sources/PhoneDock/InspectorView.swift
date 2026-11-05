import SwiftUI
import AppKit
import UniformTypeIdentifiers

enum InspectorTab: String, CaseIterable, Identifiable {
    case info = "Info", apps = "Apps", elements = "Elements", logs = "Logs", activity = "Activity", crashes = "Crashes"
    var id: String { rawValue }
    /// Six shapes that don't look alike at 13 pt: no two are "lines of text".
    var symbol: String {
        switch self {
        case .info: return "info.circle"
        case .apps: return "square.grid.2x2"
        case .elements: return "square.3.layers.3d"
        case .logs: return "terminal"
        case .activity: return "clock.arrow.circlepath"
        case .crashes: return "exclamationmark.octagon"
        }
    }

    /// Tooltip: what the tab shows.
    var help: String {
        switch self {
        case .info: return "Info: status, snapshots and device details"
        case .apps: return "Apps: installed apps"
        case .elements: return "Elements: what’s on the screen"
        case .logs: return "Logs: the device’s log"
        case .activity: return "Activity: what you and agents did"
        case .crashes: return "Crashes: crash reports"
        }
    }

    /// `PHONEDOCK_APP_TAB` (debug/screenshot hook) accepts tab names, including the pre-redesign "UI" and "Snapshots".
    static var initial: InspectorTab {
        named(ProcessInfo.processInfo.environment["PHONEDOCK_APP_TAB"] ?? "") ?? .info
    }

    /// A tab by (case-insensitive) name; also used by the self-test `inspectorTab` op.
    static func named(_ raw: String) -> InspectorTab? {
        switch raw.lowercased() {
        case "ui": return .elements
        case "snapshots": return .info
        default: return allCases.first { $0.rawValue.lowercased() == raw.lowercased() }
        }
    }
}

/// The selected tab's content. The tab picker itself lives in the inspector's toolbar band (`InspectorTabPicker`,
/// placed by ContentView), as in the approved mockup, so the band over the inspector isn't empty.
struct InspectorView: View {
    let device: Device
    @Binding var tab: InspectorTab
    @Binding var highlight: CGRect?

    var body: some View {
        Group {
            switch tab {
            case .info: InfoTab(device: device)
            case .apps: AppsTab(device: device)
            case .elements: ElementsTab(device: device, highlight: $highlight).id(device.id)   // its tree is per device
            case .logs: LogsTab(device: device).id(device.id)   // its scope is per device
            // A fresh tab per device: row ids are log indexes, so reusing one could show the last device's rows.
            case .activity: ActivityTab(device: device).id(device.id)
            case .crashes: CrashesTab(device: device)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .transaction { $0.animation = nil }   // tab switches never animate
        .onChange(of: tab) { if tab != .elements { highlight = nil } }
    }
}

/// Icon-only tabs. Each segment has its own tooltip ("Logs: the device's log") and VoiceOver name ("Logs"):
/// SwiftUI's segmented Picker drops per-segment `.help`, so this is the AppKit control it wraps, set up directly.
struct InspectorTabPicker: View {
    @Binding var tab: InspectorTab

    var body: some View {
        // A fixed width (about 39 pt a tab) keeps the toolbar item rigid: sized from the AppKit control alone, the
        // toolbar shrank the item after a tab change and the control spilled out of it, over the content toolbar.
        Segments(tab: $tab)
            .frame(width: Self.width)
            .fixedSize()
            .testAnchor("Inspector tabs")
    }

    static let width: CGFloat = 236

    private struct Segments: NSViewRepresentable {
        @Binding var tab: InspectorTab

        func makeNSView(context: Context) -> NSSegmentedControl {
            let tabs = InspectorTab.allCases
            let images = tabs.map { NSImage(systemSymbolName: $0.symbol, accessibilityDescription: $0.rawValue) ?? NSImage() }
            let c = NSSegmentedControl(images: images, trackingMode: .selectOne, target: context.coordinator,
                                       action: #selector(Coordinator.changed(_:)))
            for (i, t) in tabs.enumerated() { c.setToolTip(t.help, forSegment: i) }
            c.setAccessibilityLabel("Inspector")
            c.segmentDistribution = .fillEqually
            c.selectedSegment = tabs.firstIndex(of: tab) ?? 0
            return c
        }

        func updateNSView(_ c: NSSegmentedControl, context: Context) {
            context.coordinator.tab = $tab
            let i = InspectorTab.allCases.firstIndex(of: tab) ?? 0
            if c.selectedSegment != i { c.selectedSegment = i }
        }

        func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSSegmentedControl, context: Context) -> CGSize? {
            CGSize(width: proposal.width ?? InspectorTabPicker.width, height: nsView.intrinsicContentSize.height)
        }

        func makeCoordinator() -> Coordinator { Coordinator(tab: $tab) }

        final class Coordinator: NSObject {
            var tab: Binding<InspectorTab>
            init(tab: Binding<InspectorTab>) { self.tab = tab }
            @MainActor @objc func changed(_ sender: NSSegmentedControl) {
                let tabs = InspectorTab.allCases
                if tabs.indices.contains(sender.selectedSegment) { tab.wrappedValue = tabs[sender.selectedSegment] }
            }
        }
    }
}

// MARK: - Shared inspector pieces

/// Centred, quiet message for empty and unavailable states ("No apps found", "Not available for this device").
struct InspectorMessage: View {
    var symbol: String? = nil
    let title: String
    var message: String? = nil
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil

    var body: some View {
        VStack(spacing: Theme.Space.s) {
            if let symbol {
                Image(systemName: symbol).font(.system(size: 22, weight: .regular)).foregroundStyle(Theme.Ink.secondary)
                    .accessibilityHidden(true)
            }
            Text(title).font(Theme.Fonts.callout.weight(.medium)).foregroundStyle(Theme.Ink.secondary)
            if let message {
                Text(message).font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
            }
            if let actionTitle, let action {
                Button(actionTitle, action: action).controlSize(.small).padding(.top, Theme.Space.xs).testAnchor(actionTitle)
            }
        }
        .multilineTextAlignment(.center)
        .padding(Theme.Space.xxl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }
}

/// A spinner that appears only if loading takes longer than 300 ms, with an optional line saying what it waits for.
struct DelayedSpinner: View {
    var label: String? = nil
    @State private var visible = false
    var body: some View {
        VStack(spacing: Theme.Space.s) {
            if visible {
                ProgressView().controlSize(.small)
                if let label { Text(label).font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary) }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task { try? await Task.sleep(for: .milliseconds(300)); visible = true }
    }
}

@MainActor enum Pasteboard {
    static func copy(_ s: String) {
        Clipboard.copy(s)
    }
}

/// A filter/search field in the inspector's style.
private struct InspectorField: View {
    let prompt: String
    @Binding var text: String
    var symbol = "magnifyingglass"
    var onSubmit: () -> Void = {}

    var body: some View {
        HStack(spacing: Theme.Space.s) {
            Image(systemName: symbol).foregroundStyle(Theme.Ink.secondary).accessibilityHidden(true)
            TextField(prompt, text: $text).textFieldStyle(.plain).onSubmit(onSubmit)
            if !text.isEmpty {
                Button { text = ""; onSubmit() } label: { Image(systemName: "xmark.circle.fill") }
                    .buttonStyle(.borderless).foregroundStyle(Theme.Ink.tertiary)
                    .accessibilityLabel("Clear")
            }
        }
        .font(Theme.Fonts.callout)
        .padding(.horizontal, Theme.Space.m)
        .padding(.vertical, Theme.Space.xs + 1)
        .background(Theme.Surface.content, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous).strokeBorder(Theme.Line.separator, lineWidth: 1))
        .padding(.horizontal, Theme.Space.l)
        .padding(.bottom, Theme.Space.s)
    }
}

/// Asks for a name (Save Snapshot, Clone) in the style of the app's other sheets: title, what happens, the field,
/// then Cancel and the action at the trailing edge. Return commits; Escape cancels.
struct NamePromptSheet: View {
    let title: String
    let message: String
    let actionTitle: String
    @State var name: String
    let onCommit: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool

    private var trimmed: String { name.trimmingCharacters(in: .whitespaces) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title).font(Theme.Fonts.title).foregroundStyle(Theme.Ink.primary).lineLimit(1)
            Text(message)
                .font(Theme.Fonts.callout)
                .foregroundStyle(Theme.Ink.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, Theme.Space.xs)
            TextField("Name", text: $name)
                .textFieldStyle(.roundedBorder)
                .focused($focused)
                .onSubmit(commit)
                .padding(.top, Theme.Space.l)
                .testAnchor("Name prompt field")
            HStack(spacing: Theme.Space.m) {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(actionTitle, action: commit)
                    .keyboardShortcut(.defaultAction)
                    .disabled(trimmed.isEmpty)
                    .help(trimmed.isEmpty ? "Enter a name." : "")
            }
            .padding(.top, Theme.Space.xl)
        }
        .padding(Theme.Space.xxl)
        .frame(width: 420)
        .onAppear { focused = true }
    }

    private func commit() {
        guard !trimmed.isEmpty else { return }
        onCommit(name)
        dismiss()
    }
}

/// People-facing names for raw backend values.
enum DisplayText {
    /// A device name that never wraps at its hyphens ("pdtest‑polish‑pixel" stays on one line).
    static func unbroken(_ name: String) -> String { name.replacingOccurrences(of: "-", with: "\u{2011}") }

    /// "pixel_9" → "Pixel 9"; "iPhone 17 Pro" stays.
    static func model(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        guard raw.contains("_"), raw == raw.lowercased() else { return raw }
        return raw.split(separator: "_").map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }

    /// "26.5" on iOS → "iOS 26.5"; "Android 16 (API 36)" stays.
    static func os(_ d: Device) -> String? {
        guard let v = d.osVersion, !v.isEmpty else { return nil }
        return v.first?.isNumber == true ? "\(d.platformName) \(v)" : v
    }

    /// "system-images;android-36;google_apis;arm64-v8a" → "Android API 36 · Google APIs";
    /// "com.apple.CoreSimulator.SimRuntime.iOS-26-5" → "iOS 26.5".
    static func image(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        if raw.hasPrefix("system-images;") {
            let p = raw.split(separator: ";").map(String.init)
            var out: [String] = []
            if p.count > 1 { out.append(p[1].replacingOccurrences(of: "android-", with: "Android API ")) }
            if p.count > 2 {
                let tags = ["google_apis": "Google APIs", "google_apis_playstore": "Google Play", "default": "AOSP"]
                out.append(tags[p[2]] ?? p[2].replacingOccurrences(of: "_", with: " "))
            }
            return out.joined(separator: " · ")
        }
        if let r = raw.range(of: "SimRuntime.") {
            let s = raw[r.upperBound...]
            if let dash = s.firstIndex(of: "-") {
                return s[..<dash] + " " + s[s.index(after: dash)...].replacingOccurrences(of: "-", with: ".")
            }
        }
        return raw
    }

    /// One line for Info › Advanced › Supports.
    static func supports(_ caps: [String]) -> String? {
        let order: [(Set<String>, String)] = [
            (["screenshot", "stream"], "screen"), (["tap", "swipe", "type", "key", "longPress", "doubleTap", "pinch"], "touch and keys"),
            (["uiTree"], "UI tree"), (["ocr"], "text recognition"), (["apps", "install", "launch"], "apps"),
            (["record"], "recording"), (["logs"], "logs"), (["crashes"], "crash reports"), (["snapshot"], "snapshots"),
            (["clone"], "cloning"), (["rotate"], "rotation"), (["location"], "location"), (["openUrl"], "links"),
            (["files", "push"], "files"), (["clipboard"], "clipboard"), (["appData"], "app data"), (["shell"], "shell"),
            (["root"], "root"),
        ]
        let have = Set(caps)
        let words = order.filter { !$0.0.isDisjoint(with: have) }.map(\.1)
        guard let first = words.first else { return nil }
        return ([first.prefix(1).uppercased() + first.dropFirst()] + words.dropFirst()).joined(separator: ", ")
    }
}

// MARK: - Info

struct InfoTab: View {
    @Environment(AppModel.self) private var model
    let device: Device
    @AppStorage("inspector.info.advanced") private var showAdvanced = false
    @State private var snaps: [Snapshot] = []
    @State private var snapState: SnapState = .idle
    @State private var copiedId = false
    @State private var copiedDiag = false
    @State private var autoStart = false

    // Prompts and confirmations
    @State private var savingName: String?
    @State private var cloneName: String?
    @State private var restoreTarget: Snapshot?
    @State private var deleteTarget: Snapshot?

    private enum SnapState: Equatable { case idle, loading, loaded, failed(FriendlyError) }

    private var hardware: String? {
        guard device.kind == "virtual", let sp = device.spec else { return nil }
        var parts: [String] = []
        if let c = sp.cpus { parts.append("\(c) cores") }
        if let r = sp.ramMB { parts.append(Self.gb(r) + " RAM") }
        if let s = sp.storageMB { parts.append(Self.gb(s) + " storage") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    static func gb(_ mb: Int) -> String {
        mb % 1024 == 0 ? "\(mb / 1024) GB" : String(format: "%.1f GB", Double(mb) / 1024)
    }

    var body: some View {
        // A fixed header like every other tab. (A scroll view that touches the toolbar band would also add the band's
        // height again as a content inset.)
        VStack(spacing: 0) {
            SectionHeader("Info")
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    overview.padding(.horizontal, Theme.Space.l)
                    if device.can("snapshot") {
                        sectionDivider
                        snapshots
                    }
                    sectionDivider
                    advanced
                }
                .padding(.bottom, Theme.Space.xl)
            }
        }
        .task(id: device.id) {
            autoStart = device.spec?.autoStart ?? false
            await loadSnapshots()
        }
        .onChange(of: device.spec?.autoStart) { autoStart = device.spec?.autoStart ?? false }
        // Name prompts are sheets like New Device (not alerts): the same buttons, and room for the name.
        .sheet(isPresented: Binding(get: { savingName != nil }, set: { if !$0 { savingName = nil } })) {
            NamePromptSheet(title: "Save Snapshot",
                            message: "Saves the current state of \(DisplayText.unbroken(device.name))." + (restartsForSnapshot ? restartNote : ""),
                            actionTitle: "Save", name: savingName ?? "") { saveSnapshot($0) }
        }
        .sheet(isPresented: Binding(get: { cloneName != nil }, set: { if !$0 { cloneName = nil } })) {
            NamePromptSheet(title: "Clone \(DisplayText.unbroken(device.name))",
                            message: "Creates a copy with everything on it." + (restartsForSnapshot ? restartNote : ""),
                            actionTitle: "Clone", name: cloneName ?? "") { clone($0) }
        }
        // Every confirmation that loses something reads the same: the action in red, Cancel the default (Return).
        .alert("Restore “\(DisplayText.unbroken(restoreTarget?.name ?? ""))”?", isPresented: Binding(get: { restoreTarget != nil }, set: { if !$0 { restoreTarget = nil } }),
               presenting: restoreTarget) { s in
            Button("Restore", role: .destructive) { restore(s) }
            Button("Cancel", role: .cancel) {}.keyboardShortcut(.defaultAction)
        } message: { _ in
            Text("This replaces the current state. Changes since the snapshot are lost."
                 + (restartsForSnapshot ? restartNote : ""))
        }
        .alert("Delete “\(DisplayText.unbroken(deleteTarget?.name ?? ""))”?", isPresented: Binding(get: { deleteTarget != nil }, set: { if !$0 { deleteTarget = nil } }),
               presenting: deleteTarget) { s in
            Button("Delete", role: .destructive) { deleteSnapshot(s) }
            Button("Cancel", role: .cancel) {}.keyboardShortcut(.defaultAction)
        } message: { _ in Text("This permanently deletes the snapshot.") }
    }

    // MARK: Overview

    private var overview: some View {
        Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: Theme.Space.l, verticalSpacing: Theme.Space.s) {
            GridRow {
                label("Status")
                HStack(spacing: Theme.Space.s) {
                    if let operation = model.busy[device.id] ?? model.pending[device.id] {
                        ProgressView().controlSize(.mini)
                        Text(operation)
                    } else {
                        StatusDot(status: PDStatus(deviceState: device.state))
                        Text(PDStatus(deviceState: device.state).label)
                    }
                }
            }
            if let who = device.controllerName {
                GridRow {
                    label("In control")
                    Label {
                        Text(who)
                    } icon: {
                        Image(systemName: device.leasedByHuman ? "person.fill" : "sparkles")
                            .foregroundStyle(device.leasedByHuman ? Theme.Status.human : Theme.Status.agent)
                    }
                    .labelStyle(.titleAndIcon)
                }
            }
            row("Model", DisplayText.model(device.model))
            row("OS", DisplayText.os(device))
            if let s = device.screen, s.width > 0 { row("Screen", "\(Int(s.width)) × \(Int(s.height))") }
            if device.kind == "physical" {
                row("Connection", device.connection == "wifi" ? "Wi-Fi" : device.connection == "usb" ? "USB" : device.connection?.capitalized)
            }
            if device.pdIsBeta {
                GridRow {
                    label("Support")
                    BetaBadge().help("iPhones on iOS 26 and earlier connect through WebDriverAgent, which is in beta")
                }
            }
            row("Hardware", hardware)
        }
        .font(Theme.Fonts.callout)
        .foregroundStyle(Theme.Ink.primary)
    }

    /// Both grids (overview and Advanced) share one label width so their columns line up.
    private func label(_ k: String) -> some View {
        Text(k).foregroundStyle(Theme.Ink.secondary)
            .frame(minWidth: 82, alignment: .trailing)
            .gridColumnAlignment(.trailing)
    }

    @ViewBuilder private func row(_ k: String, _ v: String?, lines: Int = 2) -> some View {
        if let v, !v.isEmpty {
            GridRow {
                label(k)
                Text(v).textSelection(.enabled).lineLimit(lines).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.trailing, Theme.Space.s)
            }
        }
    }

    /// A hairline between the Info, Snapshots and Advanced sections (12 pt above; the next header adds 12 below).
    private var sectionDivider: some View {
        Divider().padding(.horizontal, Theme.Space.l).padding(.top, Theme.Space.l)
    }

    // MARK: Snapshots

    /// An iOS simulator is shut down while its data is copied, then started again; an emulator keeps running.
    private var restartsForSnapshot: Bool { device.platform == "ios" && device.isRunning }
    private var restartNote: String { " The simulator shuts down while this runs, then starts again." }

    private var snapshots: some View {
        let busy = DeviceActions.isBusy(device, model)
        return VStack(alignment: .leading, spacing: 0) {
            SectionHeader("Snapshots") {
                // While an agent holds the device a save would be refused after you've named it: say so up front.
                Button { savingName = Self.defaultSnapshotName() } label: { Label("Save…", systemImage: "plus") }
                    .disabled(busy || device.leasedByAgent || ["booting", "creating", "stopping"].contains(device.state))
                    .help(device.leasedByAgent ? "Take over from \(device.controllerName ?? "the agent") to save a snapshot"
                                               : "Save a snapshot of \(device.name)")
                    .testAnchor("Save Snapshot")
            }
            if let operation = model.busy[device.id] {
                HStack(spacing: Theme.Space.s) {
                    ProgressView().controlSize(.small)
                    Text(operation).font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                }
                .padding(.horizontal, Theme.Space.l).padding(.bottom, Theme.Space.xs)
                .accessibilityElement(children: .combine)
            }
            switch snapState {
            case .failed(let p):
                ProblemView(problem: p, retry: { Task { await loadSnapshots() } }).padding(.horizontal, Theme.Space.l)
            case .loading where snaps.isEmpty, .idle:
                DelayedSpinner().frame(height: 36)
            default:
                if snaps.isEmpty {
                    // While the first one is being saved, "Saving snapshot…" above says enough.
                    if model.busy[device.id] == nil {
                        Text("No snapshots yet")
                            .font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                            .padding(.horizontal, Theme.Space.l).padding(.vertical, Theme.Space.xs)
                    }
                } else {
                    VStack(spacing: 0) {
                        ForEach(snaps) { s in
                            SnapshotRow(snapshot: s, busy: busy, onRestore: { restoreTarget = s }, onDelete: { deleteTarget = s })
                        }
                    }
                    .padding(.horizontal, Theme.Space.s)
                }
            }
        }
    }

    static func defaultSnapshotName() -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd-HHmm"
        return "snapshot-\(f.string(from: Date()))"
    }

    // MARK: Advanced

    private var advanced: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                Theme.Motion.expand { showAdvanced.toggle() }
            } label: {
                HStack(spacing: Theme.Space.xs) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .rotationEffect(.degrees(showAdvanced ? 90 : 0))
                        .foregroundStyle(Theme.Ink.secondary)
                    Text("Advanced").font(Theme.Fonts.headline).foregroundStyle(Theme.Ink.primary)
                    Spacer()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.horizontal, Theme.Space.l)
            .padding(.top, Theme.Space.l)
            .padding(.bottom, Theme.Space.s)
            .accessibilityLabel(showAdvanced ? "Hide Advanced" : "Show Advanced")
            .testAnchor("Advanced")
            if showAdvanced { advancedBody.padding(.horizontal, Theme.Space.l) }
        }
    }

    private var advancedBody: some View {
        VStack(alignment: .leading, spacing: Theme.Space.l) {
            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: Theme.Space.l, verticalSpacing: Theme.Space.s) {
                GridRow {
                    label("Device ID")
                    HStack(alignment: .firstTextBaseline, spacing: Theme.Space.xs) {
                        Text(device.id).font(Theme.Fonts.monoSmall).textSelection(.enabled).lineLimit(1).truncationMode(.middle)
                            .help(device.id)
                        Button {
                            Pasteboard.copy(device.id); copiedId = true
                        } label: { Image(systemName: copiedId ? "checkmark" : "doc.on.doc") }
                            .buttonStyle(.borderless)
                            .foregroundStyle(Theme.Ink.secondary)
                            .help("Copy Device ID")
                            .accessibilityLabel("Copy Device ID")
                            .task(id: copiedId) { if copiedId { try? await Task.sleep(for: .seconds(1.5)); copiedId = false } }
                    }
                }
                row("Runs on", model.backends.first { $0.id == device.backend }?.plainName ?? device.backend)
                row("System image", DisplayText.image(device.spec?.image))
                row("Supports", DisplayText.supports(device.caps), lines: 5)
            }
            .font(Theme.Fonts.callout)
            .foregroundStyle(Theme.Ink.primary)
            if device.managed == true {
                HStack {
                    Text("Start automatically").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.primary)
                    Spacer()
                    Toggle("Start automatically", isOn: Binding(get: { autoStart }, set: { setAutoStart($0) }))
                        .labelsHidden()
                        .toggleStyle(.switch)
                        .controlSize(.mini)
                }
                .help("Start \(device.name) when PhoneDock starts")
                .testAnchor("Start automatically")
            }
            HStack(spacing: Theme.Space.m) {
                Button { copyDiagnostics() } label: {
                    Label(copiedDiag ? "Copied" : "Copy Diagnostics", systemImage: copiedDiag ? "checkmark" : "doc.on.doc")
                }
                .task(id: copiedDiag) { if copiedDiag { try? await Task.sleep(for: .seconds(1.5)); copiedDiag = false } }
                if device.can("clone") {
                    Button { cloneName = Self.cloneName(device, existing: model.devices) } label: {
                        Label("Clone…", systemImage: "plus.square.on.square")
                    }
                    .disabled(DeviceActions.isBusy(device, model))
                    .testAnchor("Clone")
                }
            }
            .controlSize(.small)
        }
    }

    static func cloneName(_ d: Device, existing: [Device]) -> String {
        let sep = d.platform == "ios" ? " " : "-"
        var candidate = d.name + sep + "copy", n = 2
        while existing.contains(where: { $0.name == candidate }) { candidate = d.name + sep + "copy\(sep)\(n)"; n += 1 }
        return candidate
    }

    // MARK: Actions

    private func loadSnapshots() async {
        guard device.can("snapshot"), let c = model.client else { return }
        if snapState != .loaded { snapState = .loading }
        do {
            let list = try await c.get([Snapshot].self, c.dev(device.id, "/snapshots"))
            snaps = list.sorted { ($0.createdAt ?? "") > ($1.createdAt ?? "") }
            snapState = .loaded
        } catch let e as APIError where e.status == 501 || e.code == "not_supported" {
            snaps = []; snapState = .loaded
        } catch {
            snapState = .failed(FriendlyError.from(error, title: "Couldn’t load snapshots", device: device))
        }
    }

    private func saveSnapshot(_ raw: String) {
        let name = raw.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        // An iOS save copies the data and boots the simulator again, which can take minutes.
        model.perform("Couldn’t save the snapshot", device: device, busy: "Saving snapshot…") { c in
            try await c.send("POST", c.dev(device.id, "/snapshots"), json: ["name": name], timeout: 900)
            await loadSnapshots()
            await MainActor.run { model.toast = Toast(kind: .success, title: "Snapshot saved", message: name) }
        }
    }

    private func restore(_ s: Snapshot) {
        model.perform("Couldn’t restore “\(s.name)”", device: device, blocking: true, busy: "Restoring snapshot…") { c in
            try await c.send("POST", c.dev(device.id, "/snapshots/\(DaemonClient.enc(s.name))/restore"), timeout: 900)
            await MainActor.run { model.toast = Toast(kind: .success, title: "Snapshot restored", message: s.name) }
        }
    }

    private func deleteSnapshot(_ s: Snapshot) {
        // Gone from the list at once; a failure reloads it (and says why).
        withAnimation(Theme.Motion.standard) { snaps.removeAll { $0.id == s.id } }
        model.perform("Couldn’t delete “\(s.name)”", device: device) { c in
            do { try await c.send("DELETE", c.dev(device.id, "/snapshots/\(DaemonClient.enc(s.name))")) }
            catch { await loadSnapshots(); throw error }
        }
    }

    private func clone(_ raw: String) {
        let name = raw.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, let c = model.client else { return }
        let id = device.id
        model.busy[id] = "Cloning…"
        Task {
            defer { model.busy[id] = nil }
            do {
                let job = try await c.sendJob("POST", c.dev(device.id, "/clone"), json: ["name": name])
                let done = await model.track(job, failure: "Couldn’t clone \(device.name)", blocking: true)
                if let id = done.resultDeviceId { model.selection = id }
            } catch { model.fail("Couldn’t clone \(device.name)", error, device: device, blocking: true) }
        }
    }

    private func setAutoStart(_ on: Bool) {
        autoStart = on
        let d = device
        model.perform("Couldn’t change \(d.name)", device: d) { c in
            do { try await c.send("PATCH", c.dev(d.id), json: ["autoStart": on]) }
            catch { await MainActor.run { autoStart = !on }; throw error }
        }
    }

    private func copyDiagnostics() {
        let d = device
        let client = model.client
        Task {
            var obj: [String: JSONValue] = [:]
            if let data = try? JSONEncoder().encode(d), let v = try? JSONDecoder().decode(JSONValue.self, from: data) { obj["device"] = v }
            if let c = client, let info = try? await c.get(JSONValue.self, c.dev(d.id, "/info"), timeout: 15) { obj["info"] = info }
            let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
            if let data = try? enc.encode(JSONValue.object(obj)) { Pasteboard.copy(String(decoding: data, as: UTF8.self)) }
            copiedDiag = true
        }
    }
}

/// Restore… is always visible: a hover-only button can't be found, reached with Tab or read by VoiceOver.
private struct SnapshotRow: View {
    let snapshot: Snapshot
    /// Another snapshot, restore or clone is running on this device.
    var busy = false
    let onRestore: () -> Void
    let onDelete: () -> Void
    @State private var hovering = false

    private var subtitle: String {
        [snapshot.createdAt.flatMap(ISO8601DateFormatter.flexible).map(PDTime.dayTime),
         snapshot.sizeMB.map { $0 >= 1024 ? String(format: "%.1f GB", $0 / 1024) : String(format: "%.0f MB", $0) }]
            .compactMap { $0 }.joined(separator: " · ")
    }

    var body: some View {
        HStack(spacing: Theme.Space.m) {
            Image(systemName: "clock.arrow.circlepath").foregroundStyle(Theme.Ink.secondary).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(snapshot.name).font(Theme.Fonts.body).foregroundStyle(Theme.Ink.primary).lineLimit(1)
                if !subtitle.isEmpty { Text(subtitle).font(Theme.Fonts.meta).foregroundStyle(Theme.Ink.secondary).lineLimit(1) }
            }
            .accessibilityElement(children: .combine)
            Spacer(minLength: Theme.Space.s)
            Button("Restore…", action: onRestore)
                .disabled(busy)
                .help("Restore \(snapshot.name)")
                .accessibilityLabel("Restore \(snapshot.name)")
                .testAnchor("Restore \(snapshot.name)")
        }
        .padding(.horizontal, Theme.Space.s)
        .padding(.vertical, Theme.Space.xs)
        .background(hovering ? Theme.Line.card : Color.clear, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .contextMenu {
            Button("Restore…", action: onRestore).disabled(busy)
            Divider()
            Button("Delete…", role: .destructive, action: onDelete).disabled(busy)
        }
        // The name and date read as one element; Restore… stays its own button (Tab, VoiceOver), Delete is an action.
        .accessibilityElement(children: .contain)
        .accessibilityAction(named: "Delete", onDelete)
    }
}

// MARK: - Apps

struct AppsTab: View {
    @Environment(AppModel.self) private var model
    let device: Device
    @AppStorage("inspector.apps.showSystem") private var showSystem = false
    @State private var apps: [AppInfo] = []
    @State private var state: LoadState = .idle
    @State private var search = ""
    @State private var showImporter = false
    @State private var uninstallTarget: AppInfo?

    private enum LoadState: Equatable { case idle, loading, loaded, failed(FriendlyError) }

    private var available: Bool { device.can("apps") }

    private var filtered: [AppInfo] {
        let q = search.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return apps }
        return apps.filter { ($0.name ?? "").localizedCaseInsensitiveContains(q) || $0.id.localizedCaseInsensitiveContains(q) }
    }

    var body: some View {
        VStack(spacing: 0) {
            SectionHeader("Apps") {
                if device.can("install") {
                    Button { showImporter = true } label: { Label("Install…", systemImage: "square.and.arrow.down") }
                        .disabled(!device.isRunning)
                        .help("Install an app from a file")
                }
                Menu {
                    Toggle("Show System Apps", isOn: $showSystem)
                    Divider()
                    Button("Refresh") { Task { await load() } }
                } label: { Image(systemName: "ellipsis.circle") }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .help("More")
                    .accessibilityLabel("More")
                    .disabled(!available || !device.isRunning)
            }
            if available && device.isRunning && !apps.isEmpty {
                InspectorField(prompt: "Search", text: $search)
            }
            content
        }
        .task(id: "\(device.id)|\(showSystem)|\(device.state)") { await load() }
        .fileImporter(isPresented: $showImporter, allowedContentTypes: [.item], allowsMultipleSelection: false) { r in
            if case .success(let urls) = r, let u = urls.first { model.installApp(device, path: u.path) }
        }
        .alert("Uninstall “\(uninstallTarget.map(Self.name) ?? "")”?", isPresented: Binding(get: { uninstallTarget != nil }, set: { if !$0 { uninstallTarget = nil } }),
               presenting: uninstallTarget) { app in
            Button("Uninstall", role: .destructive) { uninstall(app) }
            Button("Cancel", role: .cancel) {}.keyboardShortcut(.defaultAction)
        } message: { _ in Text("The app and its data are removed from \(device.name).") }
    }

    @ViewBuilder private var content: some View {
        if !available {
            InspectorMessage(title: "Apps aren’t available for this device")
        } else if !device.isRunning {
            InspectorMessage(title: "Start the device to see its apps.")
        } else if case .failed(let p) = state {
            ScrollView { ProblemView(problem: p, retry: { Task { await load() } }).padding(Theme.Space.l) }
        } else if apps.isEmpty {
            // A new phone or simulator has only the apps it came with, which are hidden: say so, and offer them.
            if state != .loaded { DelayedSpinner() }
            else if showSystem { InspectorMessage(title: "No apps found") }
            else {
                InspectorMessage(title: "No apps you installed",
                                 message: "The apps \(device.name) came with are hidden.",
                                 actionTitle: "Show System Apps", action: { showSystem = true })
            }
        } else if filtered.isEmpty {
            InspectorMessage(title: "No apps match “\(search)”")
        } else {
            List(filtered) { app in
                AppRow(app: app, canLaunch: device.can("launch"), onLaunch: { launch(app) })
                    .contextMenu {
                        Button("Open") { launch(app) }.disabled(!device.can("launch"))
                        Button("Stop") { terminate(app) }
                        Button("Copy Bundle ID") { Pasteboard.copy(app.id) }
                        if device.can("install") {
                            Divider()
                            Button("Uninstall…", role: .destructive) { uninstallTarget = app }
                        }
                    }
            }
            .listStyle(.inset)
            .scrollContentBackground(.hidden)
        }
    }

    static func name(_ app: AppInfo) -> String { app.name ?? app.id }

    private func launch(_ app: AppInfo) {
        model.perform("Couldn’t open \(Self.name(app))", device: device) { try await $0.send("POST", $0.dev(device.id, "/apps/\(DaemonClient.enc(app.id))/launch")) }
    }

    private func terminate(_ app: AppInfo) {
        model.perform("Couldn’t stop \(Self.name(app))", device: device) { try await $0.send("POST", $0.dev(device.id, "/apps/\(DaemonClient.enc(app.id))/terminate")) }
    }

    private func uninstall(_ app: AppInfo) {
        model.perform("Couldn’t uninstall \(Self.name(app))", device: device) { c in
            try await c.send("DELETE", c.dev(device.id, "/apps/\(DaemonClient.enc(app.id))"))
            await load()
        }
    }

    private func load() async {
        guard available, device.isRunning, let c = model.client else { apps = []; state = .idle; return }
        if state != .loaded { state = .loading }
        do {
            apps = try await c.get([AppInfo].self, c.dev(device.id, "/apps"), query: showSystem ? ["system": "1"] : [:])
                .sorted { Self.name($0).lowercased() < Self.name($1).lowercased() }
            state = .loaded
        } catch {
            state = .failed(FriendlyError.from(error, title: "Couldn’t load apps", device: device))
        }
    }
}

/// An app's tile: its first letter on a colour taken from its id (the service sends no icons).
private struct AppGlyph: View {
    let app: AppInfo

    private var letter: String {
        let base = (app.name?.isEmpty == false ? app.name! : app.id.split(separator: ".").last.map(String.init) ?? app.id)
        return String(base.first(where: \.isLetter) ?? "?").uppercased()
    }

    private var tint: Color {
        let palette: [Color] = [Theme.Accent.fill, Theme.Status.agent, Theme.Status.human, Theme.Status.handoffStrong, Theme.Status.running]
        let h = app.id.unicodeScalars.reduce(5381) { ($0 &* 33) &+ Int($1.value) }
        return palette[abs(h) % palette.count]
    }

    var body: some View {
        Text(letter)
            .font(.system(size: 12, weight: .semibold, design: .rounded))
            .foregroundStyle(Theme.Ink.onFill)
            .frame(width: 24, height: 24)
            .background(tint.gradient, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .accessibilityHidden(true)
    }
}

private struct AppRow: View {
    let app: AppInfo
    let canLaunch: Bool
    let onLaunch: () -> Void
    @State private var hovering = false

    var body: some View {
        HStack(spacing: Theme.Space.m) {
            AppGlyph(app: app)
            VStack(alignment: .leading, spacing: 1) {
                if let n = app.name, !n.isEmpty, n != app.id {
                    Text(n).font(Theme.Fonts.body).foregroundStyle(Theme.Ink.primary).lineLimit(1)
                    Text(app.id).font(Theme.Fonts.monoSmall).foregroundStyle(Theme.Ink.secondary).lineLimit(1).truncationMode(.middle)
                } else {
                    Text(app.id).font(Theme.Fonts.body).foregroundStyle(Theme.Ink.primary).lineLimit(1).truncationMode(.middle)
                }
            }
            Spacer(minLength: Theme.Space.s)
            if let v = app.version, !hovering {
                Text(v).font(Theme.Fonts.meta.monospacedDigit()).foregroundStyle(Theme.Ink.secondary).lineLimit(1)
            }
            if canLaunch {
                // Always there (hover-only controls can't be found with the keyboard or VoiceOver); quiet until hovered.
                Button("Open", action: onLaunch)
                    .controlSize(.small)
                    .opacity(hovering ? 1 : 0.55)
                    .help("Open \(app.name ?? app.id)")
                    .accessibilityLabel("Open \(app.name ?? app.id)")
            }
        }
        .padding(.vertical, 1)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
    }
}

// MARK: - Elements (UI tree)

struct ElementsTab: View {
    @Environment(AppModel.self) private var model
    let device: Device
    @Binding var highlight: CGRect?
    @State private var lines: [String]
    @State private var rows: [ElementRow]   // parsed once per load, parallel to `lines`
    /// The last tree read per device: coming back to the tab shows it at once (faded while it's read again), instead
    /// of a spinner for the 5–15 s an iPhone takes to describe its screen.
    private static var lastTree: [String: [String]] = [:]

    init(device: Device, highlight: Binding<CGRect?>) {
        self.device = device
        _highlight = highlight
        let cached = Self.lastTree[device.id] ?? []
        _lines = State(initialValue: cached)
        _rows = State(initialValue: cached.map(ElementRow.init))
    }
    @State private var selected: Int?
    @State private var filter = ""
    @State private var state: LoadState = .idle

    private enum LoadState: Equatable { case idle, loading, loaded, failed(FriendlyError) }

    private var available: Bool { device.can("uiTree") || device.can("ocr") }

    private var visible: [(Int, String)] {
        let q = filter.trimmingCharacters(in: .whitespaces)
        let all = Array(lines.enumerated())
        return q.isEmpty ? all.map { ($0.offset, $0.element) } : all.filter { $0.element.localizedCaseInsensitiveContains(q) }.map { ($0.offset, $0.element) }
    }

    var body: some View {
        VStack(spacing: 0) {
            SectionHeader("Elements") {
                // One loading state at a time: the big one while there's nothing to show, this one while refreshing.
                if state == .loading && !lines.isEmpty { ProgressView().controlSize(.mini) }
                Button { Task { await load() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                    .labelStyle(.iconOnly)
                    .help("Refresh")
                    .disabled(!device.isRunning || !available || state == .loading)
                    .testAnchor("Refresh Elements")
            }
            if !lines.isEmpty { InspectorField(prompt: "Filter", text: $filter, symbol: "line.3.horizontal.decrease.circle") }
            content
            if !lines.isEmpty {
                Divider()
                Text(filter.isEmpty ? "\(lines.count) elements" : "\(visible.count) of \(lines.count) elements")
                    .font(Theme.Fonts.meta.monospacedDigit())
                    .foregroundStyle(Theme.Ink.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Theme.Space.l)
                    .padding(.vertical, Theme.Space.s)
            }
        }
        // a turned screen moves every element: read it again
        .task(id: "\(device.id)|\(device.state)|\(device.orientation ?? "")") { await load() }
        .onChange(of: selected) { highlight = selected.flatMap { lines.indices.contains($0) ? Self.bounds(lines[$0]) : nil } }
        .onAppear {
            guard SelfTest.enabled else { return }
            let sel = $selected, ls = $lines
            SelfTest.selectElement = { q in
                guard let i = ls.wrappedValue.firstIndex(where: { $0.contains(q) }) else { return nil }
                sel.wrappedValue = i
                return ls.wrappedValue[i]
            }
        }
        .onDisappear { highlight = nil }
    }

    @ViewBuilder private var content: some View {
        if !available {
            InspectorMessage(title: "Elements aren’t available for this device")
        } else if !device.isRunning {
            InspectorMessage(title: "Start the device to inspect its screen.")
        } else if case .failed(let p) = state {
            ScrollView { ProblemView(problem: p, retry: { Task { await load() } }).padding(Theme.Space.l) }
        } else if lines.isEmpty {
            if state == .loading || state == .idle { DelayedSpinner(label: "Reading the screen…") }
            else { InspectorMessage(title: "Refresh to inspect the screen", actionTitle: "Refresh", action: { Task { await load() } }) }
        } else if visible.isEmpty {
            InspectorMessage(title: "No elements match “\(filter)”")
        } else {
            List(selection: $selected) {
                ForEach(visible, id: \.0) { i, l in
                    Group {
                        if rows.indices.contains(i) { ElementRowView(row: rows[i]) } else { Text(l).font(Theme.Fonts.mono).lineLimit(1) }
                    }
                    .help(l).tag(i)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 2, leading: Theme.Space.s, bottom: 2, trailing: Theme.Space.s))
                }
            }
            .listStyle(.inset)
            .environment(\.defaultMinListRowHeight, 22)
            .scrollContentBackground(.hidden)
            .opacity(state == .loading ? 0.55 : 1)   // the last tree, while the screen is read again
        }
    }

    /// Parses `@(cx,cy) WxH` (the daemon's text outline: `e6 Button "Greet" @(179,551) 231x126 [clickable]`; the
    /// older `[w×h]` form too) from a line into a rect in device pixels.
    static func bounds(_ line: String) -> CGRect? {
        let re = /@\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)\s*\[?(\d+(?:\.\d+)?)\s*[×x]\s*(\d+(?:\.\d+)?)\]?/
        guard let m = line.firstMatch(of: re), let cx = Double(m.1), let cy = Double(m.2), let w = Double(m.3), let h = Double(m.4) else { return nil }
        return CGRect(x: cx - w / 2, y: cy - h / 2, width: w, height: h)
    }

    private func load() async {
        guard available, device.isRunning, let c = model.client else { lines = []; state = .idle; return }
        state = .loading
        do {
            let t = try await c.text(c.dev(device.id, "/ui"), query: ["format": "text"])
            lines = t.split(separator: "\n", omittingEmptySubsequences: true).map(String.init).filter { !$0.hasPrefix("#") }
            rows = lines.map(ElementRow.init)
            Self.lastTree[device.id] = lines
            selected = nil
            state = .loaded
        } catch {
            state = .failed(FriendlyError.from(error, title: "Couldn’t inspect the screen", device: device))
        }
    }
}

/// One line of the daemon's text outline (`e6 Button "Greet" id=greetButton @(179,551) 231x126 [clickable]`), split
/// into what a person scans for: the kind of element, its visible name, its id, and on/off state.
struct ElementRow: Hashable {
    let type: String
    let name: String?
    let id: String?
    let value: String?
    let state: String?      // "On" / "Off" for switches and checkboxes
    let disabled: Bool

    init(_ line: String) {
        let parts = line.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: true)
        type = parts.count > 1 ? String(parts[1]) : line
        let rest = parts.count > 2 ? String(parts[2]) : ""
        func quoted(after prefix: String) -> String? {
            let re = /(?:^|\s)([a-z]+=)?"((?:[^"\\]|\\.)*)"/
            for m in rest.matches(of: re) where String(m.1 ?? "") == prefix {
                return (try? JSONDecoder().decode(String.self, from: Data("\"\(m.2)\"".utf8))) ?? String(m.2)
            }
            return nil
        }
        let text = quoted(after: ""), label = quoted(after: "label=")
        name = [text, label].compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }.first { !$0.isEmpty }
        value = quoted(after: "value=")
        id = rest.firstMatch(of: /(?:^|\s)id=(\S+)/).map { String($0.1) }
        let flags = rest.firstMatch(of: /\[([a-z,]+)\]\s*$/).map { $0.1.split(separator: ",").map(String.init) } ?? []
        state = flags.contains("on") ? "On" : flags.contains("off") ? "Off" : nil
        disabled = flags.contains("disabled")
    }
}

private struct ElementRowView: View {
    let row: ElementRow
    /// `.increased` on the selected row (indigo fill): ink switches to white so it stays readable.
    @Environment(\.backgroundProminence) private var prominence

    private var primary: Color { prominence == .increased ? Theme.Ink.onFill : Theme.Ink.primary }
    private var secondary: Color { prominence == .increased ? Theme.Ink.onFill.opacity(0.8) : Theme.Ink.secondary }

    var body: some View {
        HStack(spacing: Theme.Space.s) {
            Text(row.type)
                .font(Theme.Fonts.meta)
                .foregroundStyle(secondary)
                .frame(width: 78, alignment: .leading)
            if let n = row.name {
                Text(n).font(Theme.Fonts.callout).foregroundStyle(primary)
            } else if let id = row.id {
                Text(id).font(Theme.Fonts.mono).foregroundStyle(secondary)
            } else if let v = row.value {
                Text(v).font(Theme.Fonts.callout).foregroundStyle(secondary)
            }
            Spacer(minLength: Theme.Space.xs)
            if let st = row.state {
                Text(st).font(Theme.Fonts.caption.weight(.semibold)).foregroundStyle(secondary)
            }
        }
        .lineLimit(1)
        .truncationMode(.tail)
        .opacity(row.disabled ? 0.55 : 1)
        .accessibilityElement(children: .combine)
    }
}

/// Pre-redesign name, kept for callers that still say `UITab`.
typealias UITab = ElementsTab

// MARK: - Logs

/// Which app's lines the Logs tab shows.
enum LogScope: Hashable {
    case all, front
    case app(id: String, name: String)

    var title: String {
        switch self {
        case .all: return "All Apps"
        case .front: return "App in Front"
        case .app(_, let name): return name
        }
    }
}

/// Log lines coloured by level: errors red, warnings amber, info primary, debug and verbose secondary. Reads logcat's
/// `threadtime` lines (`11-04 17:45:10.439  671  999 E Tag: …`) and `log show --style compact` lines
/// (`2026-11-04 17:45:16.376 E  proc[1:2] …`); anything else stays primary.
enum LogLevels {
    enum Level { case error, warning, info, debug }

    static func level(_ line: Substring) -> Level {
        let f = line.split(separator: " ", maxSplits: 5, omittingEmptySubsequences: true)
        if f.count > 4, f[0].count == 5, f[0].dropFirst(2).first == "-" {   // logcat: date time pid tid L
            switch f[4] {
            case "E", "F", "A": return .error
            case "W": return .warning
            case "D", "V": return .debug
            default: return .info
            }
        }
        if f.count > 2, f[0].count == 10, f[0].dropFirst(4).first == "-" {   // log show compact: date time type
            switch f[2] {
            case "E", "Fa", "F": return .error
            case "Db", "D": return .debug
            default: return .info
            }
        }
        return .info
    }

    static func color(_ l: Level) -> Color {
        switch l {
        case .error: return Theme.Status.errorText
        case .warning: return Theme.Status.handoffText
        case .info: return Theme.Ink.primary
        case .debug: return Theme.Ink.secondary
        }
    }

    /// One log line, read for display: time, a one-letter level, the tag (or process) and the message. Lines in
    /// neither format keep their text as the message.
    struct Entry {
        var time: Substring?
        var level: Level = .info
        var letter: String?
        var tag: Substring?
        var message: Substring
    }

    static func parse(_ line: Substring) -> Entry {
        let lvl = level(line)
        // logcat threadtime: "11-04 20:50:24.134  670  707 D ActivityManager: message"
        let f = line.split(separator: " ", maxSplits: 5, omittingEmptySubsequences: true)
        if f.count == 6, f[0].count == 5, f[0].dropFirst(2).first == "-", f[4].count == 1 {
            let rest = f[5]
            if let r = rest.range(of: ": ") {
                let tag = rest[..<r.lowerBound].trimmingCharacters(in: .whitespaces)
                return Entry(time: f[1], level: lvl, letter: String(f[4]), tag: Substring(tag), message: rest[r.upperBound...])
            }
            return Entry(time: f[1], level: lvl, letter: String(f[4]), message: rest)
        }
        // log show --style compact: "2026-11-04 21:02:25.284 E  SpringBoard[34924:5d0a3] message"
        let g = line.split(separator: " ", maxSplits: 4, omittingEmptySubsequences: true)
        if g.count >= 4, g[0].count == 10, g[0].dropFirst(4).first == "-" {
            let process = g[3].split(separator: "[", maxSplits: 1).first ?? g[3]
            let letter: String
            switch g[2] {
            case "E": letter = "E"
            case "F", "Fa": letter = "F"
            case "Db", "D": letter = "D"
            default: letter = "I"   // Df (default) and I (info)
            }
            return Entry(time: g[1], level: lvl, letter: letter, tag: process, message: g.count > 4 ? g[4] : "")
        }
        return Entry(level: lvl, message: line)
    }

    /// The lines as the Logs tab shows them: "20:50:24.134 D ActivityManager: message", wrapped with the message
    /// continuing under the tag. pid and tid (and the date) are left out; Copy Logs copies the lines as they came.
    static func display(_ text: String, font: NSFont) -> NSAttributedString {
        let out = NSMutableAttributedString()
        let bold = NSFontManager.shared.convert(font, toHaveTrait: .boldFontMask)
        let charWidth = ("0" as NSString).size(withAttributes: [.font: font]).width
        let secondary = NSColor(Theme.Ink.secondary)
        for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
            let e = parse(line)
            let color = NSColor(self.color(e.level))
            let para = NSMutableParagraphStyle()
            para.lineBreakMode = .byWordWrapping
            para.paragraphSpacing = 2
            var prefix = 0
            if let t = e.time {
                out.append(NSAttributedString(string: t + " ", attributes: [.font: font, .foregroundColor: secondary, .paragraphStyle: para]))
                prefix += t.count + 1
            }
            if let l = e.letter {
                out.append(NSAttributedString(string: l + " ", attributes: [.font: bold, .foregroundColor: color, .paragraphStyle: para]))
                prefix += l.count + 1
            }
            para.headIndent = CGFloat(prefix) * charWidth
            if let tag = e.tag, !tag.isEmpty {
                out.append(NSAttributedString(string: tag + ": ", attributes: [.font: font, .foregroundColor: secondary, .paragraphStyle: para]))
            }
            out.append(NSAttributedString(string: e.message + "\n", attributes: [.font: font, .foregroundColor: color, .paragraphStyle: para]))
        }
        return out
    }
}

/// The log well: selectable, wrapping text (the message continues under the tag), scrolled to the newest line.
/// An NSTextView because SwiftUI's Text can't indent wrapped lines or select across thousands of them quickly.
struct LogTextView: NSViewRepresentable {
    let text: String
    var dimmed = false

    final class Coordinator { var shown: String? }
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        scroll.drawsBackground = false
        scroll.hasHorizontalScroller = false
        scroll.autohidesScrollers = true
        if let tv = scroll.documentView as? NSTextView {
            tv.isEditable = false
            tv.isSelectable = true
            tv.drawsBackground = false
            tv.isRichText = false
            tv.textContainerInset = NSSize(width: Theme.Space.s, height: Theme.Space.l)
            tv.textContainer?.widthTracksTextView = true
            tv.setAccessibilityLabel("Log lines")
        }
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let tv = scroll.documentView as? NSTextView else { return }
        tv.alphaValue = dimmed ? 0.5 : 1   // a new filter or scope is loading: the old lines stay, faded
        // Appearance changes recolour the text: build it again then too.
        let key = text + "|" + (scroll.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua])?.rawValue ?? "")
        guard context.coordinator.shown != key else { return }
        context.coordinator.shown = key
        var styled = NSAttributedString()
        scroll.effectiveAppearance.performAsCurrentDrawingAppearance {
            styled = LogLevels.display(text, font: .monospacedSystemFont(ofSize: 11, weight: .regular))
        }
        tv.textStorage?.setAttributedString(styled)
        tv.scrollToEndOfDocument(nil)
    }
}

struct LogsTab: View {
    @Environment(AppModel.self) private var model
    let device: Device
    @AppStorage("inspector.logs.lines") private var lineCount = 300
    @State private var text = ""
    @State private var filter = ""
    @State private var appliedFilter = ""
    @State private var state: LoadState = .idle
    @State private var scope: LogScope
    /// The scope chosen per device, so switching tabs (or devices) and coming back keeps it for this session.
    private static var rememberedScopes: [String: LogScope] = [:]

    init(device: Device) {
        self.device = device
        _scope = State(initialValue: Self.rememberedScopes[device.id] ?? .all)
    }
    /// The app the last load showed, for "App in Front" (nil: the home screen, or not known).
    @State private var scopedApp: AppInfo?
    @State private var apps: [AppInfo] = []

    private enum LoadState: Equatable { case idle, loading, loaded, failed(FriendlyError) }

    var body: some View {
        VStack(spacing: 0) {
            SectionHeader("Logs") {
                if state == .loading && !text.isEmpty { ProgressView().controlSize(.mini) }
                scopeMenu
                Button { Task { await load() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                    .labelStyle(.iconOnly)
                    .help("Refresh")
                    .disabled(!device.can("logs") || state == .loading)
                Menu {
                    Picker("Lines", selection: $lineCount) {
                        ForEach([100, 300, 1000, 3000], id: \.self) { n in Text("Last \(n) Lines").tag(n) }
                    }
                    .pickerStyle(.inline)
                    Divider()
                    Button("Copy Logs") { Pasteboard.copy(text) }.disabled(text.isEmpty)
                } label: { Image(systemName: "ellipsis.circle") }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .help("More")
                    .accessibilityLabel("More")
                    .disabled(!device.can("logs"))
            }
            if device.can("logs") {
                InspectorField(prompt: "Filter", text: $filter, symbol: "line.3.horizontal.decrease.circle") { Task { await load() } }
            }
            content
        }
        .task(id: "\(device.id)|\(device.isRunning)|\(lineCount)|\(scope)|\(filter.trimmingCharacters(in: .whitespaces))") {
            // Typing applies as you go: wait for a pause, then load. Everything else loads straight away.
            if filter.trimmingCharacters(in: .whitespaces) != appliedFilter {
                try? await Task.sleep(for: .milliseconds(300))
                if Task.isCancelled { return }
            }
            await load()
        }
        .task(id: device.id) { await loadApps() }
        .onChange(of: scope) { Self.rememberedScopes[device.id] = scope }
        .onAppear {
            guard SelfTest.enabled else { return }
            let s = $scope
            SelfTest.setLogScope = { v in
                s.wrappedValue = v == "all" ? .all : v == "front" ? .front : .app(id: v, name: v)
            }
        }
    }

    /// All Apps, the app in front, or one installed app (not system apps).
    private var scopeMenu: some View {
        Menu {
            Picker("Show", selection: $scope) {
                Text("All Apps").tag(LogScope.all)
                Text("App in Front").tag(LogScope.front)
            }
            .pickerStyle(.inline)
            if !apps.isEmpty {
                Section("Installed Apps") {
                    Picker("App", selection: $scope) {
                        ForEach(apps) { a in Text(a.name ?? a.id).tag(LogScope.app(id: a.id, name: a.name ?? a.id)) }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                }
            }
        } label: {
            Text(scopeTitle).lineLimit(1).truncationMode(.middle).frame(maxWidth: 120)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help(scopeHelp)
        .accessibilityLabel("Show logs from")
        .accessibilityValue(scopeTitle)
        .disabled(!device.can("logs"))
        .testAnchor("Log app")
    }

    private var scopeTitle: String {
        if scope == .front, let a = scopedApp { return a.name ?? a.id }
        return scope.title
    }

    private var scopeHelp: String {
        switch scope {
        case .all: return "Showing every app. Choose one app, or the app in front."
        case .front: return scopedApp.map { "Showing \($0.name ?? $0.id), the app in front" } ?? "Showing the app in front"
        case .app(let id, _): return "Showing \(id)"
        }
    }

    @ViewBuilder private var content: some View {
        if !device.can("logs") {
            InspectorMessage(title: "Logs aren’t available for this device")
        } else if !device.isRunning {   // a normal state, as in the other tabs, not a failure to report
            InspectorMessage(title: "Start the device to see its logs.")
        } else if case .failed(let p) = state {
            ScrollView { ProblemView(problem: p, retry: { Task { await load() } }).padding(Theme.Space.l) }
        } else if text.isEmpty {
            if state == .loading || state == .idle { DelayedSpinner() }
            else if !appliedFilter.isEmpty { InspectorMessage(title: "No lines match “\(appliedFilter)”") }
            else if scope == .front && scopedApp == nil { InspectorMessage(title: "No app in front", message: "The Home Screen is showing.") }
            else if scope != .all { InspectorMessage(title: "No logs from \(scopeTitle) yet") }
            else { InspectorMessage(title: "No logs yet") }
        } else {
            // Time, level, tag, then the message, wrapped under the tag; the newest line at the bottom.
            LogTextView(text: text, dimmed: state == .loading)
                .background(Theme.Surface.content)
            .overlay(alignment: .top) { Divider() }   // the log well starts at a hairline, as in Xcode's console
        }
    }

    private func load() async {
        guard device.can("logs"), let c = model.client else { return }
        guard device.isRunning else { text = ""; state = .idle; return }
        state = .loading
        let f = filter.trimmingCharacters(in: .whitespaces)
        var q = ["lines": String(lineCount)]
        if !f.isEmpty { q["filter"] = f }
        do {
            switch scope {
            case .all: scopedApp = nil
            case .app(let id, let name): scopedApp = AppInfo(id: id, name: name)
            case .front:
                struct Front: Decodable { var app: AppInfo? }
                scopedApp = try? await c.get(Front.self, c.dev(device.id, "/foreground"), timeout: 15).app
                guard scopedApp != nil else { text = ""; appliedFilter = f; state = .loaded; return }
            }
            if let a = scopedApp { q["app"] = a.id }
            let t = try await c.text(c.dev(device.id, "/logs"), query: q)
            text = t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "" : t
            appliedFilter = f
            state = .loaded
        } catch {
            state = .failed(FriendlyError.from(error, title: "Couldn’t load logs", device: device))
        }
    }

    private func loadApps() async {
        guard device.can("logs"), device.isRunning, let c = model.client else { return }
        let list = (try? await c.get([AppInfo].self, c.dev(device.id, "/apps"), timeout: 30)) ?? []
        apps = list.filter { $0.system != true }.sorted { ($0.name ?? $0.id).localizedStandardCompare($1.name ?? $1.id) == .orderedAscending }
    }
}

// MARK: - Activity

/// One action-log entry, prepared once per load: who did it, what (as a sentence) and when.
struct ActivityItem: Identifiable, Equatable {
    let id: Int
    let owner: String?
    let human: Bool
    let sentence: String
    /// Control, help-request and milestone events (snapshots, start and shut down) carry a glyph in the gutter;
    /// taps, typing and the like don't.
    var mark: ActivitySentence.Mark? = nil
    let time: String?
    let raw: String
}

/// Consecutive entries by the same actor.
struct ActivityGroup: Identifiable, Equatable {
    let id: Int
    let actor: String
    let human: Bool
    var items: [ActivityItem]

    /// `sparkles` means an agent and nothing else: you, Terminal, scripts and PhoneDock itself get their own glyph.
    var symbol: String {
        if human { return "person.fill" }
        let owner = items.first?.owner ?? ""
        if owner == "daemon" { return "gearshape.fill" }
        if owner.hasPrefix("cli:") { return "terminal" }
        if owner.hasPrefix("sdk:") { return "curlybraces" }
        return "sparkles"
    }

    var tint: Color {
        switch symbol {
        case "person.fill": return Theme.Status.human
        case "sparkles": return Theme.Status.agent
        default: return Theme.Ink.secondary
        }
    }

    /// "You", "Claude Code", "Terminal", or "PhoneDock" for what the service did on its own (expiry, timeouts).
    static func actor(_ owner: String?, human: Bool) -> String {
        if human { return "You" }
        if owner == "daemon" { return "PhoneDock" }
        return OwnerName.display(owner)
    }
}

enum ActivitySentence {
    private static let keys: [String: String] = [
        "home": "Home", "back": "Back", "enter": "Return", "delete": "Delete", "tab": "Tab", "escape": "Escape",
        "space": "Space", "up": "Up Arrow", "down": "Down Arrow", "left": "Left Arrow", "right": "Right Arrow",
        "volume_up": "Volume Up", "volume_down": "Volume Down", "power": "Power", "lock": "Lock",
        "app_switch": "App Switcher", "menu": "Menu", "search": "Search", "siri": "Siri", "screenshot": "Screenshot",
    ]

    private static func quoted(_ s: String, max: Int = 40) -> String {
        let t = s.count > max ? String(s.prefix(max - 1)) + "…" : s
        return "“\(t)”"
    }

    private static func num(_ v: JSONValue?) -> String? {
        if case .number(let n)? = v { return String(Int(n.rounded())) }
        return v?.stringValue
    }

    /// The gutter glyph for control and help-request events.
    struct Mark: Equatable {
        let symbol: String
        let tint: Color
    }

    /// Control changes and help requests: who took or gave back the device, and how a request for help went.
    /// `previousOwner`, `to` and the like are owner ids ("mcp:claude-code:70691"), shown by name.
    static func control(_ entry: JSONValue) -> (sentence: String, mark: Mark)? {
        guard let a = entry["action"], let kind = a["action"]?.stringValue else { return nil }
        let owner = entry["owner"]?.stringValue
        let byPerson = owner == nil || owner == AppIdentity.owner
        func name(_ key: String) -> String? { a[key]?.stringValue.map { OwnerName.display($0) } }
        func text(_ key: String) -> String? { a[key]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } }
        let agent = Theme.Status.agent, human = Theme.Status.human, quiet = Theme.Ink.secondary
        switch kind {
        case "handoff.requested":
            return (text("reason").map { "Asked for help: \(quoted($0, max: 80))" } ?? "Asked for help",
                    Mark(symbol: "hand.raised.fill", tint: Theme.Status.handoff))
        case "handoff.done":
            return (text("note").map { "Answered Done: \(quoted($0, max: 80))" } ?? "Answered Done",
                    Mark(symbol: "checkmark.circle.fill", tint: Theme.Status.running))
        case "handoff.cancelled":
            if byPerson {
                return (text("reason").map { "Answered Can’t Do It: \(quoted($0, max: 80))" } ?? "Answered Can’t Do It",
                        Mark(symbol: "xmark.circle.fill", tint: Theme.Status.error))
            }
            return ("Withdrew the request for help", Mark(symbol: "hand.raised.slash", tint: quiet))
        case "handoff.timeout":
            return ("The request for help timed out", Mark(symbol: "clock.badge.exclamationmark", tint: Theme.Status.handoff))
        case "lease.take_over":
            return (name("previousOwner").map { "Took over from \($0)" } ?? "Took over",
                    Mark(symbol: "hand.point.up.left.fill", tint: human))
        case "lease.hand_back":
            if let back = name("returnedTo") {
                return ("Handed back to \(back)", Mark(symbol: "arrow.uturn.backward", tint: human))
            }
            if let gone = name("previousAgent") {
                return ("Handed back: \(gone) has quit, so the phone is free", Mark(symbol: "arrow.uturn.backward", tint: human))
            }
            return (name("previousOwner").map { "Handed back to \($0)" } ?? "Handed back control",
                    Mark(symbol: "arrow.uturn.backward", tint: human))
        case "lease.returned":
            return (name("to").map { "Gave control back to \($0)" } ?? "Gave control back",
                    Mark(symbol: "arrow.uturn.backward", tint: quiet))
        case "lease.reclaim":
            let prev = name("previousOwner")
            let quit = text("reason")?.contains("exited") == true
            return (prev.map { quit ? "Took control from \($0), which had quit" : "Took control from \($0)" } ?? "Took control",
                    Mark(symbol: "arrow.triangle.2.circlepath", tint: byPerson ? human : agent))
        case "lease.expired":
            return (name("previousOwner").map { "\($0)’s control ended after a period of no activity" } ?? "Control ended after a period of no activity",
                    Mark(symbol: "clock", tint: quiet))
        case "lease.acquire":
            return ("Took control", Mark(symbol: "lock.fill", tint: byPerson ? human : agent))
        case "lease.release":
            return ("Let go of the device", Mark(symbol: "lock.open", tint: quiet))
        default:
            return nil
        }
    }

    /// Snapshots and the device starting, stopping or restarting: the few device actions worth spotting in a long list.
    static func milestone(_ entry: JSONValue) -> Mark? {
        guard let kind = entry["action"]?["action"]?.stringValue else { return nil }
        let quiet = Theme.Ink.secondary
        if kind.hasSuffix("_failed"), kind.hasPrefix("snapshot.") || kind.hasPrefix("device.") {
            return Mark(symbol: "exclamationmark.triangle.fill", tint: Theme.Status.error)
        }
        switch kind {
        case "snapshot.save": return Mark(symbol: "square.and.arrow.down", tint: quiet)
        case "snapshot.restore": return Mark(symbol: "clock.arrow.circlepath", tint: quiet)
        case "device.start", "device.shutdown": return Mark(symbol: "power", tint: quiet)
        case "device.restart": return Mark(symbol: "arrow.clockwise", tint: quiet)
        case "device.crashed", "device.disconnected": return Mark(symbol: "exclamationmark.triangle.fill", tint: Theme.Status.error)
        default: return nil
        }
    }

    /// "Tapped “Settings”", "Typed “hello”", "Pressed Home", "Swiped up", "Took over from Claude Code".
    static func make(_ entry: JSONValue) -> String {
        if let c = control(entry) { return c.sentence }
        guard let a = entry["action"] else { return "Did something" }
        let kind = a["action"]?.stringValue ?? a["type"]?.stringValue ?? "action"
        // What the tap was aimed at: the element a ref resolved to, or the label the tap sent along.
        let el = entry["resolved"]?["element"]
        let target = [el?["text"], el?["label"], a["label"], entry["label"]].lazy.compactMap { $0?.stringValue }.first { !$0.isEmpty }
        let at: String = {
            if let w = entry["where"]?.stringValue { return w }
            if let x = num(a["x"]), let y = num(a["y"]) { return "at \(x), \(y)" }
            if let r = a["ref"]?.stringValue { return "element \(r)" }
            return ""
        }()
        func on(_ verb: String) -> String { target.map { "\(verb) \(quoted($0))" } ?? (at.isEmpty ? verb : "\(verb) \(at)") }
        let app = a["appId"]?.stringValue ?? "an app"
        switch kind {
        case "tap": return on("Tapped")
        case "longPress": return on("Long-pressed")
        case "doubleTap": return on("Double-tapped")
        case "pinch":
            if case .number(let s)? = a["scale"] { return s < 1 ? on("Pinched in") : on("Zoomed in") }
            return on("Pinched")
        case "swipe":
            guard case .number(let x1)? = a["x1"], case .number(let y1)? = a["y1"],
                  case .number(let x2)? = a["x2"], case .number(let y2)? = a["y2"] else { return "Swiped" }
            let dx = x2 - x1, dy = y2 - y1
            let dir = abs(dx) > abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up")
            return entry["via"]?.stringValue == "scroll-to" ? "Scrolled \(dir == "up" ? "down" : dir == "down" ? "up" : dir)" : "Swiped \(dir)"
        case "type":
            if case .bool(true)? = a["secret"] { return "Typed a password" }
            let t = a["text"]?.stringValue ?? ""
            return t.hasPrefix("•••") ? "Typed a password" : "Typed \(quoted(t))"
        case "key":
            let k = a["key"]?.stringValue ?? "a key"
            return "Pressed \(keys[k.lowercased()] ?? k)"
        case "gesture":
            switch a["gesture"]?.stringValue {
            case "go_home": return "Went to the Home Screen"
            case "app_switcher": return "Opened the App Switcher"
            case "control_center": return "Opened Control Center"
            case "notification_center": return "Opened notifications"
            case let g?: return "Gestured \(g.replacingOccurrences(of: "_", with: " "))"
            default: return "Gestured"
            }
        case "launch": return "Opened \(app)"
        case "terminate": return "Stopped \(app)"
        case "install":
            let p = a["path"]?.stringValue ?? a["url"]?.stringValue
            return p.map { "Installed \(quoted(($0 as NSString).lastPathComponent))" } ?? "Installed an app"
        case "uninstall": return "Uninstalled \(app)"
        case "openUrl":
            let u = a["url"]?.stringValue
            return u.flatMap { URL(string: $0)?.host }.map { "Opened a link to \($0)" } ?? "Opened a link"
        case "shell": return "Ran a shell command"
        case "push": return "Copied a file to the device"
        case "location": return "Set the location"
        case "rotate":
            if let kept = a["stayed"]?.stringValue { return "Stayed in \(kept): the app on screen doesn’t rotate" }
            return "Rotated to \(a["orientation"]?.stringValue ?? "a new orientation")"
        case "snapshot.save": return "Saved snapshot \(quoted(a["name"]?.stringValue ?? ""))"
        case "snapshot.restore": return "Restored snapshot \(quoted(a["name"]?.stringValue ?? ""))"
        case "snapshot.save_failed": return "Couldn’t save snapshot \(quoted(a["name"]?.stringValue ?? "")): \(a["error"]?.stringValue ?? "it failed")"
        case "snapshot.restore_failed": return "Couldn’t restore snapshot \(quoted(a["name"]?.stringValue ?? "")): \(a["error"]?.stringValue ?? "it failed")"
        case "device.start": return "Started the device"
        case "device.start_failed": return "Couldn’t start the device: \(a["error"]?.stringValue ?? "it failed")"
        case "device.shutdown": return "Shut the device down"
        case "device.shutdown_failed": return "Couldn’t shut the device down: \(a["error"]?.stringValue ?? "it failed")"
        case "device.restart": return "Restarted the device"
        case "device.restart_failed": return "Couldn’t restart the device: \(a["error"]?.stringValue ?? "it failed")"
        case "device.crashed": return a["summary"]?.stringValue ?? "The device stopped unexpectedly"
        case "device.disconnected": return a["summary"]?.stringValue ?? "The device disconnected"
        case "appData.export": return "Saved app data for \(app)"
        case "appData.import": return "Restored app data for \(app)"
        case "trace.start": return "Started a performance trace of \(app)"
        case "trace.stop":
            if let s = a["summary"]?.stringValue, !s.isEmpty { return "Stopped the performance trace of \(app): \(s)" }
            return "Stopped the performance trace of \(app)"
        case "trace.start_failed": return "Couldn’t start a performance trace of \(app): \(a["error"]?.stringValue ?? "it failed")"
        case "trace.stop_failed": return "Couldn’t finish the performance trace of \(app): \(a["error"]?.stringValue ?? "it failed")"
        default:
            let words = kind.replacingOccurrences(of: ".", with: " ").replacingOccurrences(of: "_", with: " ")
            return words.prefix(1).uppercased() + words.dropFirst()
        }
    }
}

struct ActivityTab: View {
    @Environment(AppModel.self) private var model
    let device: Device
    @State private var groups: [ActivityGroup] = []
    @State private var state: LoadState = .idle

    private enum LoadState: Equatable { case idle, loaded, failed(FriendlyError) }

    var body: some View {
        VStack(spacing: 0) {
            SectionHeader("Activity")
            content
        }
        .task(id: device.id) {
            // Refresh when an action happens (SSE), with a slow poll as a fallback. Stops when the tab is hidden.
            await load()
            let actions = NotificationCenter.default.notifications(named: .phoneDockAction)
            await withTaskGroup(of: Void.self) { g in
                g.addTask { @MainActor in
                    for await _ in actions { await load() }
                }
                g.addTask { @MainActor in
                    while !Task.isCancelled {
                        try? await Task.sleep(for: .seconds(5))
                        await load()
                    }
                }
            }
        }
    }

    @ViewBuilder private var content: some View {
        if case .failed(let p) = state, groups.isEmpty {
            ScrollView { ProblemView(problem: p, retry: { Task { await load() } }).padding(Theme.Space.l) }
        } else if groups.isEmpty {
            if state == .idle { DelayedSpinner() } else { InspectorMessage(title: "No activity yet") }
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(groups) { g in
                        Label {
                            Text(g.actor)
                        } icon: {
                            Image(systemName: g.symbol)
                                .foregroundStyle(g.tint)
                        }
                        .font(Theme.Fonts.headline)
                        .foregroundStyle(Theme.Ink.primary)
                        .padding(.top, g.id == groups.first?.id ? Theme.Space.xs : Theme.Space.l)
                        .padding(.bottom, Theme.Space.xs)
                        .accessibilityAddTraits(.isHeader)
                        ForEach(g.items) { item in
                            HStack(alignment: .firstTextBaseline, spacing: Theme.Space.m) {
                                Text(item.sentence).font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.primary).lineLimit(2)
                                    .help(item.sentence)
                                Spacer(minLength: Theme.Space.s)
                                if let t = item.time {
                                    Text(t).font(Theme.Fonts.meta.monospacedDigit()).foregroundStyle(Theme.Ink.secondary)
                                }
                            }
                            .padding(.leading, 22)
                            // Control, help and milestone events get their glyph in the gutter, under the actor's.
                            .overlay(alignment: .topLeading) {
                                if let m = item.mark {
                                    Image(systemName: m.symbol)
                                        .font(.system(size: 10, weight: .semibold))
                                        .foregroundStyle(m.tint)
                                        .frame(width: 16, height: 16)
                                        .accessibilityHidden(true)
                                }
                            }
                            .padding(.vertical, 3)
                            .contentShape(Rectangle())
                            .contextMenu { Button("Copy Details") { Pasteboard.copy(item.raw) } }
                            .accessibilityElement(children: .combine)
                        }
                    }
                }
                .padding(.horizontal, Theme.Space.l)
                .padding(.bottom, Theme.Space.l)
            }
        }
    }

    private static let timeFormat: DateFormatter = {
        let f = DateFormatter(); f.dateStyle = .none; f.timeStyle = .short; return f
    }()

    private func load() async {
        guard let c = model.client else { return }
        do {
            let entries = try await c.get([JSONValue].self, c.dev(device.id, "/actions"), query: ["limit": "200"])
            let next = Self.group(entries)
            if next != groups { groups = next }
            state = .loaded
        } catch {
            if groups.isEmpty { state = .failed(FriendlyError.from(error, title: "Couldn’t load activity", device: device)) }
        }
    }

    /// Newest first; consecutive entries by the same actor share a header.
    static func group(_ entries: [JSONValue]) -> [ActivityGroup] {
        var out: [ActivityGroup] = []
        for (i, e) in entries.enumerated().reversed() {
            let owner = e["owner"]?.stringValue
            let human = owner == nil || owner == AppIdentity.owner
            let time = e["at"]?.stringValue.flatMap(ISO8601DateFormatter.flexible).map { timeFormat.string(from: $0) }
            let item = ActivityItem(id: i, owner: owner, human: human, sentence: ActivitySentence.make(e),
                                    mark: ActivitySentence.control(e)?.mark ?? ActivitySentence.milestone(e), time: time,
                                    raw: ((e["action"].map { [$0.description] } ?? []) + [owner ?? "", e["at"]?.stringValue ?? ""]).joined(separator: " · "))
            if var last = out.last, last.items.first?.owner == owner {
                last.items.append(item)
                out[out.count - 1] = last
            } else {
                out.append(ActivityGroup(id: i, actor: ActivityGroup.actor(owner, human: human), human: human, items: [item]))
            }
        }
        return out
    }
}
