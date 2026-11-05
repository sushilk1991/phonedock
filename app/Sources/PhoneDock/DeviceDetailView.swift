import SwiftUI
import AppKit
import UniformTypeIdentifiers

// MARK: - Display names for the window chrome

extension Device {
    /// "pixel_9" → "Pixel 9"; marketing names pass through.
    var pdFriendlyModel: String? {
        guard let m = model?.trimmingCharacters(in: .whitespaces), !m.isEmpty else { return nil }
        guard m.contains("_") || m == m.lowercased() else { return m }
        return m.split(whereSeparator: { $0 == "_" || $0 == "-" })
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }

    /// "26.5" → "iOS 26.5"; "Android 16 (API 36)" → "Android 16".
    var pdFriendlyOS: String? {
        guard let v = osVersion?.trimmingCharacters(in: .whitespaces), !v.isEmpty else { return nil }
        if v.first?.isNumber == true { return "\(platformName) \(v)" }
        if let r = v.range(of: " (") { return String(v[..<r.lowerBound]) }
        return v
    }

    /// A real iPhone: supported, but labelled Beta wherever it appears (DECISIONS #8).
    var pdIsBeta: Bool { backend == "ios-device" }

    /// Window subtitle: model, then OS ("Pixel 9 · Android 16").
    var pdWindowSubtitle: String { [pdFriendlyModel, pdFriendlyOS].compactMap { $0 }.joined(separator: " · ") }
}

/// Which hardware buttons a device really has. The daemon reports one `key` capability; the per-key support below
/// mirrors the backends (simulators have no volume keys, Wi-Fi iPhones no app switcher).
struct HardwareSupport: Equatable {
    var home = false, back = false, appSwitcher = false, volume = false, lock = false, rotate = false

    init() {}

    init(_ d: Device) {
        let keys = d.can("key") && (d.platform == "android" || d.platform == "ios")
        home = keys
        lock = keys
        back = keys && d.platform == "android"
        appSwitcher = keys && d.backend != "ios-device"
        volume = keys && d.backend != "ios-simulator"
        rotate = d.can("rotate")
    }

    var any: Bool { home || back || appSwitcher || volume || lock || rotate }
}

// MARK: - Stage

struct DeviceDetailView: View {
    @Environment(AppModel.self) private var model
    let device: Device
    @Binding var highlight: CGRect?
    @State private var frames = FrameLoop()
    @State private var dropTargeted = false

    /// Device pixels, from the stream first (each frame says the size it shows), then the device record, then a
    /// typical phone. A frame turned the other way than that size wins: the screen has just rotated.
    private var pixelSize: CGSize {
        var s = frames.deviceSize
            ?? device.screen.flatMap { $0.width > 0 && $0.height > 0 ? CGSize(width: $0.width, height: $0.height) : nil }
            ?? (device.platform == "ios" ? CGSize(width: 1206, height: 2622) : CGSize(width: 1080, height: 2400))
        if let i = frames.pictureSize, i.width > 0, i.height > 0, (i.width > i.height) != (s.width > s.height) {
            s = CGSize(width: s.height, height: s.width)
        }
        return s
    }

