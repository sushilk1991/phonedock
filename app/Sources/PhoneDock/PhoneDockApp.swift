import SwiftUI
import AppKit
import ServiceManagement

/// One app instance per daemon port: an exclusive flock on `$PHONEDOCK_HOME/app-<port>.lock` (holding our pid).
/// A second launch on the same port activates the first instance and exits. Different ports run side by side.
enum SingleInstance {
    private static var fd: Int32 = -1

    /// Self-tests may run two apps on one daemon (a design critic and a user test side by side):
    /// `PHONEDOCK_APP_SELFTEST_INSTANCE=<name>` gives each its own lock.
    static var lockPath: String {
        let instance = SelfTest.enabled ? (ProcessInfo.processInfo.environment["PHONEDOCK_APP_SELFTEST_INSTANCE"] ?? "") : ""
        return DaemonLocator.home.appendingPathComponent("app-\(DaemonLocator.port)\(instance.isEmpty ? "" : "-" + instance).lock").path
    }

    /// False when another instance holds the lock (it has been asked to come forward).
    static func acquire() -> Bool {
        try? FileManager.default.createDirectory(at: DaemonLocator.home, withIntermediateDirectories: true)
        let f = open(lockPath, O_RDWR | O_CREAT, 0o644)
        guard f >= 0 else { return true }   // can't create the lock file: don't block launching
        if flock(f, LOCK_EX | LOCK_NB) != 0 {
            var buf = [UInt8](repeating: 0, count: 32)
            let n = read(f, &buf, 31)
            close(f)
            let pid = n > 0 ? pid_t(String(decoding: buf[0..<n], as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)) : nil
            FileHandle.standardError.write(Data("PhoneDock is already running for port \(DaemonLocator.port) (pid \(pid.map(String.init) ?? "?")); activating it.\n".utf8))
            // A background self-test never brings anything forward, not even the other instance.
            if !SelfTest.background, let pid, let other = NSRunningApplication(processIdentifier: pid) { other.activate(options: [.activateAllWindows]) }
            return false
        }
        ftruncate(f, 0)
        let s = "\(getpid())\n"
        _ = s.withCString { write(f, $0, strlen($0)) }
        fd = f   // keep it open (and locked) for the life of the process
        return true
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationWillFinishLaunching(_ notification: Notification) {
        if !SingleInstance.acquire() { exit(0) }
        ActiveLook.installIfRequested()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        if NSApp.applicationIconImage == nil || !DaemonLocator.isBundled, let icon = AppIcon.render(size: 512) {
            NSApp.applicationIconImage = icon
        }
        if !SelfTest.background { NSApp.activate(ignoringOtherApps: true) }   // self-tests stay behind the user's work
        MenuTidy.start()
        FirstClick.install()
        UpdateController.shared.start()   // auto-update: UpdateController.swift
    }
    func applicationWillTerminate(_ notification: Notification) { SeparateWindows.closeAll() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

/// A click on a PhoneDock window that isn't the key window used to be spent on making it key: Take Over, Hand Back,
/// a sidebar row or an inspector tab then needed a second click. Make the window key as the click arrives, so the
/// same click goes through. (Synthesized self-test events skip this path; they go straight to the window.)
@MainActor
enum FirstClick {
    private static var monitor: Any?
    static func install() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { event in
            if let w = event.window, !w.isKeyWindow, w.canBecomeKey, w.attachedSheet == nil, !(w is NSPanel) { w.makeKey() }
            return event
        }
    }
}

/// SwiftUI leaves an empty section in the Window menu (our single `Window` scene adds no window-list item), which
/// shows as two separators in a row. Hide any separator that follows another one, or starts or ends the menu,
/// whenever the menu changes or the menu bar opens.
@MainActor
enum MenuTidy {
    static func start() {
        let nc = NotificationCenter.default
        for name in [NSMenu.didAddItemNotification, NSMenu.didBeginTrackingNotification] {
            nc.addObserver(forName: name, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { tidy(NSApp.windowsMenu) }
            }
        }
        DispatchQueue.main.async { tidy(NSApp.windowsMenu) }
    }

    static func tidy(_ menu: NSMenu?) {
        guard let menu else { return }
        var lastVisibleIsSeparator = true   // a separator at the top is hidden too
        var lastSeparator: NSMenuItem?
        for item in menu.items {
            if item.isSeparatorItem {
                let hide = lastVisibleIsSeparator
                if item.isHidden != hide { item.isHidden = hide }
                if !hide { lastVisibleIsSeparator = true; lastSeparator = item }
            } else if !item.isHidden {
                lastVisibleIsSeparator = false
                lastSeparator = nil
            }
        }
        if let lastSeparator, lastVisibleIsSeparator { lastSeparator.isHidden = true }   // nothing after it
    }
}

/// UserDefaults keys owned by the window chrome.
enum Prefs {
    static let discoveredCollapsed = "sidebar.discoveredCollapsed"
    /// Read by HandoffNotifier: post a notification when an agent asks for help (default on).
    static let notifyOnHandoff = "notifyOnHandoff"
    static let settingsTab = "settings.tab"
    static let agentClient = "agentSetup.client"
}

@main
struct PhoneDockApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @State private var model = AppModel()

    var body: some Scene {
        Window("PhoneDock", id: "main") {
            ContentView()
                .environment(model)
                .frame(minWidth: 960, minHeight: 640)
                .tint(Theme.Accent.fill)
                .selfTestLinkGuard()
                .onAppear { model.start() }
        }
        .defaultSize(width: 1280, height: 840)
        .commands { PhoneDockCommands(model: model) }

        Settings {
            SettingsView()
                .environment(model)
                .tint(Theme.Accent.fill)
                .selfTestLinkGuard()
        }
    }
}

// MARK: - Menus

struct PhoneDockCommands: Commands {
    let model: AppModel

