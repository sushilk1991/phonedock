import SwiftUI
import AppKit
import AVFoundation
import ImageIO

/// The visible device's screen. Live video where the device has it (`GET /video`: Android H.264, iPhone HEVC, decoded in
/// hardware into `videoLayer`, LiveVideo.swift); otherwise, or when video isn't available, a sequential JPEG poller
/// (~12 fps).
@MainActor
@Observable
final class FrameLoop {
    /// The last JPEG frame; in video mode, the screenshot shown until the video's first picture (then nil).
    var image: NSImage?
    var deviceSize: CGSize?
    var error: String?
    var failure: ScreenFailure?
    var fps: Double = 0
    /// The screen has been solid black for a couple of seconds: the phone is most likely asleep or locked off.
    var asleep = false
    /// Something is on screen: a JPEG frame, the video's first screenshot, or decoded video.
    var hasPicture = false
    /// Pixel size of what's on screen (frame or video): it turns before the device size does when the screen rotates.
    var pictureSize: CGSize?
    /// The hardware-decoded video, drawn over `image`. Made the first time video is tried.
    private(set) var videoLayer: CALayer?
    @ObservationIgnored private var lastDarkCheck = Date.distantPast
    @ObservationIgnored private var darkChecks = 0
    /// When a JPEG poll last succeeded: a new frame, or 304 "unchanged".
    @ObservationIgnored private var jpegSuccess = Date.distantPast
    /// When the video connection last said anything (frames, or its ping every second on a still screen).
    @ObservationIgnored private let videoAlive = SharedDate()
    /// The stale-screen check reads it; not observed, so frames don't re-render views.
    var lastSuccess: Date { max(jpegSuccess, videoAlive.value) }
    @ObservationIgnored private var renderer: VideoRenderer?
    /// The video layer has a picture (cleared to show JPEG frames again).
    @ObservationIgnored fileprivate var videoShown = false
    /// Bumped for each run; video callbacks for an older run are dropped.
    @ObservationIgnored fileprivate var generation = 0
    @ObservationIgnored fileprivate let logPerf = ProcessInfo.processInfo.environment["PHONEDOCK_PERF_LOG"] == "1"
    @ObservationIgnored fileprivate var runStart = Date()
    @ObservationIgnored fileprivate var firstLogged = false
    private var task: Task<Void, Never>?
    private(set) var deviceId: String?
    /// Devices whose daemon has no live video for them (an older daemon, a backend without it): JPEG until the app quits.
    private static var noVideo = Set<String>()
    /// `PHONEDOCK_VIDEO=0`: JPEG frames only. `=1`: try video even where the device doesn't list it (tests the fallback).
    private static let videoSetting = ProcessInfo.processInfo.environment["PHONEDOCK_VIDEO"]
    /// Longest side of the video asked for (pixels). The view is at most ~1000 pt tall, 2× on Retina.
    private static let videoMaxSize = 1280

    /// `video`: the device can stream live video (`can("video")`); otherwise JPEG frames.
    func run(client: DaemonClient?, deviceId: String?, active: Bool, video: Bool = false) {
        if !active || client == nil || deviceId == nil {
            cancelTask(); self.deviceId = nil
            if !active { clearPicture() }
            return
        }
        if self.deviceId == deviceId, task != nil { return }
        cancelTask()
        if self.deviceId != deviceId { clearPicture(); deviceSize = nil }
        self.deviceId = deviceId
        let c = client!, id = deviceId!
        let useVideo = (video || Self.videoSetting == "1") && Self.videoSetting != "0" && !Self.noVideo.contains(id)
        runStart = Date(); firstLogged = false
        task = Task { [weak self] in
            if useVideo { await self?.videoLoop(c, id) } else { await self?.jpegLoop(c, id, until: nil) }
        }
    }

    func stop() { cancelTask(); deviceId = nil; asleep = false; darkChecks = 0 }

    private func cancelTask() { task?.cancel(); task = nil; generation += 1 }