    var body: some View {
        GeometryReader { geo in
            let layout = StageLayout(stage: geo.size, pixels: pixelSize, platform: device.platform)
            ZStack(alignment: .topLeading) {
                Color.clear
                // Reserved top slot: who's in control / needs you. Fixed height, so it never moves the screen.
                StageTopBar(device: device, stacked: layout.topSlot > Theme.Stage.topSlot)
                    .frame(maxWidth: max(0, geo.size.width - Theme.Space.xxl * 2))
                    // Bottom-anchored: a help-request pill above the capsule grows upward, so the capsule doesn't nudge.
                    .frame(height: layout.topSlot, alignment: .bottom)
                    .position(x: geo.size.width / 2, y: layout.frame.minY - layout.topSlot / 2)
                DeviceFrame(layout: layout) {
                    if device.isRunning {
                        LiveScreen(device: device, frames: frames, pixels: pixelSize, screen: layout.screen.size,
                                   highlight: $highlight, dropTargeted: $dropTargeted)
                    } else {
                        OffScreen(device: device)
                    }
                }
                .position(x: layout.frame.midX, y: layout.frame.midY)
                .transaction { $0.animation = nil }
                // Reserved bottom slot: the floating hardware bar.
                Group {
                    if device.isRunning { ControlBar(device: device) }
                }
                .frame(height: Theme.Stage.bottomSlot)
                .position(x: geo.size.width / 2, y: layout.frame.maxY + Theme.Stage.bottomSlot / 2)
                .transaction { $0.animation = nil }
            }
            // Toasts sit 12 pt above the hardware bar (top edge = frame bottom + 10), never on it.
            .preference(key: ToastLiftKey.self,
                        value: device.isRunning && HardwareSupport(device).any ? geo.size.height - layout.frame.maxY + 2 : nil)
            .onDrop(of: [.fileURL], isTargeted: $dropTargeted) { providers in
                guard device.isRunning, device.can("install"), let p = providers.first else { return false }
                _ = p.loadObject(ofClass: URL.self) { url, _ in
                    if let url { Task { @MainActor in model.installApp(device, path: url.path) } }
                }
                return true
            }
        }
        .background(Theme.Surface.stage)
        .onAppear {
            frames.run(client: model.client, deviceId: device.id, active: device.isRunning, video: device.can("video"))
            if SelfTest.enabled { SelfTest.frameLoop = frames }
        }
        .onChange(of: device.id) { frames.run(client: model.client, deviceId: device.id, active: device.isRunning, video: device.can("video")) }
        .onChange(of: device.state) { frames.run(client: model.client, deviceId: device.id, active: device.isRunning, video: device.can("video")) }
        .onChange(of: frames.asleep) { _, a in
            if a { model.asleep.insert(device.id) } else { model.asleep.remove(device.id) }
        }
        .onChange(of: device.isRunning) { _, r in if !r { model.asleep.remove(device.id) } }
        .onChange(of: model.connection) { frames.stop(); frames.run(client: model.client, deviceId: device.id, active: device.isRunning, video: device.can("video")) }
        .onDisappear { frames.stop(); model.asleep.remove(device.id) }
    }
}

/// "The phone is asleep · Wake": quiet, at the bottom of the screen, only while the picture is solid black.
private struct AsleepHint: View {
    @Environment(AppModel.self) private var model
    let device: Device

    var body: some View {
        HStack(spacing: Theme.Space.s) {
            Image(systemName: "moon.zzz.fill").foregroundStyle(Theme.Ink.secondary).accessibilityHidden(true)
            Text("The phone is asleep").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.primary)
            Text("·").foregroundStyle(Theme.Ink.secondary)
            Button("Wake") { model.wake(device) }
                .buttonStyle(.pdLink)
                .font(Theme.Fonts.callout)
                .testAnchor("Wake")
        }
        .padding(.horizontal, Theme.Space.l)
        .padding(.vertical, Theme.Space.xs + 1)
        .background(Theme.Surface.card, in: Capsule())
        .overlay(Capsule().strokeBorder(Theme.Line.card, lineWidth: 1))
        .accessibilityElement(children: .contain)
        .testAnchor("asleep-hint")
    }
}

/// Where the device frame sits on the stage. Depends only on the stage size and the device's pixel aspect, never on
/// what the top or bottom bars show.
struct StageLayout {
    let frame: CGRect
    let screen: CGRect
    let bezel: CGFloat
    let outerRadius: CGFloat
    /// Height reserved above the frame for StageTopBar; taller on a narrow stage, where the handoff card stacks.
    let topSlot: CGFloat
    var screenRadius: CGFloat { max(0, outerRadius - bezel) }