    var body: some Commands {
        CommandGroup(after: .appInfo) { CheckForUpdatesMenuItem() }   // UpdatesSettingsSection.swift
        CommandGroup(replacing: .sidebar) {
            Button(model.sidebarVisible ? "Hide Sidebar" : "Show Sidebar") { model.sidebarVisible.toggle() }
                .keyboardShortcut("s", modifiers: [.command, .control])
            Button(model.inspectorVisible ? "Hide Inspector" : "Show Inspector") { model.inspectorVisible.toggle() }
                .keyboardShortcut("i", modifiers: [.command, .control])
                .disabled(model.devices.isEmpty)
        }
        CommandGroup(replacing: .newItem) {
            Button("New Device…") { model.showCreate = true }
                .keyboardShortcut("n")
            Button("Connect a Phone…") { model.showConnect = true }
                .keyboardShortcut("k", modifiers: [.command, .shift])
            // The same three as the toolbar's ＋ menu.
            Button("Connect an Agent…") { model.showAgentSetup = true }
        }
        CommandMenu("Device") { DeviceMenuItems(model: model) }
        CommandGroup(replacing: .help) {
            Button("PhoneDock Help") { HelpLink.open(model) }
        }
    }
}

/// The Device menu: every toolbar and hardware-bar action, with Simulator's shortcuts where it has one.
struct DeviceMenuItems: View {
    let model: AppModel

    var body: some View {
        let d = model.selectedDevice
        let online = model.connection.isConnected
        // While a snapshot is saved or restored (or the device is deleted) the input actions are off too, like Shut Down.
        let running = online && d?.isRunning == true && d.map { model.busy[$0.id] == nil } == true
        let hw = d.map(HardwareSupport.init) ?? HardwareSupport()

        Button("Start") { if let d { model.boot(d) } }
            .disabled(!(online && d.map { DeviceActions.canStart($0, model) } == true))
            .modifierKeyAlternate(.option) {
                Button("Cold Boot") { if let d { model.boot(d, cold: true) } }
                    .disabled(!(online && d.map { DeviceActions.canStart($0, model) } == true))
            }
        Button("Shut Down") { if let d { model.shutdown(d) } }
            .disabled(!(running && d.map { DeviceActions.canShutDown($0, model) } == true))
        Divider()
        if let d, d.leasedByHuman {
            Button("Hand Back") { model.handBack(d) }
                .keyboardShortcut("t", modifiers: [.command, .option])
        } else {
            Button("Take Over") { if let d { model.takeOver(d) } }
                .keyboardShortcut("t", modifiers: [.command, .option])
                .disabled(!(online && d?.leasedByAgent == true))
        }
        // The help card's answers, from the keyboard. Can't Do It sends no reason here (the card's popover asks for one).
        let request = d.flatMap { model.pendingHandoff(for: $0.id) }
        Button("Answer Done") { if let request { Task { await model.resolveHandoff(request, done: true) } } }
            .keyboardShortcut("d", modifiers: [.command, .option])
            .disabled(!(online && request != nil))
        Button("Answer Can’t Do It") { if let request { Task { await model.resolveHandoff(request, done: false) } } }
            .keyboardShortcut(".", modifiers: [.command, .option])
            .disabled(!(online && request != nil))
        Divider()
        Button("Home") { press("home") }
            .keyboardShortcut("h", modifiers: [.command, .shift])
            .disabled(!(running && hw.home))
        Button("App Switcher") { press("app_switch") }
            .keyboardShortcut("h", modifiers: [.command, .shift, .control])
            .disabled(!(running && hw.appSwitcher))
        Button("Back") { press("back") }
            .keyboardShortcut("b", modifiers: [.command, .shift])
            .disabled(!(running && hw.back))
        Button("Lock") { press("lock") }
            .keyboardShortcut("l")
            .disabled(!(running && hw.lock))
        Button("Rotate") {
            // ⌘→ belongs to a text field while one is being edited.
            if KeyRouting.forwardToTextField(#selector(NSResponder.moveToEndOfLine(_:))) { return }
            if let d { model.rotate(d) }
        }
        .keyboardShortcut(.rightArrow)
        .disabled(!(running && hw.rotate))
        Button("Volume Up") {
            if KeyRouting.forwardToTextField(#selector(NSResponder.moveToBeginningOfDocument(_:))) { return }
            press("volume_up")
        }
        .keyboardShortcut(.upArrow)
        .disabled(!(running && hw.volume))
        Button("Volume Down") {
            if KeyRouting.forwardToTextField(#selector(NSResponder.moveToEndOfDocument(_:))) { return }
            press("volume_down")
        }
        .keyboardShortcut(.downArrow)
        .disabled(!(running && hw.volume))
        Divider()
        Button("Save Screenshot") { if let d { model.screenshot(d) } }
            .keyboardShortcut("s")
            .disabled(!(running && d?.can("screenshot") == true))
        if let d, model.recordings[d.id] != nil {
            Button("Stop Recording") { model.stopRecording(d) }
                .keyboardShortcut("r")
        } else {
            Button("Record Screen") { if let d { model.startRecording(d) } }
                .keyboardShortcut("r")
                .disabled(!(running && d.map { $0.can("record") && !model.recordingUnsupported.contains($0.id) } == true))
        }
        Button("Show Last Recording in Finder") {
            if let d, let r = model.savedRecordings[d.id], !SelfTest.blocksForeground("Show Last Recording in Finder \(r.path)") {
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: r.path)])
            }
        }
        .disabled(d.flatMap { model.savedRecordings[$0.id] } == nil)
        Button(d?.windowActionTitle ?? "Open in Separate Window") { if let d { model.openWindow(d) } }
            .disabled(!(running && d?.can("window") == true))
        Divider()
        Button("Reload Devices") { Task { await model.refresh() } }
            .keyboardShortcut("r", modifiers: [.command, .option])
            .disabled(!online)
        if let d, DeviceActions.canDelete(d) {
            Divider()
            Button("Delete…") {
                // ⌘⌫ belongs to a text field while one is being edited (delete to the start of the line).
                if KeyRouting.forwardToTextField(#selector(NSResponder.deleteToBeginningOfLine(_:))) { return }
                DeviceActions.confirmDelete(d, model)
            }
            .keyboardShortcut(.delete, modifiers: .command)
            .disabled(!online || DeviceActions.isBusy(d, model))
        }
    }

    private func press(_ key: String) {
        if let d = model.selectedDevice { model.key(d, key) }
    }
}

/// Menu shortcuts are matched before the focused view sees the key, so ⌘-arrows would steer the device even while
/// someone edits a search field. While a text view is first responder, send it the text command instead.
@MainActor
enum KeyRouting {
    static func forwardToTextField(_ command: Selector) -> Bool {
        guard let tv = NSApp.keyWindow?.firstResponder as? NSTextView, tv.isEditable else { return false }
        tv.doCommand(by: command)
        return true
    }
}

/// Shared device actions for the sidebar, toolbar and Device menu.
@MainActor
enum DeviceActions {
    /// A snapshot, restore or clone is running on it (`AppModel.busy`): no power changes and no Delete until it ends.
    static func isBusy(_ d: Device, _ model: AppModel) -> Bool { model.busy[d.id] != nil || model.pending[d.id] != nil }