    private func clearPicture() {
        image = nil
        if hasPicture { hasPicture = false }
        pictureSize = nil
        if videoShown || renderer != nil { renderer?.flushSoon(removeImage: true); videoShown = false }
    }

    fileprivate func setPicture(_ size: CGSize?) {
        if !hasPicture { hasPicture = true }
        if let size, size != pictureSize { pictureSize = size }
        if error != nil { error = nil }
        if failure != nil { failure = nil }
    }

    fileprivate func perfFirst(_ what: String) {
        guard logPerf, !firstLogged else { return }
        firstLogged = true
        FileHandle.standardError.write(Data(String(format: "[perf] first_frame_ms=%.0f kind=%@\n", Date().timeIntervalSince(runStart) * 1000, what).utf8))
    }

    // MARK: JPEG frames

    /// Polls `/frame` until cancelled, or until `until` (then returns, to try video again).
    private func jpegLoop(_ c: DaemonClient, _ id: String, until: Date?) async {
        var failures = 0
        var stamps: [Date] = []
        let logPerf = self.logPerf
        var logStart = Date(), fetchTotal = 0.0, decodeTotal = 0.0, frameCount = 0, dropped = 0, bytes = 0, decoded = 0
        var etag: String?
        while !Task.isCancelled {
            if let until, Date() > until { return }
            let t0 = Date()
            do {
                let f = try await c.frame(id, maxSize: 900, etag: etag)
                guard !Task.isCancelled else { return }
                etag = f.etag
                jpegSuccess = Date()
                if let image = f.image {
                    if videoShown { renderer?.flushSoon(removeImage: true); videoShown = false }
                    self.image = image
                    setPicture(image.size)
                    if logPerf {
                        perfFirst("jpeg")
                        FileHandle.standardError.write(Data(String(format: "[frame] t=%.1f\n", Date().timeIntervalSince1970 * 1000).utf8))
                    }
                }
                if let current = self.image { checkDark(current) }   // unchanged frames (304) still count
                if let w = f.deviceWidth, let h = f.deviceHeight, w > 0, h > 0, deviceSize != CGSize(width: w, height: h) { deviceSize = CGSize(width: w, height: h) }
                error = nil
                failure = nil
                failures = 0
                if logPerf {
                    fetchTotal += f.fetchMs; decodeTotal += f.decodeMs; frameCount += 1; bytes += f.bytes; if f.image != nil { decoded += 1 }
                    let seconds = Date().timeIntervalSince(logStart)
                    if seconds >= 1 {
                        let line = String(format: "[perf] fetch_ms=%.2f decode_ms=%.2f fps=%.2f dropped=%d bytes_per_poll=%.0f decoded=%d\n", fetchTotal / Double(frameCount), decodeTotal / Double(max(1, decoded)), Double(frameCount) / seconds, dropped, Double(bytes) / Double(frameCount), decoded)
                        FileHandle.standardError.write(Data(line.utf8))
                        logStart = Date(); fetchTotal = 0; decodeTotal = 0; frameCount = 0; dropped = 0; bytes = 0; decoded = 0
                    }
                }
                stamps.append(Date()); stamps = stamps.suffix(12)
                if let first = stamps.first, stamps.count > 1 { fps = Double(stamps.count - 1) / Date().timeIntervalSince(first) }
            } catch {
                if Task.isCancelled { return }
                failures += 1
                if logPerf { dropped += 1 }
                self.error = error.localizedDescription
                self.failure = ScreenFailure(error)
                try? await Task.sleep(for: .milliseconds(min(3000, 300 * failures)))
            }
            let elapsed = Date().timeIntervalSince(t0)
            if elapsed < 0.075 { try? await Task.sleep(for: .milliseconds(Int((0.075 - elapsed) * 1000))) }
        }
    }