    init(stage: CGSize, pixels: CGSize, platform: String) {
        let side: CGFloat = 24
        let topSlot = Theme.Stage.topSlot(stageWidth: stage.width)
        self.topSlot = topSlot
        let availW = max(80, stage.width - side * 2)
        let availH = max(120, stage.height - topSlot - Theme.Stage.bottomSlot)
        let aspect = max(0.1, pixels.width / max(pixels.height, 1))
        var b: CGFloat = 8
        var w: CGFloat = 0
        for _ in 0..<3 {
            w = min(availW - 2 * b, (availH - 2 * b) * aspect)
            b = max(8, w * Theme.DeviceFrame.bezelRatio)
        }
        w = max(40, min(availW - 2 * b, (availH - 2 * b) * aspect).rounded(.down))
        let h = (w / aspect).rounded(.down)
        b = b.rounded()
        let fw = w + 2 * b, fh = h + 2 * b
        let x = ((stage.width - fw) / 2).rounded()
        let y = (topSlot + (availH - fh) / 2).rounded()
        frame = CGRect(x: x, y: y, width: fw, height: fh)
        screen = frame.insetBy(dx: b, dy: b)
        bezel = b
        let ratio: CGFloat = platform == "ios" ? Theme.DeviceFrame.iosCorner
            : platform == "android" ? Theme.DeviceFrame.androidCorner : 0.02
        outerRadius = (min(fw, fh) * ratio).rounded()
    }
}

/// Bezel, rim and e3 shadow around a screen-sized slot.
private struct DeviceFrame<Screen: View>: View {
    let layout: StageLayout
    @ViewBuilder let screen: Screen

    var body: some View {
        let outer = RoundedRectangle(cornerRadius: layout.outerRadius, style: .continuous)
        ZStack {
            outer
                .fill(Theme.DeviceFrame.bezel)
                .overlay(outer.strokeBorder(Theme.DeviceFrame.rim, lineWidth: 1))
                .shadow(color: Theme.DeviceFrame.shadow, radius: 24, x: 0, y: 12)
            screen
                .frame(width: layout.screen.width, height: layout.screen.height)
                .clipShape(RoundedRectangle(cornerRadius: layout.screenRadius, style: .continuous))
        }
        .frame(width: layout.frame.width, height: layout.frame.height)
        .testAnchor("device-frame")
    }
}

// MARK: - Live screen

/// Last-frame time, kept outside SwiftUI state so a new frame doesn't trigger a second render.
private final class FrameClock { var last = Date() }

private struct LiveScreen: View {
    @Environment(AppModel.self) private var model
    let device: Device
    let frames: FrameLoop
    let pixels: CGSize
    let screen: CGSize
    @Binding var highlight: CGRect?
    @Binding var dropTargeted: Bool
    @State private var clock = FrameClock()
    @State private var stale = false
    @State private var slowFirstFrame = false