    static func canStart(_ d: Device, _ model: AppModel) -> Bool {
        d.can("boot") && !d.isRunning && !["booting", "creating", "stopping"].contains(d.state) && !isBusy(d, model)
    }

    static func canShutDown(_ d: Device, _ model: AppModel) -> Bool {
        d.isRunning && d.can("shutdown") && !isBusy(d, model)
    }

    static func canDelete(_ d: Device) -> Bool { d.managed == true && d.can("delete") }

    static func copyID(_ d: Device) {
        Clipboard.copy(d.id)
    }

    /// The one delete confirmation. Cancel is the default button; Delete needs a click.
    static func confirmDelete(_ d: Device, _ model: AppModel) {
        let a = NSAlert()
        a.messageText = "Delete “\(DisplayText.unbroken(d.name))”?"
        a.informativeText = "This permanently deletes the device and everything on it."
        a.alertStyle = .warning
        let delete = a.addButton(withTitle: "Delete")
        delete.hasDestructiveAction = true
        delete.keyEquivalent = ""
        let cancel = a.addButton(withTitle: "Cancel")
        cancel.keyEquivalent = "\r"
        let handle: (NSApplication.ModalResponse) -> Void = { r in
            if r == .alertFirstButtonReturn { model.delete(d) }
        }
        // A sheet on the main window, even when PhoneDock isn't the front app (a context-menu click on a background
        // window); an app-modal alert only when that window already has a sheet.
        let main = NSApp.keyWindow ?? NSApp.mainWindow
            ?? NSApp.windows.first { $0.isVisible && $0.canBecomeMain && $0.identifier?.rawValue.contains("Settings") != true }
        if let w = main, w.attachedSheet == nil {
            a.beginSheetModal(for: w, completionHandler: handle)
        } else if !SelfTest.blocksForeground("app-modal Delete confirmation") {
            handle(a.runModal())
        }
    }
}

/// Help › PhoneDock Help opens the README that ships with the app (or the source checkout).
@MainActor
enum HelpLink {
    static func open(_ model: AppModel) {
        var candidates: [URL] = []
        if let r = Bundle.main.resourceURL {
            candidates += [r.appendingPathComponent("README.md"), r.appendingPathComponent("docs/README.md")]
        }
        candidates.append(URL(fileURLWithPath: DaemonLocator.repo).appendingPathComponent("README.md"))
        if let url = candidates.first(where: { FileManager.default.fileExists(atPath: $0.path) }) {
            if SelfTest.blocksForeground("open \(url.lastPathComponent)") { return }
            NSWorkspace.shared.open(url)
        } else {
            model.toast = Toast(kind: .info, title: "Help isn’t included in this build")
        }
    }
}

// MARK: - Root

struct ContentView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openSettings) private var openSettings
    @State private var columns: NavigationSplitViewVisibility = .all
    @State private var inspectorTab: InspectorTab = .initial
    @State private var highlight: CGRect?
    /// Once the app has reached the daemon, a lost connection reads as "Reconnecting…", not first launch.
    @State private var everConnected = false
    /// The detail column is too narrow for every toolbar item (minimum window with sidebar and inspector open).
    @State private var narrowDetail = false
    /// Where the stage wants toasts (above its hardware bar); nil: no bar on screen.
    @State private var toastLift: CGFloat?
    /// Below this detail width, Open in Separate Window (also in the Device menu and the sidebar's context menu)
    /// leaves the toolbar first, so ＋ never falls into the » overflow menu.
    static let narrowToolbarBelow: CGFloat = 470

