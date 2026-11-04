import AppKit
import SwiftUI

/// Marks a SwiftUI view so the self-test can find it by name (`button`, `focus`, `waitFor` ops). SwiftUI only builds its
/// accessibility tree for external AX clients, so in-process AX lookups can't see sheets; anchors always work.
/// A no-op unless PHONEDOCK_APP_SELFTEST is set.
extension View {
    @ViewBuilder func testAnchor(_ name: String) -> some View {
        if SelfTest.enabled { background(SelfTestAnchor(name: name)) } else { self }
    }

    /// Links (Setup Guide, docs) open nothing in a background self-test; see `SelfTest.blocksForeground`.
    @ViewBuilder func selfTestLinkGuard() -> some View {
        if SelfTest.background {
            environment(\.openURL, OpenURLAction { url in SelfTest.blocksForeground("open \(url.absoluteString)") ? .handled : .systemAction })
        } else { self }
    }
}

struct SelfTestAnchor: NSViewRepresentable {
    let name: String
    func makeNSView(context: Context) -> AnchorView { AnchorView(name) }
    func updateNSView(_ v: AnchorView, context: Context) { if v.name != name { v.name = name; SelfTest.register(v) } }

    final class AnchorView: NSView {
        var name: String
        init(_ n: String) { name = n; super.init(frame: .zero) }
        required init?(coder: NSCoder) { fatalError() }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); if window != nil { SelfTest.register(self) } }
    }
}

/// Every Copy button goes through here. Background self-tests copy to a private pasteboard (and log it) instead of the
/// clipboard of the person using the Mac.
@MainActor
enum Clipboard {
    static let selfTestBoard = NSPasteboard(name: NSPasteboard.Name("dev.phonedock.selftest"))

    static func copy(_ s: String) {
        let board = SelfTest.background ? selfTestBoard : NSPasteboard.general
        board.clearContents()
        board.setString(s, forType: .string)
        if SelfTest.background { SelfTest.log("COPIED (private pasteboard): \(s.count > 160 ? String(s.prefix(160)) + "…" : s)") }
    }
}

/// Debug-only UI self-test. Enabled only when `PHONEDOCK_APP_SELFTEST=<script.json>` is set.
/// Synthesizes real NSEvents and dispatches them through `window.sendEvent(_:)`, so they travel the normal
/// AppKit/SwiftUI hit-testing, gesture and first-responder paths. Script: `{"steps":[{...}]}` where a step is
///   {"op":"wait","ms":500}
///   {"op":"tap","x":540,"y":1200}                       device pixels → mapped to a click on the live screen
///   {"op":"drag","x1":540,"y1":1800,"x2":540,"y2":600,"ms":300}
///   {"op":"type","text":"hello"}   {"op":"key","keyCode":36}
///   {"op":"button","title":"Take Over"}                 synthesized click at an NSButton / AX element's frame
///                                                       (searches an attached sheet first, then the window)
///                                                       Titles match ignoring case, a trailing "…" or "...", and curly vs straight
///                                                       apostrophes/quotes ("Can’t Do It" = "Can't Do It", "Save…" = "Save")
///   {"op":"choose","label":"Version","item":"iOS 26.5"}  select a pop-up / Picker item (or a segmented-control segment)
///                                                       by the control's label and the item's title, without opening the menu
///                                                       (so it can't hang the harness). The label is an anchor name, the
///                                                       control's AX label, or the text just left of it; the item matches
///                                                       exactly (normalised), else by prefix, else by substring. A miss lists
///                                                       the pop-ups and their items.
///   {"op":"click","wx":920,"wy":68}                     synthesized click at window point (top-left origin);
///                                                       refused on the device screen unless "screen":true;
///                                                       "sheet":true: point in the attached sheet instead
///   {"op":"focus","label":"Device name"}                clicks a text field: an anchor name, else a field's label
///                                                       or placeholder (sheet first); a miss lists the fields
///   {"op":"select","device":"PhoneDock iPhone"}         select a sidebar device by name or id (no input to it)
///   {"op":"mark","text":"ready-1"}                      logs "MARK ready-1" (sync point for an outside script)
///   {"op":"badge","expect":"1"}                         check the Dock badge ("" = none)
///   {"op":"fakeScreenError","message":"…","hints":["…"]}   stop the frame loop and show that error
///   {"op":"fakeBusy","device":"PhoneDock-Pixel","label":"Saving snapshot…"}  show a snapshot/clone in progress
///                                                       without running one ("" clears)
///   {"op":"activate"}                                   bring the app to the front (active selection styling); skipped
///                                                       unless PHONEDOCK_APP_SELFTEST_FOREGROUND=1 (runs stay in the background)
///   {"op":"activeLook","on":true}                       draw windows as if the app were in front, without activating it
///                                                       (default on in background runs; PHONEDOCK_APP_SELFTEST_ACTIVE_LOOK=0
///                                                       turns it off). See `ActiveLook` for what it does and doesn't reach.
///   {"op":"contextMenu","device":"Pixel","item":"…"}    log a sidebar row's right-click menu ("anchor" or "wx"/"wy" for other
///                                                       views) without opening it; "item" runs one
///   {"op":"toolbarMenu","label":"Add","item":"…"}       the same for a toolbar pull-down; SwiftUI's (＋ ▾, Power ▾) are built
///                                                       only when they open, so it fails for them: their items are in File,
///                                                       Device and Help (dumpMenu / menu)
///   {"op":"screenshot","path":"…","render":true}        draw the window in-process instead of asking the window server
///   {"op":"screenshot","path":"…","popover":true}       capture the open popover (Can't Do It's reason, a note), which
///                                                       is its own window and so isn't in the main window's capture
///   {"op":"appearance","mode":"dark"}                   light | dark | system
///   {"op":"windowSize","w":960,"h":640}                 content size in points (clamped to the minimum)
///   {"op":"toast","title":"…","message":"…","kind":"error|success|info","action":"…"}   show a toast
///   {"op":"problem","title":"…","message":"…"}          show the blocking alert ("" closes it)
///   {"op":"defaults","key":"…","value":…}                set a preference the UI reads
///   {"op":"inspector","show":false}                     show or hide the inspector
///   {"op":"sheet","name":"connect"}                     open a sheet: connect | create | agent (none: close it)
///   {"op":"waitFor","text":"Agent needs you","timeoutMs":5000}   poll the AX tree until some element's
///                                                       label/title/value contains `text`; logs how long it took
///   {"op":"waitGone","text":"…","timeoutMs":5000}       the opposite
///   {"op":"focus","label":"Handoff note"}               click the text field with that AX label / placeholder
///   {"op":"type","text":"hi","field":true}              with field:true (also for "key"), refuses unless a text field has focus
///                                                       (so text can never reach the device screen)
///   {"op":"screenshot","path":"/tmp/x.png","sheet":false}  screencapture -l of the window (or its sheet)
///   {"op":"settings","tab":"general"}                    open the Settings window on a tab: general | agents | advanced
///   {"op":"screenshotWindow","path":"/tmp/s.png","title":"Settings"}  capture another app window (title or
///                                                       identifier contains `title`; "Settings" matches the Settings window)
///   {"op":"closeWindow","title":"Settings"}             close that window
///   {"op":"frameOf","name":"device-frame"}              log an anchor's frame in window points (top-left origin)
///   {"op":"dumpMenu","menus":["Device"]}              log main-menu items and shortcuts
///   {"op":"menu","menu":"Device","item":"Hand Back"}    run a main-menu item by title (submenus searched; a
///                                                       trailing "…" is optional); fails if it's missing or disabled
///   {"op":"clearSelection"}                             deselect (shows the "Select a Device" state)
///   {"op":"stallFrames"}                                stop the frame loop but keep the last frame (stale screen)
///   {"op":"highlight","x":100,"y":200,"w":400,"h":120}  draw the UI-tree highlight (device pixels); no args clears it
///   {"op":"inspectorTab","tab":"apps"}                  switch the inspector tab (names as for PHONEDOCK_APP_TAB)
///   {"op":"logScope","scope":"front"}                   Logs tab: "all", "front" (app in front) or an app id
///   {"op":"notifications"}                              log notification permission, buttons, last posted, Dock badge
///   {"op":"selectElement","text":"Greet"}               select the first Elements row containing `text` (as a click
///                                                       would; `click` on a row works too)
///   {"op":"elementBounds","line":"e6 Button @(179,551) 231x126","expect":"63,488,231,126"}  check the Elements-row
///                                                       parser (the rect the stage highlights for that row)
///   {"op":"recordWindow","path":"/tmp/w.mov","fps":30,"scale":2,"codec":"prores"}  start recording the main
///                                                       window through ScreenCaptureKit (WindowRecorder.swift): ProRes
///                                                       4444 with alpha, or "codec":"h264". Sheets aren't in it.
///   {"op":"stopRecordWindow"}                           finish the movie (also done at the end of a run)
///   {"op":"tapText","text":"Password"}                  find an element on the selected device (daemon /find) and
///                                                       click its centre on the live screen (input as the person)
///   {"op":"waitFile","path":"/tmp/x","timeoutMs":600000}  wait until a file exists (an outside script's signal)
/// Each step is logged to stderr and to `$PHONEDOCK_APP_SELFTEST_LOG` (default: `<script>.log`).
/// The script starts when the main window appears; `tap`/`drag` wait for a device screen to be on screen.
@MainActor
enum SelfTest {
    private static var started = false
    private static var logURL: URL?
    private static weak var screenView: DeviceScreenNSView?
    static weak var model: AppModel?
    static weak var frameLoop: FrameLoop?
    /// Set by the root view (SwiftUI's openSettings action); `showSettingsWindow:` is blocked on macOS 14+.
    static var openSettings: (() -> Void)?
    /// Set by the root view: drives the UI-tree highlight binding.
    static var setHighlight: ((CGRect?) -> Void)?
    /// Set by the root view: shows or hides the inspector.
    static var setInspector: ((Bool) -> Void)?
    /// Set by the root view: switches the inspector's tab.
    static var setInspectorTab: ((InspectorTab) -> Void)?
    /// Set by the Elements tab: selects the first row containing the text; returns that row (nil: no match).
    static var selectElement: ((String) -> String?)?
    /// Set by the Logs tab while shown: "all", "front", or an app id.
    static var setLogScope: ((String) -> Void)?
    private static var failures = 0
    nonisolated static let enabled = !(ProcessInfo.processInfo.environment["PHONEDOCK_APP_SELFTEST"] ?? "").isEmpty
    /// Self-tests run behind the user's windows and never take focus, so whoever is at the Mac can keep working.
    /// `PHONEDOCK_APP_SELFTEST_FOREGROUND=1` restores the old behaviour (activate, key-window styling).
    nonisolated static let background = enabled && ProcessInfo.processInfo.environment["PHONEDOCK_APP_SELFTEST_FOREGROUND"] != "1"