    var body: some View {
        ZStack(alignment: .top) {
            DeviceScreenView(image: frames.image, videoLayer: frames.videoLayer, devicePixelSize: pixels, handlers: handlers)
            if !frames.hasPicture {
                Group {
                    if let f = frames.failure {
                        ScreenFailureView(failure: f, device: device)
                            .padding(Theme.Space.l)
                    } else {
                        VStack(spacing: Theme.Space.m) {
                            ProgressView().controlSize(.small)
                            if slowFirstFrame {
                                Text("Connecting…").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                            }
                        }
                        .environment(\.colorScheme, .dark)
                        .allowsHitTesting(false)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            if stale {
                // Never show a frozen screen as live.
                Theme.DeviceFrame.bezel.opacity(0.3).allowsHitTesting(false)
                ReconnectingCapsule().padding(.top, Theme.Space.l)
            }
            if let r = highlight { highlightBox(r) }
            if frames.asleep, frames.hasPicture {
                AsleepHint(device: device)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                    .padding(.bottom, Theme.Space.xxl)
            }
            if dropTargeted, device.can("install") { dropOverlay }
        }
        .onChange(of: frames.image) { clock.last = Date() }
        .task(id: device.id) {
            try? await Task.sleep(for: .seconds(2))
            slowFirstFrame = true
        }
        .task(id: device.id) {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                // Stale = polls stopped succeeding. An unchanged screen (304, or the video's ping) is still live.
                let s = frames.hasPicture && (frames.failure != nil || Date().timeIntervalSince(max(clock.last, frames.lastSuccess)) > 3)
                if s != stale { stale = s }
            }
        }
    }

    /// UI-tree selection: magenta stroke with a white halo, so it reads on any app's colours.
    private func highlightBox(_ r: CGRect) -> some View {
        let s = screen.width / max(pixels.width, 1)
        return Rectangle()
            .fill(Theme.Inspect.fill)
            .overlay(Rectangle().strokeBorder(Theme.Inspect.stroke, lineWidth: 2))
            .overlay(Rectangle().strokeBorder(Theme.Inspect.halo, lineWidth: 1).padding(-1))
            .frame(width: max(4, r.width * s), height: max(4, r.height * s))
            .position(x: r.midX * s, y: r.midY * s)
            .frame(width: screen.width, height: screen.height, alignment: .topLeading)
            .allowsHitTesting(false)
    }

    private var dropOverlay: some View {
        ZStack {
            Theme.DeviceFrame.bezel.opacity(0.55)
            VStack(spacing: Theme.Space.m) {
                Image(systemName: "square.and.arrow.down").font(.system(size: 28, weight: .medium))
                Text("Drop to Install").font(Theme.Fonts.headline)
            }
            .foregroundStyle(Theme.Ink.onFill)
        }
        .allowsHitTesting(false)
    }

    private var handlers: ScreenInputHandlers {
        let d = device
        let model = model
        func send(_ a: [String: Any]) {
            guard let c = model.client else { return }
            Task {
                do { try await c.input(d.id, a) }
                catch {
                    model.fail("That didn’t reach \(d.name)", error, device: d)
                    if let e = error as? APIError, e.code == "lease_conflict" || e.status == 409 { await model.refresh() }
                }
            }
        }
        return ScreenInputHandlers(
            tap: { p in send(["action": "tap", "x": Int(p.x), "y": Int(p.y)]) },
            swipe: { a, b, ms in send(["action": "swipe", "x1": Int(a.x), "y1": Int(a.y), "x2": Int(b.x), "y2": Int(b.y), "durationMs": ms]) },
            // While an agent's help request is open, what the person types is usually a password, code or card
            // number: send it as secret, so Activity, the action log and saved flows show ••• instead of the text.
            type: { t in send(["action": "type", "text": t, "secret": model.pendingHandoff(for: d.id) != nil]) },
            // Esc means "go back" to a person at the keyboard; Android's KEYCODE_ESCAPE doesn't navigate, so send back.
            key: { k in send(["action": "key", "key": k == "escape" && d.platform == "android" ? "back" : k]) },
            dropFile: { url in model.installApp(d, path: url.path) },
            dropTargeted: { dropTargeted = $0 }
        )
    }
}

/// Opaque on purpose: glass over a changing screen flickers.
private struct ReconnectingCapsule: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: Theme.Space.s) {
            // Rebuilt on an appearance change: the AppKit spinner otherwise keeps the old appearance's white.
            ProgressView().controlSize(.mini).id(scheme)
            Text("Reconnecting…").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.primary)
        }
        .padding(.horizontal, Theme.Space.l)
        .padding(.vertical, Theme.Space.xs + 1)
        .background(Theme.Surface.card, in: Capsule())
        .overlay(Capsule().strokeBorder(Theme.Line.card, lineWidth: 1))
        .allowsHitTesting(false)
        .accessibilityElement(children: .combine)
        .testAnchor("Reconnecting")
    }
}

// MARK: - Off, starting and unavailable

/// A powered-off phone: the same frame, a dark screen, and what you can do about it.
private struct OffScreen: View {
    @Environment(AppModel.self) private var model
    let device: Device
    @State private var showDetails = false

    var body: some View {
        let job = model.deviceJobs[device.id].flatMap { model.jobs[$0] }
        // A snapshot, restore or clone shuts an iOS simulator down and starts it again: say so instead of "Off".
        let operation = model.busy[device.id] ?? model.pending[device.id]
        let busy = operation != nil || job != nil || ["booting", "creating", "stopping"].contains(device.state)
        ZStack {
            Theme.DeviceFrame.bezel
            VStack(spacing: Theme.Space.xl) {
                VStack(spacing: Theme.Space.xs) {
                    Text(device.name)
                        .font(Theme.Fonts.display)
                        .foregroundStyle(Theme.Ink.primary)
                        .multilineTextAlignment(.center)
                        .lineLimit(2)
                    Text(operation ?? stateLine(busy: busy))
                        .font(Theme.Fonts.callout)
                        .foregroundStyle(Theme.Ink.secondary)
                }
                if busy {
                    progress(operation == nil ? job : nil, slowHint: operation == nil && device.state != "stopping")
                } else {
                    if let problem { ProblemView(problem: problem) }
                    if DeviceActions.canStart(device, model) { startControls }
                }
            }
            .padding(Theme.Space.l)
        }
        .environment(\.colorScheme, .dark)
        .testAnchor("device-off")
    }