    var body: some View {
        @Bindable var model = model
        NavigationSplitView(columnVisibility: $columns) {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 225, ideal: 250, max: 360)
                // The sidebar toggle sits at the trailing end of the sidebar's toolbar band (top right of the
                // sidebar, as in Mail and Notes), mirroring the inspector toggle at the top right of the inspector.
                // The system one would sit next to the traffic lights. With the sidebar hidden the system puts its
                // own toggle back at the leading end of the main toolbar, which is where it belongs then.
                .toolbar(removing: .sidebarToggle)
                .toolbar {
                    if #available(macOS 26.0, *) { ToolbarSpacer(.flexible) }
                    ToolbarItem(placement: .automatic) { sidebarToggle }
                }
        } detail: {
            detail
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Theme.Surface.stage)
                // A help request on another device shows in the stage's reserved top slot (never moving the
                // screen); with no device selected there's no stage, so a banner says it.
                .overlay(alignment: .top) { if model.selectedDevice == nil { HelpRequestBanner() } }
                .overlay(alignment: .bottom) {
                    // Never over the hardware bar: a running device's stage reports where the bar is and the toast
                    // sits 12 pt above it (spec §8.3); otherwise 20 pt above the bottom.
                    ToastHost(bottomInset: toastLift ?? Theme.Space.xxl)
                }
                .onPreferenceChange(ToastLiftKey.self) { toastLift = $0 }
                .navigationTitle(model.selectedDevice?.name ?? "PhoneDock")
                .navigationSubtitle(model.selectedDevice?.pdWindowSubtitle ?? "")
                .onGeometryChange(for: Bool.self) { $0.size.width < Self.narrowToolbarBelow } action: { narrowDetail = $0 }
        }
        // Nothing to inspect without devices: the empty state gets the whole window (the toggle comes back with them).
        .inspector(isPresented: Binding(get: { model.inspectorVisible && !model.devices.isEmpty }, set: { model.inspectorVisible = $0 })) {
            Group {
                if let d = model.selectedDevice {
                    InspectorView(device: d, tab: $inspectorTab, highlight: $highlight)
                } else {
                    Text("No Selection")
                        .font(Theme.Fonts.callout)
                        .foregroundStyle(Theme.Ink.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .inspectorColumnWidth(min: 280, ideal: 320, max: 420)
            // The inspector's own toolbar band holds its tabs and, at the trailing end (top right, as in Xcode), the
            // inspector toggle. That frees room in the content toolbar, which overflowed into » at the minimum
            // window width. With the inspector hidden the toggle is back at the end of the main toolbar.
            .toolbar {
                if model.inspectorVisible, !model.devices.isEmpty {
                    if model.selectedDevice != nil {
                        ToolbarItem(placement: .automatic) { InspectorTabPicker(tab: $inspectorTab) }
                    }
                    if #available(macOS 26.0, *) { ToolbarSpacer(.flexible) }
                    ToolbarItem(placement: .automatic) { inspectorToggle }
                }
            }
        }
        .toolbar { toolbar }
        .sheet(isPresented: $model.showCreate) { CreateDeviceSheet().environment(model) }
        .sheet(isPresented: $model.showConnect) { ConnectPhoneSheet().environment(model) }
        .sheet(isPresented: $model.showAgentSetup) { AgentSetupSheet() }
        .pdProblemAlert(model)
        .onChange(of: model.selection) { highlight = nil }
        .onChange(of: model.sidebarVisible) { _, v in columns = v ? .all : .detailOnly }
        .onChange(of: columns) { _, c in model.sidebarVisible = c != .detailOnly }
        .onChange(of: model.requestedInspectorTab) { _, t in
            guard let t else { return }
            inspectorTab = t; model.inspectorVisible = true; model.requestedInspectorTab = nil
        }
        .onChange(of: model.connection, initial: true) { if model.connection.isConnected { everConnected = true } }
        .background(WindowReader { w in
            SelfTest.model = model
            SelfTest.openSettings = { openSettings() }
            let highlightBinding = $highlight
            SelfTest.setHighlight = { highlightBinding.wrappedValue = $0 }
            let inspectorBinding = Binding(get: { model.inspectorVisible }, set: { model.inspectorVisible = $0 })
            SelfTest.setInspector = { inspectorBinding.wrappedValue = $0 }
            let tabBinding = $inspectorTab
            SelfTest.setInspectorTab = { tabBinding.wrappedValue = $0 }
            SelfTest.startIfRequested(window: w)
        })
    }

    // MARK: Toolbar

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        if let health = connectionHealth {
            ToolbarItem(placement: .status) { ConnectionPill(health: health) }
        }
        if let d = model.selectedDevice, model.connection.isConnected {
            ToolbarItemGroup(placement: .primaryAction) {
                DeviceToolbarActions(device: d, narrow: narrowDetail)
            }
        }
        if #available(macOS 26.0, *) {
            ToolbarSpacer(.fixed, placement: .primaryAction)
        }
        // Add lives at the foot of the sidebar (SidebarAddButton); with the sidebar hidden it's ＋ here.
        if !model.sidebarVisible {
            ToolbarItem(placement: .primaryAction) {
                Menu { AddMenuItems() } label: { Label("Add", systemImage: "plus") }
                    .help("New Device, Connect a Phone or Connect an Agent")
                    .testAnchor("Add menu")
            }
        }
        if !model.inspectorVisible, !model.devices.isEmpty {
            ToolbarItem(placement: .primaryAction) { inspectorToggle }
        }
    }

    private var sidebarToggle: some View {
        Button { model.sidebarVisible.toggle() } label: { Label(model.sidebarVisible ? "Hide Sidebar" : "Show Sidebar", systemImage: "sidebar.leading") }
            .help(model.sidebarVisible ? "Hide Sidebar (⌃⌘S)" : "Show Sidebar (⌃⌘S)")
    }

    private var inspectorToggle: some View {
        Button { model.inspectorVisible.toggle() } label: { Label(model.inspectorVisible ? "Hide Inspector" : "Show Inspector", systemImage: "sidebar.trailing") }
            .help(model.inspectorVisible ? "Hide Inspector (⌃⌘I)" : "Show Inspector (⌃⌘I)")
    }

    private var connectionHealth: ConnectionPill.Health? {
        switch model.connection {
        case .connected: return nil
        case .connecting: return everConnected ? .reconnecting : nil
        case .failed(let raw): return .failed(raw)
        }
    }

    // MARK: Detail

    @ViewBuilder private var detail: some View {
        if case .failed(let raw) = model.connection {
            ProblemView(problem: FriendlyError(title: "Can’t connect to PhoneDock", message: "Retrying automatically.", details: raw),
                        retry: { Task { await model.connect() } })
                .padding(Theme.Space.xxl)
                .testAnchor("daemon-problem")
        } else if !everConnected {
            StartingView()
        } else if let d = model.selectedDevice {
            DeviceDetailView(device: d, highlight: $highlight).id(d.id)
        } else if model.devices.isEmpty, let c = model.creating.first {
            VStack(spacing: Theme.Space.m) {
                ProgressView().controlSize(.small)
                Text("Creating \(c.name)…").font(Theme.Fonts.headline).foregroundStyle(Theme.Ink.primary)
                Text(c.stage).font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
            }
            .testAnchor("creating-detail")
        } else if model.devices.isEmpty {
            ContentUnavailableView {
                Label {
                    Text("No Devices Yet").foregroundStyle(Theme.Ink.primary)
                } icon: {
                    Image(systemName: "iphone.gen3")
                }
            } description: {
                Text("Create a virtual phone or connect your own. Your AI agents can use it right away.")
                    .foregroundStyle(Theme.Ink.secondary)
            } actions: {
                // First run, in order: what this Mac can run → a device → an agent (AgentSetup.swift).
                FirstRunGuide()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ContentUnavailableView("Select a Device", systemImage: "iphone.gen3")
        }
    }
}