    /// Background runs never bring another app or a new window forward (Finder, Simulator, scrcpy, System Settings, an
    /// editor, an app-modal alert, a notification prompt). Those call sites ask first: true means skip it; the attempt
    /// is logged as "BLOCKED …" so a run still shows that the button worked.
    static func blocksForeground(_ what: String) -> Bool {
        guard background else { return false }
        log("BLOCKED in a background run: \(what)")
        return true
    }

    private final class Weak { weak var view: NSView?; init(_ v: NSView) { view = v } }
    private static var anchors: [String: [Weak]] = [:]

    static func register(_ v: SelfTestAnchor.AnchorView) {
        var list = (anchors[v.name] ?? []).filter { $0.view != nil && $0.view !== v }
        list.append(Weak(v))
        anchors[v.name] = list
    }

    /// Scrolls an anchor into view (SwiftUI ScrollViews are NSScrollViews) and returns its window + centre.
    private static func anchorTarget(_ name: String) async -> (NSWindow, CGRect)? {
        guard let v = anchor(name) else { return nil }
        if let sv = v.enclosingScrollView, let doc = sv.documentView {
            let r = v.convert(v.bounds, to: doc)
            if !doc.visibleRect.contains(r) { doc.scrollToVisible(r.insetBy(dx: 0, dy: -12)); try? await Task.sleep(nanoseconds: 250_000_000) }
        }
        // Wait for the frame to settle (insert transitions slide views in).
        var last = v.convert(v.bounds, to: nil)
        for _ in 0..<20 {
            try? await Task.sleep(nanoseconds: 60_000_000)
            let f = v.convert(v.bounds, to: nil)
            if f == last { break }
            last = f
        }
        guard let w = v.window else { return nil }
        return (w, last)
    }