    private func stateLine(busy: Bool) -> String {
        switch device.state {
        case "booting": return "Starting…"
        case "creating": return "Creating…"
        case "stopping": return "Shutting down…"
        case "offline": return "Not connected"
        case "unauthorized": return "Waiting for permission"
        case "error": return "Needs attention"
        default: return busy ? "Starting…" : "Off"
        }
    }

    private var problem: FriendlyError? {
        switch device.state {
        case "unauthorized":
            return FriendlyError(title: "Allow USB debugging on the phone", message: "Unlock it and tap Allow.")
        case "offline" where device.kind == "physical":
            return FriendlyError(title: "\(device.name) isn’t connected", message: "Connect it over USB or Wi-Fi.")
        case "error":
            return FriendlyError(title: "\(device.name) ran into a problem",
                                 message: device.can("boot") ? "Try a cold boot from the Power menu." : nil,
                                 details: device.error)
        default:
            guard let e = device.error, !e.isEmpty else { return nil }
            return FriendlyError(title: "\(device.name) ran into a problem",
                                 message: device.can("boot") ? "Try a cold boot from the Power menu." : nil, details: e)
        }
    }

    private var startControls: some View {
        HStack(spacing: Theme.Space.s) {
            Button { model.boot(device) } label: { Text("Start").frame(minWidth: 64) }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .testAnchor("Start")
            Menu {
                Button("Cold Boot") { model.boot(device, cold: true) }
                if device.can("window") {
                    Button("Start in Separate Window") { model.boot(device, window: true) }
                }
            } label: {
                Image(systemName: "ellipsis")
            }
            .menuIndicator(.hidden)
            .fixedSize()
            .help("More ways to start")
            .accessibilityLabel("More ways to start")
        }
        .controlSize(.large)
        .disabled(!model.connection.isConnected)
    }

    private func progress(_ job: Job?, slowHint: Bool) -> some View {
        VStack(spacing: Theme.Space.s) {
            if let f = job?.fraction {
                ProgressView(value: f).frame(width: min(200, 1000))
                Text("Starting… \(Int((f * 100).rounded()))%")
                    .font(Theme.Fonts.callout.monospacedDigit())
                    .foregroundStyle(Theme.Ink.secondary)
            } else {
                ProgressView().progressViewStyle(.linear).frame(width: 200)
            }
            if let line = job?.lastLine, !line.isEmpty {
                Button(showDetails ? "Hide Details" : "Show Details") { showDetails.toggle() }
                    .buttonStyle(.pdLink)
                    .controlSize(.small)
                if showDetails {
                    Text(line)
                        .font(Theme.Fonts.monoSmall)
                        .foregroundStyle(Theme.Ink.secondary)
                        .lineLimit(3)
                        .multilineTextAlignment(.center)
                        .textSelection(.enabled)
                }
            }
            if slowHint { SlowStartHint() }
        }
        .frame(maxWidth: 240)
    }
}

/// After 20 s of starting, says that a long start is normal (an iPhone simulator's first start takes a minute or two)
/// rather than leave a bar that only moves.
private struct SlowStartHint: View {
    @State private var shown = false

    var body: some View {
        ZStack {
            if shown {
                Text("Starting can take a minute or two, longer the first time.")
                    .font(Theme.Fonts.callout)
                    .foregroundStyle(Theme.Ink.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(.opacity)
                    .testAnchor("slow-start-hint")
            }
        }
        .task {
            try? await Task.sleep(for: .seconds(20))
            withAnimation(Theme.Motion.gentle) { shown = true }
        }
    }
}

// MARK: - Hardware bar

/// Floating glass bar under the device: [Home, Back, App Switcher] · [Volume −, Volume +, Lock] · [Rotate].
/// Buttons the device can't use are left out.
struct ControlBar: View {
    @Environment(AppModel.self) private var model
    let device: Device