    /// Once a second, look at a 24 × 24 version of the frame. Pure black twice in a row (about 2 s) means asleep;
    /// any lit pixel clears it at once.
    private func checkDark(_ image: NSImage) {
        guard Date().timeIntervalSince(lastDarkCheck) >= 1 else { return }
        lastDarkCheck = Date()
        guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return }
        let n = 24
        var px = [UInt8](repeating: 0, count: n * n * 4)
        let dark: Bool = px.withUnsafeMutableBytes { buf in
            guard let ctx = CGContext(data: buf.baseAddress, width: n, height: n, bitsPerComponent: 8, bytesPerRow: n * 4,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            ctx.interpolationQuality = .low
            ctx.draw(cg, in: CGRect(x: 0, y: 0, width: n, height: n))
            let b = buf.bindMemory(to: UInt8.self)
            var lit = 0
            for i in stride(from: 0, to: n * n * 4, by: 4) where max(b[i], b[i + 1], b[i + 2]) > 14 { lit += 1 }
            return lit <= 2
        }
        if dark { darkChecks += 1 } else { darkChecks = 0 }
        let now = darkChecks >= 2
        if now != asleep { asleep = now }
    }

    // MARK: Live video

    private func ensureRenderer() -> VideoRenderer {
        if let renderer { return renderer }
        let r = VideoRenderer(maxSize: Self.videoMaxSize)
        renderer = r
        videoLayer = r.layer
        return r
    }

    /// Streams video, reconnecting when the connection drops. Falls back to JPEG frames when the daemon or device
    /// has no video, when the device's capture gives up, or after three connections in a row without a frame.
    private func videoLoop(_ c: DaemonClient, _ id: String) async {
        var failures = 0
        while !Task.isCancelled {
            let (end, gotFrames) = await connectVideo(c, id)
            if Task.isCancelled { return }
            switch end {
            case .unsupported:
                Self.noVideo.insert(id)
                note("no live video for \(id): JPEG frames")
                await jpegLoop(c, id, until: nil)
                return
            case .sourceFailed(let e):
                note("live video failed (\(e.code): \(e.message)): JPEG frames for a minute")
                await jpegLoop(c, id, until: Date().addingTimeInterval(60))
                failures = 0
            case .failed(let e):
                if gotFrames { failures = 0 } else { failures += 1 }
                if !gotFrames, (e as? URLError)?.code != .cancelled {
                    error = e.localizedDescription
                    failure = ScreenFailure(e)
                }
                if failures >= 3 {
                    note("live video: no frames after 3 tries (\(e.localizedDescription)): JPEG frames for 30 s")
                    await jpegLoop(c, id, until: Date().addingTimeInterval(30))
                    failures = 0
                } else {
                    try? await Task.sleep(for: .milliseconds(gotFrames ? 50 : min(3000, 300 * failures)))
                }
            }
        }
    }

    /// One `/video` connection, until it ends or the task is cancelled. Messages are handled off the main thread.
    private func connectVideo(_ c: DaemonClient, _ id: String) async -> (VideoConnection.End, Bool) {
        guard let req = try? c.videoRequest(id, maxSize: Self.videoMaxSize) else { return (.unsupported, false) }
        let r = ensureRenderer()
        let pipe = VideoPipe(loop: self, renderer: r, alive: videoAlive, generation: generation, perf: logPerf)
        let (ends, endCont) = AsyncStream.makeStream(of: (VideoConnection.End, Bool).self, bufferingPolicy: .bufferingNewest(1))
        let conn = VideoConnection(request: req, queue: r.queue, onMessage: { pipe.handle($0) },
                                   onEnd: { e in pipe.stop(); endCont.yield((e, pipe.gotFrames)); endCont.finish() })
        pipe.connection = conn
        conn.start()
        let result: (VideoConnection.End, Bool)? = await withTaskCancellationHandler {
            for await e in ends { return e }
            return nil
        } onCancel: { conn.cancel() }
        conn.cancel()
        return result ?? (.failed(CancellationError()), false)
    }

    private func note(_ s: String) { FileHandle.standardError.write(Data("[video] \(s)\n".utf8)) }