/// App start: nothing for 600 ms, then a spinner; a reassurance line after 10 s.
private struct StartingView: View {
    @State private var visible = false
    @State private var slow = false

    var body: some View {
        VStack(spacing: Theme.Space.m) {
            if visible {
                ProgressView().controlSize(.small)
                Text("Starting PhoneDock…").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                if slow {
                    Text("This can take a moment the first time.").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task {
            try? await Task.sleep(for: .milliseconds(600))
            visible = true
            try? await Task.sleep(for: .seconds(9.4))
            slow = true
        }
    }
}

/// Toolbar device actions: Power ▾ · Screenshot · Record · Separate Window. Hidden when the device can't do them.
struct DeviceToolbarActions: View {
    @Environment(AppModel.self) private var model
    let device: Device
    /// A narrow detail column: leave out the least-used item rather than overflow into ».
    var narrow = false

    var body: some View {
        let running = device.isRunning
        if device.can("boot") || device.can("shutdown") {
            Menu {
                Button("Start") { model.boot(device) }
                    .disabled(!DeviceActions.canStart(device, model))
                    .modifierKeyAlternate(.option) {
                        Button("Cold Boot") { model.boot(device, cold: true) }
                            .disabled(!DeviceActions.canStart(device, model))
                    }
                Button("Shut Down") { model.shutdown(device) }
                    .disabled(!DeviceActions.canShutDown(device, model))
            } label: {
                Label("Power", systemImage: "power")
            }
            .help("Start or Shut Down")   // it opens a menu, so the tooltip names the menu, not one action
            .testAnchor("Power")
        }
        // While recording, the timer pill is wider than the Record button: in a narrow column Screenshot (also ⌘S and
        // the Device menu) makes room for it, so ＋ never falls into ».
        if device.can("screenshot"), !(narrow && model.recordings[device.id] != nil) {
            Button { model.screenshot(device) } label: { Label("Screenshot", systemImage: "camera") }
                .help("Save Screenshot (⌘S)")
                .disabled(!running)
                .testAnchor("Screenshot")
        }
        if running {
            // One per device: reused across devices, its "path changed" check would announce the other device's
            // last recording as just saved.
            RecordControl(device: device).id(device.id)
        } else if device.can("record"), !model.recordingUnsupported.contains(device.id) {
            // Off: shown disabled like Screenshot and the window button, so the toolbar keeps its shape when it starts.
            Button {} label: { Label("Record Screen", systemImage: "record.circle") }
                .help("Record Screen (⌘R)")
                .disabled(true)
        }
        if device.can("window"), !narrow {
            Button { model.openWindow(device) } label: { Label(device.windowActionTitle, systemImage: "macwindow.on.rectangle") }
                .help(device.windowActionHelp)
                .disabled(!running)
        }
    }
}

/// Shown in the toolbar only when the connection to the daemon is unhealthy.
struct ConnectionPill: View {
    enum Health: Equatable { case reconnecting, failed(String) }
    @Environment(AppModel.self) private var model
    let health: Health

    var body: some View {
        HStack(spacing: Theme.Space.s) {
            switch health {
            case .reconnecting:
                ProgressView().controlSize(.mini)
                Text("Reconnecting…").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
            case .failed:
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.Status.error).accessibilityHidden(true)
                Text("Can’t connect to PhoneDock").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.primary)
                Button("Try Again") { Task { await model.connect() } }.controlSize(.small)
            }
        }
        .lineLimit(1)
        .padding(.horizontal, Theme.Space.m)
        .fixedSize()
        .accessibilityElement(children: .contain)
        .testAnchor("connection-pill")
    }
}

/// Flashes the enclosing scroll view's scrollers once it's on screen, as AppKit does for a document that scrolls:
/// with overlay scrollbars that's the only sign a settings pane continues below the window.
struct ScrollerFlash: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { Flasher() }
    func updateNSView(_ nsView: NSView, context: Context) {}
    final class Flasher: NSView {
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard window != nil else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in self?.enclosingScrollView?.flashScrollers() }
        }
    }
}

/// Hands the hosting NSWindow to `onWindow` once the view is in a window.
struct WindowReader: NSViewRepresentable {
    let onWindow: (NSWindow) -> Void
    func makeNSView(context: Context) -> NSView { Reader(onWindow) }
    func updateNSView(_ nsView: NSView, context: Context) {}
    final class Reader: NSView {
        let onWindow: (NSWindow) -> Void
        init(_ f: @escaping (NSWindow) -> Void) { onWindow = f; super.init(frame: .zero) }
        required init?(coder: NSCoder) { fatalError() }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let w = window { DispatchQueue.main.async { self.onWindow(w) } }
        }
    }
}

// MARK: - Sidebar

struct SidebarView: View {
    @Environment(AppModel.self) private var model
    @AppStorage(Prefs.discoveredCollapsed) private var discoveredCollapsed = true

    /// Name order only, so rows never move when a device changes state.
    private static func byName(_ a: Device, _ b: Device) -> Bool {
        switch a.name.localizedStandardCompare(b.name) {
        case .orderedAscending: return true
        case .orderedDescending: return false
        case .orderedSame: return a.id < b.id
        }
    }

