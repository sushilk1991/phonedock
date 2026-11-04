import SwiftUI
import AppKit

/// Sequential frame poller (~12 fps) for the visible device.
@MainActor
@Observable
final class FrameLoop {
    var image: NSImage?
    var deviceSize: CGSize?
    var error: String?
    var failure: ScreenFailure?
    var fps: Double = 0
    /// The screen has been solid black for a couple of seconds: the phone is most likely asleep or locked off.
    var asleep = false
    @ObservationIgnored private var lastDarkCheck = Date.distantPast
    @ObservationIgnored private var darkChecks = 0
    /// When a poll last succeeded: a new frame, or 304 "unchanged" (a quiet Android encoder sends no new frames
    /// while the screen is still). The stale-screen check reads it; not observed, so polls don't re-render views.
    @ObservationIgnored private(set) var lastSuccess = Date.distantPast
    private var task: Task<Void, Never>?
    private(set) var deviceId: String?

    func run(client: DaemonClient?, deviceId: String?, active: Bool) {
        if !active || client == nil || deviceId == nil {
            task?.cancel(); task = nil; self.deviceId = nil
            if !active { image = nil }
            return
        }
        if self.deviceId == deviceId, task != nil { return }
        task?.cancel()
        if self.deviceId != deviceId { image = nil; deviceSize = nil }
        self.deviceId = deviceId
        let c = client!, id = deviceId!
        task = Task { [weak self] in
            var failures = 0
            var stamps: [Date] = []
            let logPerf = ProcessInfo.processInfo.environment["PHONEDOCK_PERF_LOG"] == "1"
            var logStart = Date(), fetchTotal = 0.0, decodeTotal = 0.0, frameCount = 0, dropped = 0, bytes = 0, decoded = 0
            var etag: String?
            while !Task.isCancelled {
                let t0 = Date()
                do {
                    let f = try await c.frame(id, maxSize: 900, etag: etag)
                    guard let self, !Task.isCancelled else { return }
                    etag = f.etag
                    self.lastSuccess = Date()
                    if let image = f.image {
                        self.image = image
                    }
                    if let current = self.image { self.checkDark(current) }   // unchanged frames (304) still count
                    if let w = f.deviceWidth, let h = f.deviceHeight, w > 0, h > 0 { self.deviceSize = CGSize(width: w, height: h) }
                    self.error = nil
                    self.failure = nil
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
                    if let first = stamps.first, stamps.count > 1 { self.fps = Double(stamps.count - 1) / Date().timeIntervalSince(first) }
                } catch {
                    if Task.isCancelled { return }
                    failures += 1
                    if logPerf { dropped += 1 }
                    self?.error = error.localizedDescription
                    self?.failure = ScreenFailure(error)
                    try? await Task.sleep(for: .milliseconds(min(3000, 300 * failures)))
                }
                let elapsed = Date().timeIntervalSince(t0)
                if elapsed < 0.075 { try? await Task.sleep(for: .milliseconds(Int((0.075 - elapsed) * 1000))) }
            }
        }
    }

    func stop() { task?.cancel(); task = nil; deviceId = nil; asleep = false; darkChecks = 0 }

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

    /// Self-test only: freeze the loop and show a frame error as if the backend had failed.
    func injectFailure(_ e: APIError) { stop(); image = nil; error = e.localizedDescription; failure = ScreenFailure(e) }
}
