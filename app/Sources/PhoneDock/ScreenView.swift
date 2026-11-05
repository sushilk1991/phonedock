import SwiftUI
import AppKit
import os.signpost

/// Callbacks from the interactive screen surface. Points are in *device pixels*.
struct ScreenInputHandlers {
    var tap: (CGPoint) -> Void = { _ in }
    var swipe: (CGPoint, CGPoint, Int) -> Void = { _, _, _ in }
    var type: (String) -> Void = { _ in }
    var key: (String) -> Void = { _ in }
    var dropFile: (URL) -> Void = { _ in }
    /// A file is being dragged over the screen (drives the "Drop to Install" overlay).
    var dropTargeted: (Bool) -> Void = { _ in }
}

/// NSView that shows the latest frame (aspect-fit) and translates mouse/keyboard into device input.
final class DeviceScreenNSView: NSView {
    var handlers = ScreenInputHandlers()
    var devicePixelSize = CGSize(width: 1080, height: 2400)
    var image: NSImage? { didSet {
        let id = OSSignpostID(log: perfLog)
        os_signpost(.begin, log: perfLog, name: "Layer update", signpostID: id)
        layer?.contents = image?.cgImage(forProposedRect: nil, context: nil, hints: nil)
        os_signpost(.end, log: perfLog, name: "Layer update", signpostID: id)
    } }
    /// Live video (FrameLoop.videoLayer), over `image`, filling the view; it draws itself.
    var videoLayer: CALayer? { didSet {
        guard videoLayer !== oldValue else { return }
        oldValue?.removeFromSuperlayer()
        if let v = videoLayer { layer?.addSublayer(v); needsLayout = true; layoutVideo() }
    } }

