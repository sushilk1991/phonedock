import AVFoundation
import AppKit
import ScreenCaptureKit

/// Self-test only (`recordWindow` / `stopRecordWindow` ops): records PhoneDock's main window to a movie through
/// ScreenCaptureKit while the app stays behind the user's windows. A window capture gets what the window server shows
/// for the window, including the live device layer and materials, which the in-process drawing background screenshots
/// fall back to (`SelfTest.render`) can't draw. It uses this process's own shareable content, so it needs no Screen
/// Recording permission and never prompts.
/// Default output is ProRes 4444 with alpha (the window's rounded corners stay transparent); `codec: "h264"` for a
/// small opaque file. Frames arrive only when the window changes, so the file has a variable frame rate; the last
/// frame is repeated at stop so the movie runs until then.
final class WindowRecorder: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    nonisolated(unsafe) static var current: WindowRecorder?

    private let queue = DispatchQueue(label: "dev.phonedock.selftest.recordWindow")
    private var stream: SCStream?
    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private let adaptor: AVAssetWriterInputPixelBufferAdaptor
    private var startedSession = false
    private var last: CVPixelBuffer?
    private var lastTime = CMTime.invalid
    private var firstTime = CMTime.invalid
    private(set) var frames = 0
    private(set) var dropped = 0
    private(set) var firstFrameWall: Date?
    private(set) var error: String?
    let url: URL

    private init(url: URL, width: Int, height: Int, codec: String) throws {
        self.url = url
        try? FileManager.default.removeItem(at: url)
        writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        var settings: [String: Any] = [AVVideoWidthKey: width, AVVideoHeightKey: height]
        if codec == "h264" {
            settings[AVVideoCodecKey] = AVVideoCodecType.h264
            settings[AVVideoCompressionPropertiesKey] = [AVVideoAverageBitRateKey: 40_000_000,
                                                         AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel]
        } else {
            settings[AVVideoCodecKey] = AVVideoCodecType.proRes4444
        }
        input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = true
        adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height])
        guard writer.canAdd(input) else { throw NSError(domain: "recordWindow", code: 1, userInfo: [NSLocalizedDescriptionKey: "writer refused the video input"]) }
        writer.add(input)
        super.init()
    }

    /// Starts recording `w` (the window alone: sheets are separate windows and aren't in it).
    @MainActor
    static func start(window w: NSWindow, path: String, fps: Int, scale: CGFloat, codec: String) async throws -> String {
        if current != nil { _ = await stop() }
        // This process's own windows need no Screen Recording permission (currentProcess).
        var content = try await SCShareableContent.currentProcess
        if !content.windows.contains(where: { $0.windowID == CGWindowID(w.windowNumber) }) {
            content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        }
        guard let main = content.windows.first(where: { $0.windowID == CGWindowID(w.windowNumber) }) else {
            throw NSError(domain: "recordWindow", code: 2, userInfo: [NSLocalizedDescriptionKey: "window \(w.windowNumber) isn't shareable (is it on screen?)"])
        }
        let filter = SCContentFilter(desktopIndependentWindow: main)
        let cfg = SCStreamConfiguration()
        let width = Int((main.frame.width * scale).rounded()), height = Int((main.frame.height * scale).rounded())
        cfg.width = width
        cfg.height = height
        cfg.scalesToFit = true
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        cfg.colorSpaceName = CGColorSpace.sRGB
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, fps)))
        cfg.queueDepth = 8
        cfg.showsCursor = false
        cfg.backgroundColor = .clear
        cfg.ignoreShadowsSingleWindow = true
        cfg.shouldBeOpaque = false
        let r = try WindowRecorder(url: URL(fileURLWithPath: path), width: width, height: height, codec: codec)
        let s = SCStream(filter: filter, configuration: cfg, delegate: r)
        try s.addStreamOutput(r, type: .screen, sampleHandlerQueue: r.queue)
        r.stream = s
        guard r.writer.startWriting() else { throw r.writer.error ?? NSError(domain: "recordWindow", code: 4) }
        try await s.startCapture()
        current = r
        return "\(width)x\(height) window \(w.windowNumber)"
    }

    /// Stops the current recording; returns (path, frames, seconds).
    static func stop() async -> (String, Int, Double, String?)? {
        guard let r = current else { return nil }
        current = nil
        try? await r.stream?.stopCapture()
        return await withCheckedContinuation { cont in
            r.queue.async {
                // Hold the last frame until now, so the movie lasts as long as the recording did.
                if r.startedSession, let pb = r.last {
                    let now = CMClockGetTime(CMClockGetHostTimeClock())
                    if CMTimeCompare(now, r.lastTime) > 0, r.input.isReadyForMoreMediaData { r.adaptor.append(pb, withPresentationTime: now); r.lastTime = now }
                }
                let seconds = r.startedSession ? CMTimeGetSeconds(CMTimeSubtract(r.lastTime, r.firstTime)) : 0
                guard r.startedSession else {
                    r.writer.cancelWriting()
                    cont.resume(returning: (r.url.path, 0, 0, r.error ?? "no frames"))
                    return
                }
                r.input.markAsFinished()
                r.writer.endSession(atSourceTime: r.lastTime)
                r.writer.finishWriting {
                    cont.resume(returning: (r.url.path, r.frames, seconds, r.writer.error.map { "\($0)" } ?? r.error))
                }
            }
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sb.isValid, let pb = sb.imageBuffer else { return }
        // Only complete frames carry new pixels.
        if let info = (CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first,
           let raw = info[.status] as? Int, let status = SCFrameStatus(rawValue: raw), status != .complete { return }
        let t = sb.presentationTimeStamp
        if !startedSession {
            writer.startSession(atSourceTime: t)
            startedSession = true
            firstTime = t
            firstFrameWall = Date()
            let stamp = ISO8601DateFormatter()
            stamp.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let line = stamp.string(from: firstFrameWall!)
            DispatchQueue.main.async { SelfTest.log("recordWindow first frame at \(line)") }
        } else if CMTimeCompare(t, lastTime) <= 0 { return }
        if input.isReadyForMoreMediaData, adaptor.append(pb, withPresentationTime: t) { frames += 1 } else { dropped += 1 }
        last = pb
        lastTime = t
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        self.error = "\(error)"
        DispatchQueue.main.async { SelfTest.log("recordWindow stream stopped: \(error)") }
    }
}