    fileprivate func videoAsleep(_ a: Bool) { if a != asleep { asleep = a } }

    /// Self-test only: freeze the loop and show a frame error as if the backend had failed.
    func injectFailure(_ e: APIError) { stop(); clearPicture(); error = e.localizedDescription; failure = ScreenFailure(e) }
}

/// Handles one video connection's messages on the renderer's queue; tells the FrameLoop (on the main thread) only
/// what it shows: the device size, the first picture, asleep or not. Frames themselves never touch the main thread.
private final class VideoPipe: @unchecked Sendable {
    private weak var loop: FrameLoop?
    private let renderer: VideoRenderer
    private let alive: SharedDate
    private let generation: Int
    private let perf: Bool
    weak var connection: VideoConnection?
    private(set) var gotFrames = false
    private var shown = false
    private var stopped = false
    private var stateAsleep = false
    private var darkAsleep = false
    private var darkChecks = 0
    private var timer: DispatchSourceTimer?
    private var counts = (shown: 0, replay: 0, skipped: 0, bytes: 0)
    private var countStart = Date()
    private var lastMetrics = (total: 0, dropped: 0)

    init(loop: FrameLoop, renderer: VideoRenderer, alive: SharedDate, generation: Int, perf: Bool) {
        self.loop = loop; self.renderer = renderer; self.alive = alive; self.generation = generation; self.perf = perf
        let t = DispatchSource.makeTimerSource(queue: renderer.queue)
        t.schedule(deadline: .now() + 1, repeating: 1, leeway: .milliseconds(100))
        t.setEventHandler { [weak self] in self?.everySecond() }
        t.resume()
        timer = t
    }

    /// On the main thread, if this connection's run is still the current one.
    private func main(_ f: @escaping @MainActor (FrameLoop) -> Void) {
        let gen = generation
        DispatchQueue.main.async { [weak loop] in
            MainActor.assumeIsolated { if let loop, loop.generation == gen { f(loop) } }
        }
    }

    func stop() {
        stopped = true
        timer?.cancel(); timer = nil
    }