    var body: some View {
        @Bindable var model = model
        let all = model.devices
        let phones = all.filter { $0.kind == "physical" }.sorted(by: Self.byName)
        let cloud = all.filter { $0.kind == "cloud" }.sorted(by: Self.byName)
        let managed = all.filter { $0.managed == true && $0.kind != "physical" && $0.kind != "cloud" }.sorted(by: Self.byName)
        let other = all.filter { $0.managed != true && $0.kind != "physical" && $0.kind != "cloud" }.sorted(by: Self.byName)
        List(selection: $model.selection) {
            Section("Devices") {
                ForEach(model.creating) { CreatingRow(pending: $0) }
                rows(managed)
                if managed.isEmpty, model.creating.isEmpty {
                    Button { model.showCreate = true } label: {
                        Label("New Device…", systemImage: "plus.circle").foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .disabled(!model.connection.isConnected)
                }
            }
            if !phones.isEmpty { Section("Phones") { rows(phones) } }
            if !cloud.isEmpty { Section("Cloud") { rows(cloud) } }
            if !other.isEmpty {
                Section(isExpanded: Binding(get: { !discoveredCollapsed }, set: { discoveredCollapsed = !$0 })) {
                    rows(other)
                } header: {
                    HStack(spacing: Theme.Space.s) {
                        Text("Xcode & Android Studio")
                        Spacer(minLength: Theme.Space.xs)
                        Text(other.count, format: .number)
                            .monospacedDigit()
                            .foregroundStyle(Theme.Ink.secondary)
                            .padding(.trailing, Theme.Space.l)   // line up with the rows' status dots
                    }
                    .help("Simulators and emulators created in Xcode or Android Studio")
                }
            }
        }
        .listStyle(.sidebar)
        .transaction { $0.animation = nil }
        // ⌫ in the focused list asks the same Delete… confirmation as the Device menu (⌘⌫ there works anywhere).
        .onDeleteCommand {
            guard let d = model.selectedDevice, DeviceActions.canDelete(d), model.connection.isConnected,
                  !DeviceActions.isBusy(d, model) else { NSSound.beep(); return }
            DeviceActions.confirmDelete(d, model)
        }
        .sidebarUpdateItem()   // "PhoneDock 0.2.0 · Update" at the bottom, only when there is one: UpdateSidebarItem.swift
        .sidebarAddButton()    // Add Device, under everything, so it never moves when the update card comes and goes
    }

    @ViewBuilder private func rows(_ items: [Device]) -> some View {
        ForEach(items) { d in
            DeviceRow(device: d, handoff: model.pendingHandoff(for: d.id), recording: model.recordings[d.id] != nil,
                      busy: model.busy[d.id] ?? model.pending[d.id], stage: model.deviceJobs[d.id].flatMap { model.jobs[$0] }.map { StageText.start($0) })
                .tag(d.id)
                .contextMenu { menu(d) }
                .testAnchor("row-\(d.name)")
        }
    }

    @ViewBuilder private func menu(_ d: Device) -> some View {
        let online = model.connection.isConnected
        if d.isRunning {
            Button("Shut Down") { model.shutdown(d) }.disabled(!online || !DeviceActions.canShutDown(d, model))
        } else {
            Button("Start") { model.boot(d) }
                .disabled(!online || !DeviceActions.canStart(d, model))
                .modifierKeyAlternate(.option) {
                    Button("Cold Boot") { model.boot(d, cold: true) }.disabled(!online || !DeviceActions.canStart(d, model))
                }
        }
        Button(d.windowActionTitle) { model.openWindow(d) }.disabled(!online || !d.isRunning || !d.can("window"))
        if d.leasedByAgent || d.leasedByHuman {
            Divider()
            if d.leasedByAgent { Button("Take Over") { model.takeOver(d) }.disabled(!online) }
            if d.leasedByHuman { Button("Hand Back") { model.handBack(d) }.disabled(!online) }
        }
        if d.isRunning {   // the Device menu's capture items, for this row's device
            Divider()
            Button("Save Screenshot") { model.screenshot(d) }.disabled(!online || !d.can("screenshot"))
            if model.recordings[d.id] != nil {
                Button("Stop Recording") { model.stopRecording(d) }
            } else {
                Button("Record Screen") { model.startRecording(d) }
                    .disabled(!online || !d.can("record") || model.recordingUnsupported.contains(d.id))
            }
        }
        Divider()
        Button("Copy Device ID") { DeviceActions.copyID(d) }
        if DeviceActions.canDelete(d) {
            Divider()
            Button("Delete…", role: .destructive) { DeviceActions.confirmDelete(d, model) }
                .disabled(!online || DeviceActions.isBusy(d, model))
        }
    }
}

extension View {
    /// Pins Add Device to the foot of the sidebar (a safe-area bar on macOS 26, as the update card is).
    @ViewBuilder func sidebarAddButton() -> some View {
        if #available(macOS 26.0, *) {
            safeAreaBar(edge: .bottom, spacing: 0) { SidebarAddButton() }
        } else {
            safeAreaInset(edge: .bottom, spacing: 0) { SidebarAddButton() }
        }
    }
}

/// Add Device at the foot of the sidebar, as Reminders has Add List: devices are listed there, so adding one is too.
/// It opens the menu that ＋ in the main toolbar opened; with the sidebar hidden, ＋ is back in the toolbar.
struct SidebarAddButton: View {
    var body: some View {
        Menu {
            AddMenuItems()
        } label: {
            // Laid out as a device row is (20 pt glyph column, then the name), so glyph and words line up with theirs.
            HStack(spacing: Theme.Space.m) {
                Image(systemName: "plus.circle").frame(width: 20)
                Text("Add Device")
            }
            .font(Theme.Fonts.body)
            .foregroundStyle(.secondary)
            .contentShape(Rectangle())
            .accessibilityElement(children: .combine)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("New Device, Connect a Phone or Connect an Agent")
        .testAnchor("Add menu")
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10 + Theme.Space.s)   // rows sit 10 pt in, their glyph column 6 pt further
        .padding(.vertical, Theme.Space.m)
    }
}