    var body: some View {
        let hw = HardwareSupport(device)
        let nav = hw.home || hw.back || hw.appSwitcher
        let side = hw.volume || hw.lock
        if hw.any {
            HStack(spacing: Theme.Space.xxs) {
                if hw.home { button("Home", "house", "⇧⌘H") { model.key(device, "home") } }
                if hw.back { button("Back", "chevron.backward", "⇧⌘B") { model.key(device, "back") } }
                if hw.appSwitcher { button("App Switcher", "square.on.square", "⌃⇧⌘H") { model.key(device, "app_switch") } }
                if nav && (side || hw.rotate) { separator }
                if hw.volume {
                    button("Volume Down", "speaker.wave.1", "⌘↓") { model.key(device, "volume_down") }
                    button("Volume Up", "speaker.wave.3", "⌘↑") { model.key(device, "volume_up") }
                }
                if hw.lock { button("Lock", "lock", "⌘L") { model.key(device, "lock") } }
                if side && hw.rotate { separator }
                if hw.rotate { button("Rotate", "rotate.right", "⌘→") { model.rotate(device) } }
            }
            .buttonStyle(HardwareButtonStyle())
            .pdFloatingBar()
            .disabled(!model.connection.isConnected)
            .testAnchor("hardware-bar")
        }
    }

    private var separator: some View {
        Divider().frame(height: 16).padding(.horizontal, Theme.Space.s)
    }

    private func button(_ title: String, _ symbol: String, _ shortcut: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: symbol) }
            .help("\(title) (\(shortcut))")
            .accessibilityLabel(title)
            .testAnchor(title)
    }
}

private struct HardwareButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { HardwareButtonLabel(configuration: configuration) }

    private struct HardwareButtonLabel: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.isEnabled) private var enabled
        @State private var hovering = false

        var body: some View {
            configuration.label
                .font(Theme.Fonts.body.weight(.medium))
                .foregroundStyle(enabled ? Theme.Ink.primary : Theme.Ink.tertiary)
                .frame(width: 28, height: 28)
                .background(Circle().fill(Theme.Ink.primary.opacity(configuration.isPressed ? 0.16 : hovering && enabled ? 0.08 : 0)))
                .contentShape(Circle())
                .onHover { hovering = $0 }
                .animation(Theme.Motion.quick, value: hovering)
        }
    }
}

// MARK: - Screen errors

/// A frame error, kept raw so the view can word it for the device it belongs to. Built by FrameLoop.
struct ScreenFailure: Equatable {
    var status: Int
    var code: String
    var message: String
    var hints: [String]
    var detail: String?
    /// The app lost the daemon (not a device problem).
    var connectionLost: Bool

    init(_ error: Error) {
        if let e = error as? APIError {
            status = e.status; code = e.code; message = e.message; hints = e.hints; detail = e.detail
            connectionLost = false
        } else {
            status = 0; code = "client"; message = error.localizedDescription; hints = []; detail = nil
            let lost: [URLError.Code] = [.cannotConnectToHost, .networkConnectionLost, .timedOut, .notConnectedToInternet]
            connectionLost = (error as? URLError).map { lost.contains($0.code) } ?? false
        }
    }

    func problem(for device: Device) -> FriendlyError {
        if connectionLost {
            return FriendlyError(title: "PhoneDock isn’t responding", message: "It reconnects automatically.", details: message)
        }
        let e = APIError(status: status, code: code, message: message, hints: hints, detail: detail)
        // It sits on that device's own screen, so the name would only repeat (and hyphen-wrap in a narrow frame).
        return FriendlyError.from(e, title: "Can’t show the screen", device: device)
    }
}

/// Shown on the device screen when no frame arrives. The frame loop keeps retrying on its own.
struct ScreenFailureView: View {
    let failure: ScreenFailure
    let device: Device

    var body: some View {
        VStack(spacing: Theme.Space.m) {
            ProblemView(problem: failure.problem(for: device))
            HStack(spacing: Theme.Space.s) {
                ProgressView().controlSize(.mini)
                Text("Retrying…").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
            }
            .environment(\.colorScheme, .dark)
        }
        .testAnchor("screen-failure")
    }
}