    func handle(_ m: VideoWire.Message) {
        guard !stopped else { return }
        alive.set(Date())
        switch m.type {
        case VideoWire.frame:
            let key = m.flags & VideoWire.keyFlag != 0, replay = m.flags & VideoWire.replayFlag != 0
            switch renderer.enqueue(m.payload, key: key, replay: replay) {
            case .shown:
                gotFrames = true
                counts.shown += 1; counts.bytes += m.payload.count
                if !shown { shown = true; firstPicture() }
                // Handed to the display layer (as "[frame]" is for a JPEG frame set on the layer); the renderer's own
                // count of frames shown and dropped is in the "[vperf]" line each second.
                if perf { FileHandle.standardError.write(Data(String(format: "[frame] t=%.1f\n", Date().timeIntervalSince1970 * 1000).utf8)) }
            case .decodedOnly:
                gotFrames = true
                counts.replay += 1; counts.bytes += m.payload.count
            case .skipped:
                counts.skipped += 1
            case .failed:
                // The decoder gave up (corrupt data, or the system reclaimed it): reconnect, which starts from a key frame.
                note("decoder failed (\(renderer.decodeError)): reconnecting")
                renderer.flush(removeImage: false)
                connection?.cancel()
            }
        case VideoWire.config:
            renderer.setConfig(codec: VideoCodec(rawValue: m.flags) ?? .h264, annexB: m.payload)
        case VideoWire.screen:
            guard let o = try? JSONSerialization.jsonObject(with: m.payload) as? [String: Any] else { return }
            let num = { (k: String) -> Double? in (o[k] as? NSNumber)?.doubleValue }
            let device = num("width").flatMap { w in num("height").map { CGSize(width: w, height: $0) } }
            let video = num("videoWidth").flatMap { w in num("videoHeight").map { CGSize(width: w, height: $0) } }
            let coded = num("codedWidth").flatMap { w in num("codedHeight").map { CGSize(width: w, height: $0) } }
            renderer.setPictureSize(visible: video, coded: coded)
            let shown = self.shown
            main { loop in
                if let device, device.width > 0, device.height > 0, loop.deviceSize != device { loop.deviceSize = device }
                if shown, let video, video.width > 0, loop.pictureSize != video { loop.pictureSize = video }
            }
        case VideoWire.state:
            guard let o = try? JSONSerialization.jsonObject(with: m.payload) as? [String: Any], let s = o["state"] as? String else { return }
            stateAsleep = s == "asleep"
            if stateAsleep { renderer.flush(removeImage: true); shown = false }   // the display is off: show it black
            let a = stateAsleep || darkAsleep
            main { loop in loop.videoAsleep(a); if a { loop.setPicture(nil) } }
        case VideoWire.reset:
            renderer.flush(removeImage: false)
        case VideoWire.still:
            guard !shown, let src = CGImageSourceCreateWithData(m.payload as CFData, nil),
                  let cg = CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary) else { return }
            let size = CGSize(width: cg.width, height: cg.height)
            let perf = self.perf
            main { loop in
                guard !loop.videoShown else { return }
                loop.image = NSImage(cgImage: cg, size: size)
                loop.setPicture(size)
                if perf {
                    loop.perfFirst("still")
                    FileHandle.standardError.write(Data(String(format: "[frame] t=%.1f still\n", Date().timeIntervalSince1970 * 1000).utf8))
                }
            }
        default:
            break   // ping (and kinds from a newer daemon)
        }
    }

    private func firstPicture() {
        let size = renderer.videoSize
        main { loop in
            loop.videoShown = true
            loop.setPicture(size)
            loop.perfFirst("video")
            // Drop the screenshot or JPEG frame under the video once the video has surely drawn.
            let gen = loop.generation
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak loop] in
                MainActor.assumeIsolated { if let loop, loop.generation == gen, loop.videoShown, loop.image != nil { loop.image = nil } }
            }
        }
    }

    /// The asleep check (pure black for 2 s, as for JPEG frames), and the perf line.
    private func everySecond() {
        guard !stopped else { return }
        if !stateAsleep, shown, let dark = renderer.displayedIsDark() {
            if dark { darkChecks += 1 } else { darkChecks = 0 }
            let d = darkChecks >= 2
            if d != darkAsleep { darkAsleep = d; main { loop in loop.videoAsleep(d) } }
        }
        let fps = Double(counts.shown) / max(0.001, Date().timeIntervalSince(countStart))
        main { loop in if abs(loop.fps - fps) >= 0.5 { loop.fps = fps } }
        if perf {
            let s = Date().timeIntervalSince(countStart)
            let c = counts
            let r = renderer.display.sampleBufferRenderer
            // The renderer's own count: frames it had to show, and how many of them it dropped (late or undecodable).
            r.loadVideoPerformanceMetrics { [weak self] m in
                guard let self else { return }
                self.renderer.queue.async {
                    let total = m?.totalNumberOfFrames ?? 0, dropped = m?.numberOfDroppedFrames ?? 0
                    let dt = total - self.lastMetrics.total, dd = dropped - self.lastMetrics.dropped
                    self.lastMetrics = (total, dropped)
                    FileHandle.standardError.write(Data(String(format: "[vperf] t=%.1f in=%d shown=%d dropped=%d replay=%d skipped=%d kbps=%.0f status=%d shrunk=%d\n",
                        Date().timeIntervalSince1970 * 1000, c.shown, max(0, dt - dd), dd, c.replay, c.skipped,
                        Double(c.bytes) * 8 / 1000 / s, r.status.rawValue, self.renderer.shrunk).utf8))
                }
            }
        }
        counts = (0, 0, 0, 0); countStart = Date()
    }

    private func note(_ s: String) { FileHandle.standardError.write(Data("[video] \(s)\n".utf8)) }
}