/// The Add menu's items: in the sidebar's Add Device and in the toolbar's ＋ (sidebar hidden).
struct AddMenuItems: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Button { model.showCreate = true } label: { Label("New Device…", systemImage: "plus") }
            .disabled(!model.connection.isConnected)
        Button { model.showConnect = true } label: { Label("Connect a Phone…", systemImage: "iphone.radiowaves.left.and.right") }
        Divider()
        Button { model.showAgentSetup = true } label: { Label("Connect an Agent…", systemImage: "sparkles") }
    }
}

/// A device the service is still making: it has no record yet, so it can't be selected.
struct CreatingRow: View {
    let pending: PendingDevice

    var body: some View {
        HStack(spacing: Theme.Space.m) {
            PlatformGlyph(platform: pending.platform, symbol: pending.platform == "ios" ? "iphone" : "smartphone")
                .foregroundStyle(.secondary)
                .frame(width: 20)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(pending.name).font(Theme.Fonts.body).lineLimit(1).truncationMode(.middle)
                Text(pending.stage).font(Theme.Fonts.meta).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: Theme.Space.xs)
            ProgressView().controlSize(.mini)
        }
        .padding(.vertical, Theme.Space.xxs)
        .accessibilityElement(children: .combine)
        .selectionDisabled()
        .testAnchor("creating-row")
    }
}

struct DeviceRow: View {
    let device: Device
    var handoff: Handoff? = nil
    var recording = false
    /// A snapshot, restore or clone in progress ("Saving snapshot…"): shown instead of the power state.
    var busy: String? = nil
    /// "Starting… (installing system image)" while the service starts it.
    var stage: String? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: Theme.Space.m) {
            PlatformGlyph(platform: device.platform, symbol: device.platformSymbol)
                .foregroundStyle(.secondary)
                .frame(width: 20)
                .help(device.platformName)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(device.name)
                    .font(Theme.Fonts.body)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(device.name)   // a long name is cut once a badge takes room: hovering shows all of it
                subtitle
                    .font(Theme.Fonts.meta)
                    .lineLimit(1)
            }
            Spacer(minLength: Theme.Space.xs)
            trailing
            StatusDot(status: PDStatus(deviceState: device.state))
        }
        .padding(.vertical, Theme.Space.xxs)
        .accessibilityElement(children: .combine)
    }

    /// A help request takes the subtitle line ("Claude Code needs you"), so the name keeps its full width. In a
    /// narrow sidebar it says "Needs you" rather than cut the sentence off (the tooltip has the rest).
    @ViewBuilder private var subtitle: some View {
        if let handoff {
            HStack(spacing: Theme.Space.xs) {
                Image(systemName: "hand.raised.fill")
                    .symbolEffect(.pulse, options: .repeating, isActive: !reduceMotion)
                    .accessibilityHidden(true)
                ViewThatFits(in: .horizontal) {
                    Text("\(handoff.requesterName) needs you")
                    Text("Needs you")
                }
            }
            .modifier(OnSelectionStyle(plain: Theme.Status.handoffText, selected: Theme.Ink.onFill))
            .fontWeight(.medium)
            .help("\(handoff.requesterName) needs you: \(handoff.reason)")
            .testAnchor("sidebar-needs-you")
        } else if let busy {
            Text(busy).foregroundStyle(.secondary)
        } else {
            stateSubtitle
        }
    }

    @ViewBuilder private var stateSubtitle: some View {
        switch device.state {
        case "booting": Text(stage ?? "Starting…").foregroundStyle(.secondary)
        case "creating": Text("Creating…").foregroundStyle(.secondary)
        case "stopping": Text("Shutting down…").foregroundStyle(.secondary)
        case "error":
            OnSelection(plain: Theme.Status.errorText, selected: nil) { Text("Needs attention") }
        case "unauthorized": Text("Allow USB debugging").foregroundStyle(.secondary)
        case "offline": Text("Not connected").foregroundStyle(.secondary)
        default:
            let os = device.pdFriendlyOS ?? device.pdFriendlyModel ?? device.platformName
            Text(device.pdIsBeta ? os + " · Beta" : os).foregroundStyle(.secondary)
        }
    }

    /// One badge, in priority order: agent in control › recording. A help request is in the subtitle, which already
    /// names the agent, so it drops the sparkles and gives the sentence their room.
    @ViewBuilder private var trailing: some View {
        if device.leasedByAgent, handoff == nil {
            OnSelection(plain: Theme.Status.agent, selected: Theme.Ink.onFill) {
                Image(systemName: "sparkles").font(Theme.Fonts.meta.weight(.semibold))
            }
                .help("\(device.controllerName ?? "An agent") is in control")
                .accessibilityLabel("\(device.controllerName ?? "An agent") is in control")
        } else if recording {
            RecordingDot()
                .help("Recording")
                .accessibilityLabel("Recording")
        }
    }
}

/// `OnSelection` as a modifier, for content that is already built.
private struct OnSelectionStyle: ViewModifier {
    let plain: Color
    let selected: Color?
    func body(content: Content) -> some View { OnSelection(plain: plain, selected: selected) { content } }
}

/// Colours a sidebar glyph, switching on the accent-coloured selection. Reads `backgroundProminence` in a leaf view:
/// read at the row's root it doesn't follow the selection. `selected == nil` falls back to the hierarchical secondary.
private struct OnSelection<Content: View>: View {
    let plain: Color
    let selected: Color?
    @ViewBuilder let content: Content
    @Environment(\.backgroundProminence) private var prominence

    var body: some View {
        if prominence == .increased {
            if let selected { content.foregroundStyle(selected) } else { content.foregroundStyle(.secondary) }
        } else {
            content.foregroundStyle(plain)
        }
    }
}

private struct RecordingDot: View {
    @Environment(\.backgroundProminence) private var prominence
    var body: some View {
        Circle()
            .fill(Theme.Status.recording)
            .frame(width: 6, height: 6)
            .overlay { if prominence == .increased { Circle().strokeBorder(Theme.Ink.onFill, lineWidth: 1).padding(-1.5) } }
    }
}