    private var downPoint: CGPoint?
    private var downTime: Date?
    private var scrollAccum = CGSize.zero
    private var scrollAnchor: CGPoint?
    private var scrollWork: DispatchWorkItem?
    private var typeBuffer = ""
    private var typeWork: DispatchWorkItem?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.contentsGravity = .resizeAspect
        layer?.backgroundColor = NSColor.black.cgColor
        registerForDraggedTypes([.fileURL])
    }
    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        layoutVideo()
    }

    private func layoutVideo() {
        guard let v = videoLayer, v.frame != bounds else { return }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        v.frame = bounds
        CATransaction.commit()
    }

    override var acceptsFirstResponder: Bool { true }
    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func resetCursorRects() { addCursorRect(bounds, cursor: .pointingHand) }

    /// Aspect-fit rect of the device image inside the view.
    private var contentRect: CGRect {
        let w = devicePixelSize.width, h = devicePixelSize.height
        guard w > 0, h > 0, bounds.width > 0, bounds.height > 0 else { return bounds }
        let s = min(bounds.width / w, bounds.height / h)
        let size = CGSize(width: w * s, height: h * s)
        return CGRect(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2, width: size.width, height: size.height)
    }

    private func toDevice(_ p: CGPoint) -> CGPoint {
        let r = contentRect
        let x = (p.x - r.minX) / r.width * devicePixelSize.width
        let y = (p.y - r.minY) / r.height * devicePixelSize.height
        return CGPoint(x: min(max(x, 0), devicePixelSize.width - 1).rounded(), y: min(max(y, 0), devicePixelSize.height - 1).rounded())
    }

    private func local(_ e: NSEvent) -> CGPoint { convert(e.locationInWindow, from: nil) }

    override func mouseDown(with e: NSEvent) {
        window?.makeFirstResponder(self)
        downPoint = local(e); downTime = Date()
    }

    override func mouseUp(with e: NSEvent) {
        guard let start = downPoint, let t0 = downTime else { return }
        let end = local(e)
        downPoint = nil
        let dist = hypot(end.x - start.x, end.y - start.y)
        if dist < 6 {
            handlers.tap(toDevice(start))
        } else {
            let ms = max(80, min(3000, Int(Date().timeIntervalSince(t0) * 1000)))
            handlers.swipe(toDevice(start), toDevice(end), ms)
        }
    }

    override func scrollWheel(with e: NSEvent) {
        if scrollAnchor == nil { scrollAnchor = local(e) }
        let k: CGFloat = e.hasPreciseScrollingDeltas ? 1 : 12
        scrollAccum.width += e.scrollingDeltaX * k
        scrollAccum.height += e.scrollingDeltaY * k
        scrollWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.flushScroll() }
        scrollWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12, execute: work)
    }

    private func flushScroll() {
        guard let a = scrollAnchor else { return }
        let r = contentRect
        let dx = max(-r.width * 0.8, min(r.width * 0.8, scrollAccum.width))
        let dy = max(-r.height * 0.8, min(r.height * 0.8, scrollAccum.height))
        scrollAccum = .zero; scrollAnchor = nil
        guard abs(dx) > 2 || abs(dy) > 2 else { return }
        let start = CGPoint(x: min(max(a.x, r.minX + 4), r.maxX - 4), y: min(max(a.y, r.minY + 4), r.maxY - 4))
        let end = CGPoint(x: min(max(start.x + dx, r.minX + 2), r.maxX - 2), y: min(max(start.y + dy, r.minY + 2), r.maxY - 2))
        handlers.swipe(toDevice(start), toDevice(end), 250)
    }

    override func keyDown(with e: NSEvent) {
        let special: [UInt16: String] = [36: "enter", 76: "enter", 51: "delete", 117: "delete", 53: "escape", 48: "tab",
                                         123: "left", 124: "right", 125: "down", 126: "up", 115: "home"]
        if e.modifierFlags.contains(.command) { super.keyDown(with: e); return }
        if let k = special[e.keyCode] {
            flushType()
            handlers.key(k)
            return
        }
        guard let chars = e.characters, !chars.isEmpty, chars.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else { return }
        typeBuffer += chars
        typeWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.flushType() }
        typeWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: work)
    }

    private func flushType() {
        typeWork?.cancel()
        guard !typeBuffer.isEmpty else { return }
        let t = typeBuffer; typeBuffer = ""
        handlers.type(t)
    }

    override func becomeFirstResponder() -> Bool { needsDisplay = true; return true }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard let w = window else { return }
        // Take keyboard focus when the screen appears, unless something else (search field, sidebar) already has it,
        // so typing reaches the device without a first click on the screen.
        DispatchQueue.main.async { [weak self] in
            guard let self, self.window === w, w.firstResponder == nil || w.firstResponder === w else { return }
            w.makeFirstResponder(self)
        }
        SelfTest.startIfRequested(screen: self)
    }

    // Drag & drop to install apps
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation { handlers.dropTargeted(true); return .copy }
    override func draggingExited(_ sender: NSDraggingInfo?) { handlers.dropTargeted(false) }
    override func concludeDragOperation(_ sender: NSDraggingInfo?) { handlers.dropTargeted(false) }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self]) as? [URL], let u = urls.first else { return false }
        handlers.dropFile(u)
        return true
    }
}

struct DeviceScreenView: NSViewRepresentable {
    var image: NSImage?
    var videoLayer: CALayer? = nil
    var devicePixelSize: CGSize
    var handlers: ScreenInputHandlers

    func makeNSView(context: Context) -> DeviceScreenNSView {
        let v = DeviceScreenNSView(frame: .zero)
        v.handlers = handlers
        v.devicePixelSize = devicePixelSize
        v.image = image
        v.videoLayer = videoLayer
        return v
    }

    func updateNSView(_ v: DeviceScreenNSView, context: Context) {
        v.handlers = handlers
        if v.devicePixelSize != devicePixelSize { v.devicePixelSize = devicePixelSize }
        if v.image !== image { v.image = image }
        if v.videoLayer !== videoLayer { v.videoLayer = videoLayer }
    }
}