    /// Draws a window's views into a PNG without the window server. Background runs need it: once a sheet is up on a
    /// window that's behind other apps, `screencapture -l` can't capture it. (Live device frames and vibrancy draw flat.)
    private static func render(_ win: NSWindow, to path: String) -> Bool {
        guard let view = win.contentView?.superview ?? win.contentView,
              let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return false }
        view.cacheDisplay(in: view.bounds, to: rep)
        guard let data = rep.representation(using: .png, properties: [:]) else { return false }
        return (try? data.write(to: URL(fileURLWithPath: path))) != nil
    }

    /// Where keyboard events go: the sheet if one is up, else the main window.
    private static func keyTarget(_ w: NSWindow) -> NSWindow { w.attachedSheet ?? w }

    /// The most recently attached, still-visible anchor with that name (sheet windows included).
    private static func anchor(_ name: String) -> NSView? {
        let key = anchors[name] != nil ? name : anchors.keys.first { norm($0) == norm(name) }
        return key.flatMap { anchors[$0] }?.reversed().compactMap(\.view).first { v in
            guard let w = v.window, w.isVisible, !v.isHiddenOrHasHiddenAncestor else { return false }
            return v.bounds.width > 0 && v.bounds.height > 0
        }
    }

    /// Called by the device screen view when it joins a window.
    static func startIfRequested(screen: DeviceScreenNSView) {
        screenView = screen
        if let w = screen.window { startIfRequested(window: w) }
    }

    static func startIfRequested(window: NSWindow) {
        guard !started, let path = ProcessInfo.processInfo.environment["PHONEDOCK_APP_SELFTEST"], !path.isEmpty else { return }
        started = true
        logURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["PHONEDOCK_APP_SELFTEST_LOG"] ?? path + ".log")
        try? Data().write(to: logURL!)
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let steps = obj["steps"] as? [[String: Any]] else { log("FAIL cannot read script \(path)"); return }
        log("START window=\(window.windowNumber) steps=\(steps.count)\(background ? " background" : "")\(ActiveLook.on ? " activeLook" : "")")
        if background { window.orderBack(nil) }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            if background { window.orderBack(nil) }
            if ActiveLook.on { ActiveLook.refresh() }
            for (i, s) in steps.enumerated() { await run(i, s, window) }
            if WindowRecorder.current != nil, let (path, n, secs, err) = await WindowRecorder.stop() {
                log("stopRecordWindow (end of run) \(path) frames=\(n) seconds=\(String(format: "%.1f", secs))\(err.map { " error=\($0)" } ?? "")")
            }
            log(failures == 0 ? "DONE" : "DONE with \(failures) failure(s)")
            if ProcessInfo.processInfo.environment["PHONEDOCK_APP_SELFTEST_QUIT"] == "1" {
                // An open sheet can veto terminate(); close sheets first and hard-exit if quitting still stalls.
                for win in NSApp.windows { if let sh = win.attachedSheet { win.endSheet(sh) } }
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { exit(0) }
                NSApp.terminate(nil)
            }
        }
    }

    private static let stamp: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }()

    static func log(_ s: String) {
        let line = "[selftest] \(stamp.string(from: Date())) \(s)\n"
        FileHandle.standardError.write(line.data(using: .utf8)!)
        if let u = logURL, let h = try? FileHandle(forWritingTo: u) { h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); try? h.close() }
    }

    private static func num(_ s: [String: Any], _ k: String) -> CGFloat { CGFloat((s[k] as? NSNumber)?.doubleValue ?? 0) }

    private static func fail(_ s: String) { failures += 1; log(s) }

    /// The live device screen, waiting up to 10 s for it.
    private static func screen() async -> DeviceScreenNSView? {
        for _ in 0..<100 {
            if let v = screenView, v.window != nil { return v }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        return nil
    }

    private static func run(_ i: Int, _ s: [String: Any], _ mainWindow: NSWindow) async {
        let op = s["op"] as? String ?? ""
        let w = mainWindow
        switch op {
        case "wait":
            try? await Task.sleep(nanoseconds: UInt64(num(s, "ms")) * 1_000_000)
        case "badge":      // Dock badge check: {"op":"badge","expect":"1"} (use "" for none)
            let got = NSApp.dockTile.badgeLabel ?? ""
            let want = s["expect"] as? String
            if let want, want != got { fail("#\(i) badge FAIL got \"\(got)\" want \"\(want)\"") } else { log("#\(i) badge \"\(got)\"") }
        case "notifications":   // log notification permission, the HANDOFF category's buttons, and the last one posted
            let text: String = await withCheckedContinuation { cont in HandoffNotifier.shared.describe { cont.resume(returning: $0) } }
            log("#\(i) notifications \(text) dockBadge=\"\(NSApp.dockTile.badgeLabel ?? "")\"")
        case "fakeScreenError":   // render a frame failure without touching any device: {"message":"…","hints":[…]}
            guard let f = frameLoop else { fail("#\(i) fakeScreenError FAIL no device screen"); return }
            let e = APIError(status: 502, code: s["code"] as? String ?? "screenshot_failed", message: s["message"] as? String ?? "Screenshot failed",
                             hints: s["hints"] as? [String] ?? [])
            f.injectFailure(e)
            log("#\(i) fakeScreenError")
        case "appearance": // {"op":"appearance","mode":"light"|"dark"|"system"}
            let mode = s["mode"] as? String ?? "system"
            NSApp.appearance = mode == "light" ? NSAppearance(named: .aqua) : mode == "dark" ? NSAppearance(named: .darkAqua) : nil
            try? await Task.sleep(nanoseconds: 400_000_000)
            log("#\(i) appearance \(mode)")
        case "toast":      // render a toast without a failure: {"op":"toast","title":"…","message":"…","details":"…"}
            guard let m = model else { fail("#\(i) toast FAIL no model"); return }
            let kind: Toast.Kind = s["kind"] as? String == "success" ? .success : s["kind"] as? String == "info" ? .info : .error
            var t = Toast(kind: kind, title: s["title"] as? String ?? "Toast", message: s["message"] as? String, details: s["details"] as? String)
            if let a = s["action"] as? String { t.actionTitle = a; t.action = {} }
            m.toast = t
            log("#\(i) toast")
        case "fakeBusy":   // show a long operation without running it: {"op":"fakeBusy","device":"…","label":"Saving snapshot…"}; "" clears
            let want = s["device"] as? String ?? ""
            guard let m = model, let d = m.devices.first(where: { $0.id == want || $0.name == want }) else { fail("#\(i) fakeBusy \"\(want)\" FAIL not found"); return }
            let label = s["label"] as? String ?? ""
            m.busy[d.id] = label.isEmpty ? nil : label
            log("#\(i) fakeBusy \(d.name) \"\(label)\"")
        case "problem":    // the blocking alert: {"op":"problem","title":"…","message":"…","details":"…"}; title "" closes it
            guard let m = model else { fail("#\(i) problem FAIL no model"); return }
            let title = s["title"] as? String ?? ""
            m.problem = title.isEmpty ? nil : FriendlyError(title: title, message: s["message"] as? String, details: s["details"] as? String)
            log("#\(i) problem")
        case "defaults":   // set a preference the UI reads with @AppStorage: {"op":"defaults","key":"connect.kind","value":"android"}
            guard let key = s["key"] as? String else { fail("#\(i) defaults FAIL no key"); return }
            UserDefaults.standard.set(s["value"], forKey: key)
            try? await Task.sleep(nanoseconds: 300_000_000)
            log("#\(i) defaults \(key)")
        case "inspector":  // {"op":"inspector","show":false}
            guard let set = setInspector else { fail("#\(i) inspector FAIL no hook"); return }
            let show = s["show"] as? Bool ?? true
            set(show)
            try? await Task.sleep(nanoseconds: 500_000_000)
            log("#\(i) inspector \(show)")
        case "windowSize": // {"op":"windowSize","w":960,"h":640} content size in points (clamped to the minimum)
            let size = CGSize(width: num(s, "w"), height: num(s, "h"))
            w.setContentSize(size)
            w.center()
            try? await Task.sleep(nanoseconds: 500_000_000)
            log("#\(i) windowSize \(Int(w.frame.width))x\(Int(w.frame.height))")
        case "contextMenu", "toolbarMenu":
            // {"op":"contextMenu","device":"Pixel","item":"Copy Device ID"} – the right-click menu of a sidebar row
            //   ("anchor":"<name>" or "wx"/"wy" window points for any other view); logs its items without opening it
            // {"op":"toolbarMenu","label":"Add","item":"New Device"} – a toolbar pull-down (＋ ▾, Power ▾) the same way
            // "item" (optional) runs that item as choosing it would; a disabled item fails.
            var menu: NSMenu?
            var whereText = ""
            if op == "toolbarMenu" {
                let label = s["label"] as? String ?? ""
                let items = w.toolbar?.items ?? []
                let hit = items.first { [$0.label, $0.paletteLabel, $0.toolTip ?? "", $0.title].contains { !$0.isEmpty && Self.sameTitle($0, label) } }
                    ?? items.first { [$0.label, $0.toolTip ?? ""].contains { !$0.isEmpty && $0.localizedCaseInsensitiveContains(label) } }
                guard let hit else {
                    fail("#\(i) toolbarMenu \"\(label)\" FAIL no toolbar item; items: \(items.map { $0.label.isEmpty ? ($0.toolTip ?? $0.itemIdentifier.rawValue) : $0.label }.joined(separator: " | "))"); return
                }
                menu = (hit as? NSMenuToolbarItem)?.menu ?? hit.view.flatMap(firstMenu(in:))
                whereText = "toolbar \"\(hit.label)\""
            } else {
                var p: CGPoint?, win = w
                if let dev = s["device"] as? String, let m = model, let d = m.devices.first(where: { $0.id == dev || $0.name == dev }),
                   let (aw, f) = await anchorTarget("row-\(d.name)") { p = CGPoint(x: f.midX, y: f.midY); win = aw; whereText = "row \(d.name)" }
                else if let a = s["anchor"] as? String, let (aw, f) = await anchorTarget(a) { p = CGPoint(x: f.midX, y: f.midY); win = aw; whereText = "anchor \(a)" }
                else if s["wx"] != nil { p = CGPoint(x: num(s, "wx"), y: (w.contentView?.bounds.height ?? 0) - num(s, "wy")); whereText = "window point" }
                guard let p else { fail("#\(i) contextMenu FAIL nothing to right-click (device, anchor or wx/wy)"); return }
                let ev = NSEvent.mouseEvent(with: .rightMouseDown, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                            windowNumber: win.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
                var v = (win.contentView?.superview ?? win.contentView)?.hitTest(p)
                while let cur = v, menu == nil { menu = cur.menu(for: ev); v = cur.superview }
            }
            guard let menu else { fail("#\(i) \(op) FAIL no menu at \(whereText)"); return }
            menu.delegate?.menuNeedsUpdate?(menu)
            menu.delegate?.menuWillOpen?(menu)   // SwiftUI fills toolbar pull-downs as they open
            try? await Task.sleep(nanoseconds: 100_000_000)
            menu.update()
            defer { menu.delegate?.menuDidClose?(menu) }
            if menu.items.isEmpty {
                fail("#\(i) \(op) FAIL \(whereText): the menu is built only when it opens (SwiftUI toolbar pull-downs). "
                     + "Their items are in the main menus: use dumpMenu / menu on File, Device and Help.")
                return
            }
            let lines = menu.items.filter { !$0.isHidden }.map { it in
                it.isSeparatorItem ? "  —" : "  \(it.title)\(it.isAlternate ? " (⌥ alt)" : "")\(it.isEnabled ? "" : " [disabled]")\(it.submenu != nil ? " ›" : "")"
            }
            log("#\(i) \(op) \(whereText)\n" + lines.joined(separator: "\n"))
            if let want = s["item"] as? String {
                guard let (m, idx) = Self.menuItem(want, in: menu) else { fail("#\(i) \(op) FAIL no item \"\(want)\""); return }
                guard m.items[idx].isEnabled else { fail("#\(i) \(op) FAIL \"\(want)\" is disabled"); return }
                m.performActionForItem(at: idx)
                log("#\(i) \(op) ran \"\(m.items[idx].title)\"")
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
        case "activeLook": // {"op":"activeLook","on":false}: draw with the active (key window) look or not; see ActiveLook
            let on = s["on"] as? Bool ?? true
            ActiveLook.set(on)
            try? await Task.sleep(nanoseconds: 400_000_000)
            func probe(_ name: String) -> String {
                let sel = NSSelectorFromString(name)
                guard w.responds(to: sel), let imp = w.method(for: sel) else { return "\(name)=n/a" }
                typealias G = @convention(c) (AnyObject, Selector) -> Bool
                return "\(name)=\(unsafeBitCast(imp, to: G.self)(w, sel))"
            }
            log("#\(i) activeLook \(on) (answers: \(ActiveLook.replaced.joined(separator: ", "))) now: "
                + ["isKeyWindow", "hasKeyAppearance", "_hasActiveAppearance"].map(probe).joined(separator: " ") + " active=\(NSApp.isActive)")
        case "mark":       // a sync point for an outside driver (it polls the log for "MARK <text>")
            log("MARK \(s["text"] as? String ?? "")")
        case "recordWindow":
            let path = s["path"] as? String ?? "/tmp/phonedock-window.mov"
            let fps = Int(num(s, "fps")) > 0 ? Int(num(s, "fps")) : 30
            let scale = num(s, "scale") > 0 ? num(s, "scale") : w.backingScaleFactor
            do {
                let what = try await WindowRecorder.start(window: w, path: path, fps: fps, scale: scale, codec: s["codec"] as? String ?? "prores")
                log("#\(i) recordWindow \(path) \(what) fps=\(fps)")
            } catch { fail("#\(i) recordWindow FAIL \(error.localizedDescription)") }
        case "waitFile":   // {"op":"waitFile","path":"/tmp/agent-done","timeoutMs":600000} – an outside script's signal
            let path = s["path"] as? String ?? ""
            let timeout = (s["timeoutMs"] as? NSNumber)?.doubleValue ?? 60000
            let t0 = Date()
            while !FileManager.default.fileExists(atPath: path) {
                if Date().timeIntervalSince(t0) * 1000 > timeout { fail("#\(i) waitFile \(path) FAIL timeout"); return }
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
            log("#\(i) waitFile \(path) ok after \(Int(Date().timeIntervalSince(t0) * 1000))ms")
        case "tapText":    // {"op":"tapText","text":"Password","type":"TextField"}: find it on the selected device (daemon
                           // /find), then click its centre on the live screen, as a person would
            let q = s["text"] as? String ?? ""
            guard let m = model, let c = m.client, let id = m.selection else { fail("#\(i) tapText FAIL no device selected"); return }
            var body: [String: Any] = ["text": q, "limit": 1]
            if let t = s["type"] as? String { body["type"] = t }
            guard let data = try? await c.send("POST", c.dev(id, "/find"), json: body),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let match = obj["match"] as? [String: Any], let center = match["center"] as? [String: Any],
                  let x = (center["x"] as? NSNumber)?.doubleValue, let y = (center["y"] as? NSNumber)?.doubleValue else {
                fail("#\(i) tapText \"\(q)\" FAIL not found"); return
            }
            guard let v = await screen() else { fail("#\(i) tapText FAIL no device screen"); return }
            let p = windowPoint(v, CGPoint(x: x, y: y))
            log("#\(i) tapText \"\(q)\" device=(\(Int(x)),\(Int(y))) window=\(p)")
            // Wait until the tap is in the device's action log (it's written when the tap is done; a simulator tap can
            // take seconds), so the next step (usually typing) goes to the focused field. Click once more after 10 s.
            func lastTapAt() async -> String? {
                guard let e = try? await c.get([JSONValue].self, c.dev(id, "/actions"), query: ["limit": "5"]) else { return nil }
                return e.last(where: { $0["action"]?["action"]?.stringValue == "tap" })?["at"]?.stringValue
            }
            let before = await lastTapAt()
            for attempt in 1...2 {
                await click(w, p, allowScreen: true)
                var landed = false
                let clicked = Date()
                for _ in 0..<50 {
                    try? await Task.sleep(nanoseconds: 200_000_000)
                    if let t = await lastTapAt(), t != before { landed = true; break }
                }
                if landed { log("#\(i) tapText tap logged after \(Int(Date().timeIntervalSince(clicked) * 1000))ms"); break }
                log("#\(i) tapText \"\(q)\" no tap in the action log 10 s after click \(attempt)\(attempt == 1 ? "; clicking again" : "")")
            }
        case "stopRecordWindow":
            guard let (path, n, secs, err) = await WindowRecorder.stop() else { fail("#\(i) stopRecordWindow FAIL not recording"); return }
            if let err, n == 0 { fail("#\(i) stopRecordWindow FAIL \(err)"); return }
            log("#\(i) stopRecordWindow \(path) frames=\(n) seconds=\(String(format: "%.1f", secs))\(err.map { " error=\($0)" } ?? "")")
        case "activate":   // bring the app forward so selection/focus styling is the active one
            if background { log("#\(i) activate skipped (background run; set PHONEDOCK_APP_SELFTEST_FOREGROUND=1 to allow)"); return }
            NSApp.activate()
            NSRunningApplication.current.activate(options: [.activateAllWindows])
            w.makeKeyAndOrderFront(nil)
            try? await Task.sleep(nanoseconds: 300_000_000)
            log("#\(i) activate active=\(NSApp.isActive) key=\(w.isKeyWindow)")
        case "select":
            let want = s["device"] as? String ?? ""
            guard let m = model, let d = m.devices.first(where: { $0.id == want || $0.name == want }) else { fail("#\(i) select \"\(want)\" FAIL not found"); return }
            m.selection = d.id
            log("#\(i) select \(d.name) [\(d.id)]")
        case "sheet":
            let name = s["name"] as? String ?? ""
            guard let m = model else { fail("#\(i) sheet FAIL no model"); return }
            switch name {
            case "connect": m.showConnect = true
            case "create": m.showCreate = true
            case "agent": m.showAgentSetup = true
            case "none": m.showConnect = false; m.showCreate = false; m.showAgentSetup = false
            default: fail("#\(i) sheet \(name) FAIL unknown"); return
            }
            log("#\(i) sheet \(name)")
        case "waitFor", "waitGone":
            let text = s["text"] as? String ?? ""
            let timeout = (s["timeoutMs"] as? NSNumber)?.doubleValue ?? 5000
            let t0 = Date()
            while true {
                let found = anchor(text) != nil || findElement(containing: text, in: w) != nil
                if found == (op == "waitFor") { log("#\(i) \(op) \"\(text)\" ok after \(Int(Date().timeIntervalSince(t0) * 1000))ms"); return }
                if Date().timeIntervalSince(t0) * 1000 > timeout { fail("#\(i) \(op) \"\(text)\" FAIL timeout \(Int(timeout))ms"); return }
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
        case "focus":      // {"op":"focus","label":"Device name"}: an anchor, or a text field by label or placeholder
            let label = s["label"] as? String ?? ""
            let win: NSWindow, p: CGPoint
            if let (aw, f) = await anchorTarget(label) {
                win = aw; p = CGPoint(x: f.midX, y: f.midY)
            } else if let (tf, aw) = findTextField(label, in: w) {
                let f = tf.convert(tf.bounds, to: nil); win = aw; p = CGPoint(x: f.midX, y: f.midY)
            } else if let (el, aw) = findField(label, in: w) {
                let f = el.accessibilityFrame(); win = aw; p = aw.convertPoint(fromScreen: CGPoint(x: f.midX, y: f.midY))
            } else {
                fail("#\(i) focus \"\(label)\" FAIL not found. Text fields: \(textFieldNames(in: w).joined(separator: " | "))")
                return
            }
            log("#\(i) focus \"\(label)\" click window=\(p)\(win === w ? "" : " (sheet)")")
            await click(win, p)
        case "screenshot":
            let path = s["path"] as? String ?? "/tmp/phonedock-selftest.png"
            // A popover (Can't Do It's reason, a note) is its own window: "popover":true captures it instead.
            var popover: NSWindow?
            if s["popover"] as? Bool == true {
                popover = NSApp.windows.last { $0.isVisible && String(describing: type(of: $0)).contains("Popover") }
                if popover == nil { fail("#\(i) screenshot FAIL no popover is open"); return }
            }
            let target = popover ?? ((s["sheet"] as? Bool ?? false) ? (w.attachedSheet ?? w) : w)
            func capture(_ win: NSWindow) -> Int32 {
                let p = Process()
                p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
                p.arguments = ["-x", "-o", "-l", String(win.windowNumber), path]
                p.standardError = FileHandle.nullDevice
                do { try p.run(); p.waitUntilExit(); return p.terminationStatus } catch { return -1 }
            }
            if s["render"] as? Bool == true {   // draw in-process (what the app draws, without the window server)
                target.displayIfNeeded()
                if render(target, to: path) { log("#\(i) screenshot \(path) window=\(target.windowNumber) (drawn in-process)") }
                else { fail("#\(i) screenshot FAIL render") }
                return
            }
            var used = target, status = capture(target)
            // screencapture fails now and then while another capture is running: retry before giving up.
            for _ in 0..<3 where status != 0 {
                try? await Task.sleep(nanoseconds: 400_000_000)
                status = capture(target)
            }
            if status != 0, background, render(target, to: path) { log("#\(i) screenshot \(path) window=\(target.windowNumber) (drawn in-process: background run)"); return }
            if status != 0, target !== w { used = w; status = capture(w) }   // sheet windows can't always be captured alone
            if status == 0 { log("#\(i) screenshot \(path) window=\(used.windowNumber)") }
            else { fail("#\(i) screenshot FAIL screencapture status \(status)") }
        case "settings":   // {"op":"settings","tab":"general|agents|advanced"}
            if let tab = s["tab"] as? String { UserDefaults.standard.set(tab, forKey: Prefs.settingsTab) }
            guard let open = openSettings else { fail("#\(i) settings FAIL no openSettings action"); return }
            open()
            try? await Task.sleep(nanoseconds: 900_000_000)
            let win = otherWindow("Settings", main: w)
            if background { win?.orderBack(nil) }
            log("#\(i) settings tab=\(s["tab"] as? String ?? "-") window=\(win.map { "\($0.windowNumber) \"\($0.title)\"" } ?? "none")")
        case "screenshotWindow":   // {"op":"screenshotWindow","path":"…","title":"Settings"}
            let path = s["path"] as? String ?? "/tmp/phonedock-window.png"
            guard let win = otherWindow(s["title"] as? String ?? "", main: w) else { fail("#\(i) screenshotWindow FAIL no window"); return }
            func capture() -> Int32 {
                let p = Process()
                p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
                p.arguments = ["-x", "-o", "-l", String(win.windowNumber), path]
                p.standardError = FileHandle.nullDevice
                do { try p.run(); p.waitUntilExit(); return p.terminationStatus } catch { return -1 }
            }
            var status = capture()
            for _ in 0..<3 where status != 0 {   // see "screenshot": retry transient failures
                try? await Task.sleep(nanoseconds: 400_000_000)
                status = capture()
            }
            if status == 0 { log("#\(i) screenshotWindow \(path) window=\(win.windowNumber)") }
            else if background, render(win, to: path) { log("#\(i) screenshotWindow \(path) window=\(win.windowNumber) (drawn in-process: background run)") }
            else { fail("#\(i) screenshotWindow FAIL screencapture status \(status)") }
        case "closeWindow":   // {"op":"closeWindow","title":"Settings"}
            guard let win = otherWindow(s["title"] as? String ?? "", main: w) else { fail("#\(i) closeWindow FAIL no window"); return }
            win.close()
            log("#\(i) closeWindow \(win.windowNumber)")
        case "frameOf":   // {"op":"frameOf","name":"device-frame"} – window points, top-left origin
            let name = s["name"] as? String ?? ""
            guard let v = anchor(name), let win = v.window else { fail("#\(i) frameOf \"\(name)\" FAIL not found"); return }
            let r = v.convert(v.bounds, to: nil)
            let h = win.contentView?.bounds.height ?? win.frame.height
            log("#\(i) frameOf \"\(name)\" x=\(Int(r.minX)) y=\(Int(h - r.maxY)) w=\(Int(r.width)) h=\(Int(r.height))")
        case "dumpMenu":   // {"op":"dumpMenu","menus":["File","Device"]} logs items with their shortcuts
            let want = s["menus"] as? [String]
            var lines: [String] = []
            for top in NSApp.mainMenu?.items ?? [] where want == nil || want!.contains(top.title) {
                lines.append("[\(top.title)]")
                if let sub = top.submenu {   // what AppKit does when the menu opens
                    sub.delegate?.menuNeedsUpdate?(sub)
                    sub.delegate?.menuWillOpen?(sub)
                    sub.update()
                    sub.delegate?.menuDidClose?(sub)
                }
                for it in top.submenu?.items ?? [] where !it.isHidden {   // what the menu shows
                    if it.isSeparatorItem { lines.append("  —"); continue }
                    var m = ""
                    if it.keyEquivalentModifierMask.contains(.control) { m += "⌃" }
                    if it.keyEquivalentModifierMask.contains(.option) { m += "⌥" }
                    if it.keyEquivalentModifierMask.contains(.shift) { m += "⇧" }
                    if it.keyEquivalentModifierMask.contains(.command) { m += "⌘" }
                    let arrows: [Character: String] = ["\u{F700}": "↑", "\u{F701}": "↓", "\u{F702}": "←", "\u{F703}": "→",
                                                       "\u{8}": "⌫", "\u{7F}": "⌫"]
                    let k = it.keyEquivalent.first.flatMap { arrows[$0] } ?? it.keyEquivalent.uppercased()
                    let key = it.keyEquivalent.isEmpty ? (m.isEmpty ? "" : " " + m) : " " + m + k
                    lines.append("  \(it.title)\(key)\(it.isAlternate ? " (alt)" : "")\(it.isEnabled ? "" : " [disabled]")")
                }
            }
            log("#\(i) dumpMenu\n" + lines.joined(separator: "\n"))
        case "menu":   // {"op":"menu","menu":"Device","item":"Hand Back"} runs a main-menu item, as choosing it would
            let top = s["menu"] as? String ?? "", title = s["item"] as? String ?? ""
            guard let bar = NSApp.mainMenu?.items.first(where: { Self.sameTitle($0.title, top) }), let sub = bar.submenu else {
                let names = (NSApp.mainMenu?.items ?? []).map(\.title).filter { !$0.isEmpty }
                fail("#\(i) menu \"\(top)\" FAIL no such menu; menus: \(names.joined(separator: ", "))"); return
            }
            sub.delegate?.menuWillOpen?(sub)   // as when the menu opens; AppKit sends the action after it closes
            let found = Self.menuItem(title, in: sub)
            sub.delegate?.menuDidClose?(sub)
            guard let found else {
                let names = sub.items.filter { !$0.isSeparatorItem && !$0.isHidden }.map(\.title)
                fail("#\(i) menu \"\(top) › \(title)\" FAIL no such item; items: \(names.joined(separator: ", "))"); return
            }
            let (menu, index) = found
            guard menu.items[index].isEnabled else { fail("#\(i) menu \"\(top) › \(title)\" FAIL disabled"); return }
            menu.performActionForItem(at: index)
            log("#\(i) menu \"\(top) › \(menu.items[index].title)\"")
            try? await Task.sleep(nanoseconds: 150_000_000)
        case "clearSelection":
            guard let m = model else { fail("#\(i) clearSelection FAIL no model"); return }
            m.selection = nil
            log("#\(i) clearSelection")
        case "stallFrames":   // frames stop arriving; the last one stays up
            guard let f = frameLoop else { fail("#\(i) stallFrames FAIL no device screen"); return }
            f.stop()
            log("#\(i) stallFrames")
        case "highlight":
            guard let set = setHighlight else { fail("#\(i) highlight FAIL no hook"); return }
            let r = CGRect(x: num(s, "x"), y: num(s, "y"), width: num(s, "w"), height: num(s, "h"))
            set(r.width > 0 && r.height > 0 ? r : nil)
            log("#\(i) highlight \(r)")
        case "inspectorTab":
            let name = s["tab"] as? String ?? ""
            guard let t = InspectorTab.named(name) else { fail("#\(i) inspectorTab \"\(name)\" FAIL unknown tab"); return }
            guard let set = setInspectorTab else { fail("#\(i) inspectorTab FAIL no inspector"); return }
            set(t)
            try? await Task.sleep(nanoseconds: 300_000_000)
            log("#\(i) inspectorTab \(t.rawValue)")
        case "logScope":   // {"op":"logScope","scope":"front"} – "all", "front" or an app id, as the Logs menu would
            guard let set = setLogScope else { fail("#\(i) logScope FAIL Logs tab not shown"); return }
            set(s["scope"] as? String ?? "all")
            log("#\(i) logScope \(s["scope"] as? String ?? "all")")
        case "selectElement":
            let q = s["text"] as? String ?? ""
            guard let select = selectElement else { fail("#\(i) selectElement FAIL Elements tab not shown"); return }
            guard let row = select(q) else { fail("#\(i) selectElement \"\(q)\" FAIL no row"); return }
            try? await Task.sleep(nanoseconds: 300_000_000)
            log("#\(i) selectElement \(row)")
        case "elementBounds":
            let line = s["line"] as? String ?? ""
            let r = ElementsTab.bounds(line)
            let got = r.map { "\(Int($0.minX)),\(Int($0.minY)),\(Int($0.width)),\(Int($0.height))" } ?? "nil"
            if let want = s["expect"] as? String, want != got { fail("#\(i) elementBounds FAIL got \(got) want \(want)") }
            else { log("#\(i) elementBounds \(got)") }
        case "dumpAX":   // debugging aid: logs the AX tree (role, label/title/value) of the sheet or window
            let target = (s["sheet"] as? Bool ?? false) ? (w.attachedSheet ?? w) : w
            var lines: [String] = []
            func walk(_ e: Any, _ depth: Int) {
                guard lines.count < 400, depth < 40, let el = e as? NSAccessibilityProtocol else { return }
                lines.append(String(repeating: " ", count: depth) + "\(el.accessibilityRole()?.rawValue ?? "?") \(axStrings(el))")
                for k in el.accessibilityChildren() ?? [] { walk(k, depth + 1) }
            }
            walk(target, 0)
            log("#\(i) dumpAX window=\(target.windowNumber)\n" + lines.joined(separator: "\n"))
        case "tap":
            guard let v = await screen() else { fail("#\(i) tap FAIL no device screen"); return }
            let p = windowPoint(v, CGPoint(x: num(s, "x"), y: num(s, "y")))
            log("#\(i) tap device=(\(num(s, "x")),\(num(s, "y"))) window=\(p)")
            await click(w, p, allowScreen: true)
        case "drag":
            guard let v = await screen() else { fail("#\(i) drag FAIL no device screen"); return }
            let a = windowPoint(v, CGPoint(x: num(s, "x1"), y: num(s, "y1")))
            let b = windowPoint(v, CGPoint(x: num(s, "x2"), y: num(s, "y2")))
            let ms = max(50, num(s, "ms")), n = 10
            log("#\(i) drag window \(a) → \(b) over \(Int(ms))ms")
            w.sendEvent(mouse(.leftMouseDown, w, a))
            for k in 1...n {
                try? await Task.sleep(nanoseconds: UInt64(ms / CGFloat(n) * 1_000_000))
                let t = CGFloat(k) / CGFloat(n)
                w.sendEvent(mouse(.leftMouseDragged, w, CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)))
            }
            w.sendEvent(mouse(.leftMouseUp, w, b))
        case "type":
            let text = s["text"] as? String ?? ""
            let kw = keyTarget(w)
            log("#\(i) type \"\(text)\" firstResponder=\(kw.firstResponder.map { String(describing: type(of: $0)) } ?? "nil")")
            if s["field"] as? Bool == true, !(kw.firstResponder is NSText) { fail("#\(i) type FAIL no text field has focus (refusing)"); return }
            for ch in text { await key(kw, chars: String(ch), code: 0) }
        case "key":
            let code = UInt16(num(s, "keyCode"))
            let kw = keyTarget(w)
            log("#\(i) key keyCode=\(code) firstResponder=\(kw.firstResponder.map { String(describing: type(of: $0)) } ?? "nil")")
            if s["field"] as? Bool == true, !(kw.firstResponder is NSText) { fail("#\(i) key FAIL no text field has focus (refusing)"); return }
            let chars = code == 36 ? "\r" : code == 51 ? "\u{7F}" : ""
            await key(kw, chars: chars, code: code)
        case "click": // window coordinates, top-left origin (as in a window screenshot, in points);
                      // "sheet":true uses the attached sheet's coordinates (as in a "sheet":true screenshot)
            let target = s["sheet"] as? Bool == true ? (w.attachedSheet ?? w) : w
            if s["sheet"] as? Bool == true, target === w { fail("#\(i) click FAIL no sheet is open"); return }
            let p = CGPoint(x: num(s, "wx"), y: (target.contentView?.bounds.height ?? target.frame.height) - num(s, "wy"))
            log("#\(i) click window=\(p)\(target === w ? "" : " (sheet)") hit=\(String(describing: target.contentView?.hitTest(p).map { type(of: $0) }))")
            await click(target, p, allowScreen: s["screen"] as? Bool == true)
        case "choose":
            let label = s["label"] as? String ?? "", item = s["item"] as? String ?? ""
            log("#\(i) choose \"\(label)\" → \"\(item)\": \(choose(label, item, in: w))")
        case "button":
            let title = s["title"] as? String ?? ""
            var center = CGPoint.zero, f = CGRect.zero, target: NSWindow?
            if let (aw, af) = await anchorTarget(title) {
                f = af; center = CGPoint(x: af.midX, y: af.midY); target = aw
            }
            for win in [w.attachedSheet, w].compactMap({ $0 }) where target == nil {
                if let b = findNSButton(title, in: win.contentView) {
                    f = b.convert(b.bounds, to: nil); center = CGPoint(x: f.midX, y: f.midY); target = win; break
                } else if let el = findButton(title, in: win) {
                    f = el.accessibilityFrame() // screen coords, bottom-left origin
                    center = win.convertPoint(fromScreen: CGPoint(x: f.midX, y: f.midY)); target = win; break
                }
            }
            if target == nil {   // alerts and other app windows (NSAlert buttons are NSButtons)
                for win in NSApp.windows where win !== w && win.isVisible {
                    if let b = findNSButton(title, in: win.contentView) {
                        f = b.convert(b.bounds, to: nil); center = CGPoint(x: f.midX, y: f.midY); target = win; break
                    }
                }
            }
            guard let target else { fail("#\(i) button \"\(title)\" FAIL not found"); return }
            log("#\(i) button \"\(title)\" frame=\(f) click window=\(center)\(target === w ? "" : " (sheet)")")
            await click(target, center)
        default:
            log("#\(i) unknown op \(op)")
        }
    }

    /// Pop-up buttons and segmented controls in the sheet (first) and the window.
    private static func controls(in w: NSWindow) -> [(NSControl, NSWindow)] {
        var out: [(NSControl, NSWindow)] = []
        func walk(_ v: NSView, _ win: NSWindow) {
            if (v is NSPopUpButton || v is NSSegmentedControl), !v.isHiddenOrHasHiddenAncestor { out.append((v as! NSControl, win)) }
            for c in v.subviews { walk(c, win) }
        }
        for win in [w.attachedSheet, w].compactMap({ $0 }) { if let cv = win.contentView { walk(cv.superview ?? cv, win) } }
        return out
    }

    /// The text of the closest static label to the left of a control, on the same row (Form rows put it there).
    private static func leftLabel(of c: NSControl) -> String? {
        guard let win = c.window, let root = win.contentView?.superview ?? win.contentView else { return nil }
        let cf = c.convert(c.bounds, to: nil)
        var best: (CGFloat, String)?
        func walk(_ v: NSView) {
            if let t = v as? NSTextField, !t.isEditable, !t.stringValue.isEmpty, !v.isHiddenOrHasHiddenAncestor {
                let f = t.convert(t.bounds, to: nil)
                if abs(f.midY - cf.midY) < max(cf.height, f.height), f.maxX <= cf.minX + 2 {
                    let d = cf.minX - f.maxX
                    if best == nil || d < best!.0 { best = (d, t.stringValue) }
                }
            }
            for s in v.subviews { walk(s) }
        }
        walk(root)
        return best?.1
    }

    private static func controlNames(_ c: NSControl) -> [String] {
        var names = [c.accessibilityLabel(), c.accessibilityTitle(), anchorName(near: c), leftLabel(of: c)].compactMap { $0 }
        if let p = c as? NSPopUpButton { names.append(p.title) }
        return names.filter { !$0.isEmpty }
    }

    private static func choose(_ label: String, _ item: String, in w: NSWindow) -> String {
        let all = controls(in: w)
        let want = norm(label)
        let hits = all.filter { c in controlNames(c.0).contains { norm($0) == want } }
        func describe(_ c: NSControl) -> String {
            let items = (c as? NSPopUpButton)?.itemTitles ?? (0..<((c as? NSSegmentedControl)?.segmentCount ?? 0)).compactMap { (c as? NSSegmentedControl)?.label(forSegment: $0) }
            return "\"\(controlNames(c).first ?? "?")\" [\(items.joined(separator: " | "))]"
        }
        func pick(_ titles: [String]) -> Int? {
            let t = norm(item)
            return titles.firstIndex { norm($0) == t } ?? titles.firstIndex { norm($0).hasPrefix(t) } ?? titles.firstIndex { norm($0).contains(t) }
        }
        for (c, _) in hits {
            if let p = c as? NSPopUpButton {
                let titles = p.itemArray.map(\.title)
                guard let idx = pick(titles), p.itemArray[idx].isEnabled, !p.itemArray[idx].isSeparatorItem else { continue }
                p.selectItem(at: idx)
                if let m = p.menu { m.performActionForItem(at: idx) } else { _ = p.sendAction(p.action, to: p.target) }
                return "ok → \(titles[idx])"
            }
            if let sg = c as? NSSegmentedControl {
                let titles = (0..<sg.segmentCount).map { sg.label(forSegment: $0) ?? "" }
                guard let idx = pick(titles) else { continue }
                sg.selectedSegment = idx
                _ = sg.sendAction(sg.action, to: sg.target)
                return "ok → \(titles[idx])"
            }
        }
        failures += 1
        return "FAIL " + (hits.isEmpty ? "no control with that label. Controls: " + all.map { describe($0.0) }.joined(separator: " ; ")
                                      : "no such item. " + hits.map { describe($0.0) }.joined(separator: " ; "))
    }

    /// The first menu a view or one of its subviews carries (a pop-up's, or a view's `menu`).
    private static func firstMenu(in v: NSView) -> NSMenu? {
        if let m = (v as? NSPopUpButton)?.menu ?? v.menu { return m }
        for c in v.subviews { if let m = firstMenu(in: c) { return m } }
        return nil
    }

    /// Titles compare case-insensitively, ignoring a trailing "…" or "...", so "Delete" finds "Delete…".
    private static func sameTitle(_ a: String, _ b: String) -> Bool { norm(a) == norm(b) }

    /// Lower-case, curly quotes and apostrophes straightened, trailing "…" / "..." dropped.
    static func norm(_ s: String) -> String {
        var t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\u{2019}", with: "'").replacingOccurrences(of: "\u{2018}", with: "'")
            .replacingOccurrences(of: "\u{201C}", with: "\"").replacingOccurrences(of: "\u{201D}", with: "\"")
        if t.hasSuffix("…") { t.removeLast() } else if t.hasSuffix("...") { t.removeLast(3) }
        return t.trimmingCharacters(in: .whitespaces).lowercased()
    }

    /// The first visible item with that title in a menu or its submenus, after letting the menu update its items and
    /// their enabled state as it does when it opens.
    private static func menuItem(_ title: String, in menu: NSMenu) -> (NSMenu, Int)? {
        menu.delegate?.menuNeedsUpdate?(menu)
        menu.update()
        for (index, it) in menu.items.enumerated() where !it.isSeparatorItem && !it.isHidden {
            if sameTitle(it.title, title) { return (menu, index) }
            if let sub = it.submenu, let found = menuItem(title, in: sub) { return found }
        }
        return nil
    }

    /// A visible window other than the main one whose title or identifier contains `title` ("Settings" also
    /// matches SwiftUI's Settings window, whose title is the selected tab).
    private static func otherWindow(_ title: String, main: NSWindow) -> NSWindow? {
        NSApp.windows.first { win in
            guard win !== main, win.isVisible, win.windowNumber > 0 else { return false }
            let id = win.identifier?.rawValue ?? ""
            return title.isEmpty || win.title.contains(title) || id.contains(title) || (title == "Settings" && id.contains("Settings"))
        }
    }

    /// Device pixel → window coordinates, by inverting the aspect-fit mapping independently of DeviceScreenNSView.
    private static func windowPoint(_ v: DeviceScreenNSView, _ d: CGPoint) -> CGPoint {
        let W = v.devicePixelSize.width, H = v.devicePixelSize.height, b = v.bounds
        let sc = min(b.width / W, b.height / H)
        let ox = (b.width - W * sc) / 2, oy = (b.height - H * sc) / 2
        let local = CGPoint(x: ox + (d.x + 0.5) * sc, y: oy + (d.y + 0.5) * sc) // view is flipped (top-left origin)
        return v.convert(local, to: nil)
    }

    private static var evNum = 1000
    private static func mouse(_ t: NSEvent.EventType, _ w: NSWindow, _ p: CGPoint) -> NSEvent {
        evNum += 1
        return NSEvent.mouseEvent(with: t, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                  windowNumber: w.windowNumber, context: nil, eventNumber: evNum, clickCount: 1,
                                  pressure: t == .leftMouseUp ? 0 : 1)!
    }

    /// UI clicks must never land on the live device screen (that would send a tap to the phone).
    private static func hitsDeviceScreen(_ w: NSWindow, _ p: CGPoint) -> Bool {
        guard let cv = w.contentView else { return false }
        var v = (cv.superview ?? cv).hitTest(p)
        while let cur = v { if cur is DeviceScreenNSView { return true }; v = cur.superview }
        return false
    }

    /// The mouseUp goes into the event queue before the mouseDown is dispatched: views that track the mouse inside
    /// mouseDown (NSTableView/NSOutlineView rows, sliders, menus) pull it from the queue and return; for every other
    /// view the run loop delivers it right after. Sending it directly afterwards would hang a tracking loop.
    private static func click(_ w: NSWindow, _ p: CGPoint, allowScreen: Bool = false) async {
        if !allowScreen, hitsDeviceScreen(w, p) { fail("  click at \(p) REFUSED: it would land on the device screen"); return }
        let down = mouse(.leftMouseDown, w, p)
        let up = mouse(.leftMouseUp, w, p)
        NSApp.postEvent(up, atStart: false)
        w.sendEvent(down)
        try? await Task.sleep(nanoseconds: 120_000_000)
    }

    private static func key(_ w: NSWindow, chars: String, code: UInt16) async {
        for t in [NSEvent.EventType.keyDown, .keyUp] {
            if let e = NSEvent.keyEvent(with: t, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                        windowNumber: w.windowNumber, context: nil, characters: chars,
                                        charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code) {
                w.sendEvent(e)
            }
        }
        try? await Task.sleep(nanoseconds: 40_000_000)
    }

    /// Editable text fields in the attached sheet (first) and the window, with the strings `focus` matches on.
    private static func textFields(in w: NSWindow) -> [(NSTextField, NSWindow, [String])] {
        var out: [(NSTextField, NSWindow, [String])] = []
        func walk(_ v: NSView, _ win: NSWindow) {
            if let tf = v as? NSTextField, tf.isEditable, !tf.isHiddenOrHasHiddenAncestor {
                let names = [anchorName(near: tf), tf.accessibilityLabel(), tf.placeholderString,
                             tf.placeholderAttributedString?.string, tf.accessibilityTitle()]
                out.append((tf, win, names.compactMap { $0 }.filter { !$0.isEmpty }))
            }
            for c in v.subviews { walk(c, win) }
        }
        for win in [w.attachedSheet, w].compactMap({ $0 }) { if let cv = win.contentView { walk(cv.superview ?? cv, win) } }
        return out
    }

    private static func findTextField(_ label: String, in w: NSWindow) -> (NSTextField, NSWindow)? {
        let all = textFields(in: w)
        let hit = all.first { $0.2.contains(label) } ?? all.first { $0.2.contains { $0.localizedCaseInsensitiveContains(label) } }
        return hit.map { ($0.0, $0.1) }
    }

    private static func textFieldNames(in w: NSWindow) -> [String] {
        textFields(in: w).map { "\($0.2.map { "\"\($0)\"" }.joined(separator: "/"))\($0.1 === w ? "" : " (sheet)")" }
    }

    /// The anchor whose frame contains this view's centre, if any (anchors sit in a view's background).
    private static func anchorName(near v: NSView) -> String? {
        guard let win = v.window else { return nil }
        let c = v.convert(CGPoint(x: v.bounds.midX, y: v.bounds.midY), to: nil)
        for (name, list) in anchors {
            for a in list.compactMap(\.view) where a.window === win && a.convert(a.bounds, to: nil).contains(c) { return name }
        }
        return nil
    }

    private static func findNSButton(_ title: String, in v: NSView?) -> NSButton? {
        guard let v else { return nil }
        if let b = v as? NSButton, sameTitle(b.title, title) || sameTitle(b.accessibilityLabel() ?? "", title), !b.isHidden, !b.isHiddenOrHasHiddenAncestor { return b }
        for c in v.subviews { if let b = findNSButton(title, in: c) { return b } }
        return nil
    }

    private static func axStrings(_ el: NSAccessibilityProtocol) -> [String] {
        var out = [el.accessibilityLabel() ?? "", el.accessibilityTitle() ?? ""]
        if let v = el.accessibilityValue() as? String { out.append(v) }
        if let v = el.accessibilityValue() as? NSAttributedString { out.append(v.string) }
        if let ph = el.accessibilityPlaceholderValue() { out.append(ph) }
        return out.filter { !$0.isEmpty }
    }

    /// BFS over the window's (and its sheet's) accessibility tree.
    private static func axFirst(in w: NSWindow, _ match: (NSAccessibilityProtocol) -> Bool) -> (NSAccessibilityProtocol, NSWindow)? {
        for win in [w.attachedSheet, w].compactMap({ $0 }) {
            var queue: [Any] = [win]
            var seen = 0
            while !queue.isEmpty, seen < 20000 {
                let e = queue.removeFirst(); seen += 1
                guard let el = e as? NSAccessibilityProtocol else { continue }
                if match(el) { return (el, win) }
                if let kids = el.accessibilityChildren() { queue.append(contentsOf: kids) }
            }
        }
        return nil
    }

    private static func findElement(containing text: String, in w: NSWindow) -> NSAccessibilityProtocol? {
        axFirst(in: w) { el in axStrings(el).contains { $0.contains(text) } }?.0
    }

    private static func findField(_ label: String, in w: NSWindow) -> (NSAccessibilityProtocol, NSWindow)? {
        axFirst(in: w) { el in
            let r = el.accessibilityRole()
            return (r == .textField || r == .textArea) && axStrings(el).contains(label)
        }
    }

    private static func findButton(_ title: String, in w: NSWindow) -> NSAccessibilityProtocol? {
        var queue: [Any] = [w]
        var seen = 0
        while !queue.isEmpty, seen < 20000 {
            let e = queue.removeFirst(); seen += 1
            guard let el = e as? NSAccessibilityProtocol else { continue }
            let role = el.accessibilityRole()
            let label = el.accessibilityLabel() ?? ""
            let t = el.accessibilityTitle() ?? ""
            if role == .button, sameTitle(label, title) || sameTitle(t, title) { return el }
            if let kids = el.accessibilityChildren() { queue.append(contentsOf: kids) }
        }
        return nil
    }
}

/// Self-test only: draw PhoneDock's windows with the active (front-app, key-window) look while the app stays behind the
/// user's work, so background screenshots show what a person sees. On by default in background runs;
/// `PHONEDOCK_APP_SELFTEST_ACTIVE_LOOK=0` turns it off, and the `activeLook` op toggles it mid-run (for comparisons).
/// AppKit draws controls, selections and titles from the window's key/main *appearance* getters rather than from
/// `isKeyWindow`, so those are answered too (public and AppKit-internal names, looked up at run time and skipped if a
/// macOS release drops them); then each window re-sends its key-state change so views redraw. Nothing is activated or
/// ordered front. The window server draws some chrome itself, so not everything follows.
@MainActor
enum ActiveLook {
    nonisolated(unsafe) static var on = false
    private static var installed = false
    /// The getters that were found and replaced (logged by the `activeLook` op).
    private(set) static var replaced: [String] = []

    static func installIfRequested() {
        guard SelfTest.background, ProcessInfo.processInfo.environment["PHONEDOCK_APP_SELFTEST_ACTIVE_LOOK"] != "0" else { return }
        install()
        on = true
    }

    static func install() {
        guard !installed else { return }
        installed = true
        // "Key": the window a person would be typing into (a sheet, or a window with no sheet on it).
        let key: (NSWindow) -> Bool = { $0.isVisible && $0.attachedSheet == nil }
        // "Main / active": every visible window that isn't a panel.
        let main: (NSWindow) -> Bool = { $0.isVisible && !($0 is NSPanel) }
        for g in ["isKeyWindow", "hasKeyAppearance", "_hasKeyAppearance", "_isKeyWindow", "_isKeyWindowIgnoringFocus"] {
            replace(NSWindow.self, g) { key($0 as! NSWindow) }
        }
        for g in ["isMainWindow", "hasMainAppearance", "_hasMainAppearance", "_hasActiveAppearance", "_hasActiveAppearanceIgnoringKeyFocus"] {
            replace(NSWindow.self, g) { main($0 as! NSWindow) }
        }
        replaceWithArg(NSWindow.self, "_hasActiveAppearanceForStandardWindowButton:") { main($0 as! NSWindow) }
        for g in ["isActive", "_isActiveApp"] { replace(NSApplication.self, g) { _ in true } }
    }

    private typealias Getter = @convention(c) (AnyObject, Selector) -> Bool
    private typealias GetterArg = @convention(c) (AnyObject, Selector, Int) -> Bool

    /// Replaces a BOOL getter: while the look is on it answers `answer`, otherwise it calls AppKit's original.
    private static func replace(_ cls: AnyClass, _ name: String, _ answer: @escaping @MainActor (AnyObject) -> Bool) {
        let sel = NSSelectorFromString(name)
        guard let m = class_getInstanceMethod(cls, sel) else { return }
        let original = unsafeBitCast(method_getImplementation(m), to: Getter.self)
        let block: @convention(block) (AnyObject) -> Bool = { obj in
            ActiveLook.on && Thread.isMainThread ? MainActor.assumeIsolated { answer(obj) } : original(obj, sel)
        }
        method_setImplementation(m, imp_implementationWithBlock(block))
        replaced.append(name)
    }

    private static func replaceWithArg(_ cls: AnyClass, _ name: String, _ answer: @escaping @MainActor (AnyObject) -> Bool) {
        let sel = NSSelectorFromString(name)
        guard let m = class_getInstanceMethod(cls, sel) else { return }
        let original = unsafeBitCast(method_getImplementation(m), to: GetterArg.self)
        let block: @convention(block) (AnyObject, Int) -> Bool = { obj, arg in
            ActiveLook.on && Thread.isMainThread ? MainActor.assumeIsolated { answer(obj) } : original(obj, sel, arg)
        }
        method_setImplementation(m, imp_implementationWithBlock(block))
        replaced.append(name)
    }

    /// Turns the look on or off and makes every window redraw with it.
    static func set(_ value: Bool) {
        if value { install() }
        on = value
        refresh()
    }

    /// Re-announces key/main/active so observers (SwiftUI's window state, AppKit controls) read the new answers.
    static func refresh() {
        let nc = NotificationCenter.default
        nc.post(name: on ? NSApplication.didBecomeActiveNotification : NSApplication.didResignActiveNotification, object: NSApp)
        for w in NSApp.windows where w.isVisible {
            nc.post(name: on ? NSWindow.didBecomeMainNotification : NSWindow.didResignMainNotification, object: w)
            nc.post(name: on ? NSWindow.didBecomeKeyNotification : NSWindow.didResignKeyNotification, object: w)
            // Tell the window (and through it the window server, which draws materials, selections and the traffic
            // lights) to use the active appearance.
            for name in ["_setForceMainAppearance:", "_setHasActiveAppearance:"] {
                let sel = NSSelectorFromString(name)
                guard w.responds(to: sel), let imp = w.method(for: sel) else { continue }
                typealias Setter = @convention(c) (AnyObject, Selector, Bool) -> Void
                unsafeBitCast(imp, to: Setter.self)(w, sel, on)
            }
            // AppKit's own key-state fan-out to every view (`-[NSView _windowChangedKeyState]`).
            for name in ["_sendForcedWindowChangedKeyState", "_changeKeyState"] {
                let sel = NSSelectorFromString(name)
                if w.responds(to: sel) { _ = w.perform(sel) }
            }
            func dirty(_ v: NSView) { v.needsDisplay = true; v.subviews.forEach(dirty) }
            if let root = w.contentView?.superview ?? w.contentView { dirty(root) }
            w.invalidateShadow()
            w.displayIfNeeded()
        }
    }
}