// MARK: - Agent setup

enum AgentClient: String, CaseIterable, Identifiable {
    case claude = "Claude Code", codex = "Codex", cursor = "Cursor", pi = "Pi", other = "Other MCP"
    var id: String { rawValue }
    /// The name `phonedock setup --agent` takes.
    var cliId: String? {
        switch self {
        case .claude: return "claude"
        case .codex: return "codex"
        case .cursor: return "cursor"
        case .pi: return "pi"
        case .other: return nil
        }
    }
    init?(cliId: String) {
        guard let c = Self.allCases.first(where: { $0.cliId == cliId }) else { return nil }
        self = c
    }
}

enum AgentCommands {
    /// Always single-quoted, with embedded quotes escaped, so any path pastes safely into a shell.
    static func shellQuote(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }

    static var cli: String { shellQuote(displayCLI ?? DaemonLocator.cliPath) }

    /// Self-test only: the CLI path to show (`PHONEDOCK_APP_SELFTEST_CLI`), so launch footage of a scratch build shows
    /// the release path (/Applications/PhoneDock.app/…) instead of a build folder. Setup still runs the real CLI.
    static let displayCLI: String? = (ProcessInfo.processInfo.environment["PHONEDOCK_APP_SELFTEST"] ?? "").isEmpty
        ? nil : ProcessInfo.processInfo.environment["PHONEDOCK_APP_SELFTEST_CLI"].flatMap { $0.isEmpty ? nil : $0 }

    /// A command from setup's report, with the CLI path as `displayCLI` shows it.
    static func display(_ command: String) -> String {
        guard let d = displayCLI else { return command }
        return command.replacingOccurrences(of: DaemonLocator.cliPath, with: d)
    }

    /// Agents need to know about a non-default daemon port; the default needs nothing.
    private static var portEnv: String? {
        DaemonLocator.port == DaemonLocator.defaultPort ? nil : "PHONEDOCK_PORT=\(DaemonLocator.port)"
    }

    /// The by-hand registration, for when `phonedock setup` can't run (its report has the same commands).
    static func command(_ client: AgentClient) -> String {
        switch client {
        // `--scope user`: available in every project, not only the folder Terminal happens to be in.
        case .claude: return "claude mcp add --scope user phonedock " + (portEnv.map { "-e \($0) " } ?? "") + "-- \(cli) mcp"
        case .codex: return "codex mcp add phonedock " + (portEnv.map { "--env \($0) " } ?? "") + "-- \(cli) mcp"
            + "\n# then add  tool_timeout_sec = 960  under [mcp_servers.phonedock] in ~/.codex/config.toml"
        case .pi: return "pi mcp add phonedock " + (portEnv.map { "--env \($0) " } ?? "") + "-- \(cli) mcp"
        case .cursor: return "Add to ~/.cursor/mcp.json:\n" + mcpJSON
        case .other: return (portEnv.map { "env \($0) " } ?? "") + "\(cli) mcp"
        }
    }

    /// `mcpServers` JSON for clients configured with a file (Cursor, Claude Desktop, Windsurf, VS Code…).
    static var mcpJSON: String {
        var entry: [String: Any] = ["command": displayCLI ?? DaemonLocator.cliPath, "args": ["mcp"]]
        if DaemonLocator.port != DaemonLocator.defaultPort { entry["env"] = ["PHONEDOCK_PORT": String(DaemonLocator.port)] }
        let data = (try? JSONSerialization.data(withJSONObject: ["mcpServers": ["phonedock": entry]], options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }

    static var listDevices: String { (portEnv.map { "env \($0) " } ?? "") + "\(cli) devices" }
}

/// A copyable command: mono text in a well, with a Copy button that confirms for 1.5 s.
struct CommandWell: View {
    let command: String
    var anchor: String? = nil
    /// Inside a grouped Form the row is already the container, so drop the well.
    var plain = false
    /// One line, truncated in the middle (the tooltip shows it all; Copy copies it all). Otherwise it wraps.
    var oneLine = false
    var onCopy: (() -> Void)? = nil
    @State private var copied = false

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Space.m) {
            Group {
                if oneLine {
                    Text(command).lineLimit(1).truncationMode(.middle)
                } else {
                    // Wraps between words only: a path never breaks in the middle (its spaces and slashes stay together).
                    CommandBody(command: command)
                }
            }
                .font(Theme.Fonts.mono)
                .foregroundStyle(Theme.Ink.primary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .layoutPriority(0)
                .help(command)
            Button(copied ? "Copied" : "Copy") {
                Clipboard.copy(command)
                copied = true
                onCopy?()
            }
            .controlSize(.small)
            .frame(minWidth: 56)
            .fixedSize()
            .layoutPriority(1)
            .testAnchor(anchor ?? "Copy")
        }
        .padding(plain ? 0 : Theme.Space.m)
        .background(plain ? Color.clear : Theme.Surface.content, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous).strokeBorder(plain ? Color.clear : Theme.Line.card, lineWidth: 1))
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(1.5))
            copied = false
        }
    }
}

/// A command that wraps between words, with a quoted path kept whole on its own line (shortened in the middle if it
/// can't fit; the tooltip and Copy have all of it), so a path never breaks mid-way.
struct CommandBody: View {
    let command: String

    private var parts: (before: String, path: String?, after: String) {
        guard let a = command.firstIndex(of: "'"), let b = command[command.index(after: a)...].firstIndex(of: "'") else { return (command, nil, "") }
        return (String(command[..<a]).trimmingCharacters(in: .whitespaces), String(command[a...b]),
                String(command[command.index(after: b)...]).trimmingCharacters(in: .whitespaces))
    }

    var body: some View {
        let p = parts
        VStack(alignment: .leading, spacing: 2) {
            Text(p.before).fixedSize(horizontal: false, vertical: true)
            if let path = p.path { Text(path).lineLimit(1).truncationMode(.middle).help(path) }
            if !p.after.isEmpty { Text(p.after) }
        }
    }
}
