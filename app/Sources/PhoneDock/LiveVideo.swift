import Foundation
import AppKit
import AVFoundation
import CoreMedia
import ImageIO
import VideoToolbox

// Live video for the device screen: `GET /v1/devices/:id/video` (docs/API.md "Live video") streams the device's
// H.264 or HEVC as it comes from its encoder, framed; the frames are decoded in hardware (VideoRenderer).
// FrameLoop drives it (and falls back to polling JPEG frames when a daemon or device has no video).
//
// The codec is a parameter of everything below (VideoCodec): H.264 (Android), HEVC (an iPhone's own screen stream).

/// The wire format: messages with a 16-byte header (type, flags, version, reserved, u32 length, u64 µs timestamp).
enum VideoWire {
    static let headerBytes = 16
    static let contentType = "application/vnd.phonedock.video"
    static let screen: UInt8 = 1, config: UInt8 = 2, frame: UInt8 = 3, state: UInt8 = 4, reset: UInt8 = 5, ping: UInt8 = 6, still: UInt8 = 7
    static let keyFlag: UInt8 = 1, replayFlag: UInt8 = 2

    struct Message {
        var type: UInt8
        var flags: UInt8
        var timestampUs: UInt64
        var payload: Data
    }

    /// Splits the byte stream into messages, whatever the chunk sizes.
    struct Reader {
        private var buf = Data()

        mutating func push(_ chunk: Data) -> [Message] {
            buf.append(chunk)
            var out: [Message] = []
            var pos = 0
            let count = buf.count
            buf.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
                while count - pos >= VideoWire.headerBytes {
                    let len = Int(UInt32(bigEndian: raw.loadUnaligned(fromByteOffset: pos + 4, as: UInt32.self)))
                    guard count - pos >= VideoWire.headerBytes + len else { break }
                    let ts = UInt64(bigEndian: raw.loadUnaligned(fromByteOffset: pos + 8, as: UInt64.self))
                    let start = pos + VideoWire.headerBytes
                    let payload = len > 0 ? Data(bytes: raw.baseAddress! + start, count: len) : Data()
                    out.append(Message(type: raw[pos], flags: raw[pos + 1], timestampUs: ts, payload: payload))
                    pos = start + len
                }
            }
            if pos > 0 { buf.removeSubrange(0..<pos) }
            return out
        }
    }
}

/// What differs between H.264 and HEVC for a decoder fed with Annex B: which NAL units are parameter sets, and how
/// they become a format description.
enum VideoCodec: UInt8 {
    case h264 = 0
    case hevc = 1

    func isParameterSet(_ nal: UnsafeRawBufferPointer) -> Bool {
        guard let h = nal.first else { return false }
        switch self {
        case .h264: let t = h & 0x1f; return t == 7 || t == 8
        case .hevc: let t = (h >> 1) & 0x3f; return t >= 32 && t <= 34
        }
    }

    /// The parameter sets (Annex B) as a format description for 4-byte length-prefixed samples.
    func formatDescription(annexB: Data) -> CMVideoFormatDescription? {
        let sets: [[UInt8]] = annexB.withUnsafeBytes { raw in
            AnnexB.nalRanges(raw).compactMap { r in
                let nal = UnsafeRawBufferPointer(rebasing: raw[r])
                return isParameterSet(nal) ? [UInt8](nal) : nil
            }
        }
        guard !sets.isEmpty else { return nil }
        // H.264 wants SPS before PPS; HEVC VPS, SPS, PPS: the daemon sends them in that order already.
        let ptrs = sets.map { s -> UnsafeMutablePointer<UInt8> in
            let p = UnsafeMutablePointer<UInt8>.allocate(capacity: s.count)
            p.initialize(from: s, count: s.count)
            return p
        }
        defer { for p in ptrs { p.deallocate() } }
        let cptrs: [UnsafePointer<UInt8>] = ptrs.map { UnsafePointer($0) }
        let sizes = sets.map { $0.count }
        var fd: CMFormatDescription?
        let status: OSStatus = cptrs.withUnsafeBufferPointer { pp in
            sizes.withUnsafeBufferPointer { ss in
                switch self {
                case .h264:
                    return CMVideoFormatDescriptionCreateFromH264ParameterSets(allocator: kCFAllocatorDefault, parameterSetCount: sets.count,
                        parameterSetPointers: pp.baseAddress!, parameterSetSizes: ss.baseAddress!, nalUnitHeaderLength: 4, formatDescriptionOut: &fd)
                case .hevc:
                    return CMVideoFormatDescriptionCreateFromHEVCParameterSets(allocator: kCFAllocatorDefault, parameterSetCount: sets.count,
                        parameterSetPointers: pp.baseAddress!, parameterSetSizes: ss.baseAddress!, nalUnitHeaderLength: 4, extensions: nil, formatDescriptionOut: &fd)
                }
            }
        }
        return status == noErr ? fd : nil
    }
}

enum AnnexB {
    /// Byte ranges of the NAL units (start codes and trailing zero bytes left out).
    static func nalRanges(_ b: UnsafeRawBufferPointer) -> [Range<Int>] {
        var out: [Range<Int>] = []
        let n = b.count
        var i = 0
        var start = -1
        while i + 2 < n {
            if b[i] == 0 && b[i + 1] == 0 && b[i + 2] == 1 {
                if start >= 0 {
                    var end = i
                    while end > start && b[end - 1] == 0 { end -= 1 }
                    if end > start { out.append(start..<end) }
                }
                i += 3
                start = i
            } else {
                i += 1
            }
        }
        if start >= 0 && start < n {
            var end = n
            while end > start && b[end - 1] == 0 { end -= 1 }
            if end > start { out.append(start..<end) }
        }
        return out
    }

    /// One access unit, Annex B → a block buffer of 4-byte big-endian length-prefixed NAL units (what CoreMedia's
    /// H.264 / HEVC samples hold). Parameter sets are left out (they're in the format description).
    static func sampleData(_ au: Data, codec: VideoCodec) -> CMBlockBuffer? {
        au.withUnsafeBytes { raw -> CMBlockBuffer? in
            let ranges = nalRanges(raw).filter { !codec.isParameterSet(UnsafeRawBufferPointer(rebasing: raw[$0])) }
            let total = ranges.reduce(0) { $0 + 4 + $1.count }
            guard total > 0 else { return nil }
            var bb: CMBlockBuffer?
            guard CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: total, blockAllocator: kCFAllocatorDefault,
                                                     customBlockSource: nil, offsetToData: 0, dataLength: total, flags: kCMBlockBufferAssureMemoryNowFlag,
                                                     blockBufferOut: &bb) == kCMBlockBufferNoErr, let bb else { return nil }
            var dst: UnsafeMutablePointer<CChar>?
            guard CMBlockBufferGetDataPointer(bb, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: nil, dataPointerOut: &dst) == kCMBlockBufferNoErr,
                  let dst else { return nil }
            let out = UnsafeMutableRawPointer(dst)
            var o = 0
            for r in ranges {
                let len = UInt32(r.count).bigEndian
                withUnsafeBytes(of: len) { out.advanced(by: o).copyMemory(from: $0.baseAddress!, byteCount: 4) }
                out.advanced(by: o + 4).copyMemory(from: raw.baseAddress! + r.lowerBound, byteCount: r.count)
                o += 4 + r.count
            }
            return bb
        }
    }
}

/// The layer the view hosts: both pictures fill it (only one has anything at a time).
final class VideoHostLayer: CALayer {
    override func layoutSublayers() {
        super.layoutSublayers()
        for l in sublayers ?? [] where l.frame != bounds { l.frame = bounds }
    }
}

/// Decodes and shows one stream. H.264: an AVSampleBufferDisplayLayer (hardware decoding, shown as soon as decoded).
/// HEVC (an iPhone's own stream): a VideoToolbox session whose pictures become `picture`'s contents, because the
/// phone's picture needs cropping a display layer can't do: it is padded (1328x2896 for a 1320x2868 screen), and under
/// heavy motion the phone draws a shrunk screen into its top-left corner, grey around it (stretched back here, as
/// tools/pd-ios-video.swift does for JPEG frames).
/// Everything except creating it (and `flushSoon`) runs on `queue`.
final class VideoRenderer: @unchecked Sendable {
    let layer = VideoHostLayer()
    let display = AVSampleBufferDisplayLayer()
    private let picture = CALayer()
    let queue = DispatchQueue(label: "dev.phonedock.video", qos: .userInteractive)
    private var codec = VideoCodec.h264
    private var config = Data()
    private var format: CMVideoFormatDescription?
    /// After a flush or before the first frame: frames that need earlier ones are skipped until a key frame.
    private var needKey = true
    private var pts: Int64 = 0
    /// Longest side to decode HEVC at (VideoToolbox scales while decoding).
    private let maxSize: Int

    enum Result { case shown, decodedOnly, skipped, failed }

    private let renderer: AVSampleBufferVideoRenderer

    /// On the main thread (it makes layers).
    init(maxSize: Int = 1280) {
        self.maxSize = maxSize
        let off: [String: CAAction] = ["bounds": NSNull(), "position": NSNull(), "frame": NSNull(), "contents": NSNull(), "contentsRect": NSNull(), "hidden": NSNull()]
        layer.actions = off
        layer.backgroundColor = NSColor.clear.cgColor
        display.videoGravity = .resizeAspect
        display.backgroundColor = NSColor.clear.cgColor
        // The view lays it out; no implicit animations when it does.
        display.actions = off
        picture.actions = off
        picture.contentsGravity = .resizeAspect
        layer.addSublayer(display)
        layer.addSublayer(picture)
        renderer = display.sampleBufferRenderer
        // A clock that stands still. Frames are shown as soon as they're decoded (DisplayImmediately) whatever the
        // clock says; without a stopped one the layer keeps the window server recompositing the window at the
        // display's rate even while nothing changes (measured: ~17% WindowServer CPU on a still screen, vs ~3%).
        var tb: CMTimebase?
        CMTimebaseCreateWithSourceClock(allocator: kCFAllocatorDefault, sourceClock: CMClockGetHostTimeClock(), timebaseOut: &tb)
        if let tb { CMTimebaseSetTime(tb, time: .zero); CMTimebaseSetRate(tb, rate: 0); display.controlTimebase = tb }
    }

    /// New parameter sets. Same bytes: nothing changes (a hand-over to a new encoder with the same settings).
    func setConfig(codec: VideoCodec, annexB: Data) {
        if codec == self.codec, annexB == config, format != nil { return }
        guard let fd = codec.formatDescription(annexB: annexB) else { return }
        if codec != self.codec {
            // the other picture goes away
            if codec == .hevc { renderer.flush(removingDisplayedImage: true, completionHandler: nil) } else { clearPicture() }
        }
        self.codec = codec; config = annexB; format = fd
        needKey = true
        if codec == .hevc { makeSession(fd) }
    }

    /// The visible part of the picture (`video` in the screen message) and the decoded size when it is padded (`coded`).
    func setPictureSize(visible: CGSize?, coded: CGSize?) { self.visible = visible; self.coded = coded }
    private var visible: CGSize?
    private var coded: CGSize?

    func enqueue(_ au: Data, key: Bool, replay: Bool) -> Result {
        guard let format else { return .skipped }
        if needKey && !key { return .skipped }
        if codec == .h264, renderer.status == .failed || renderer.requiresFlushToResumeDecoding { return .failed }
        guard let data = AnnexB.sampleData(au, codec: codec) else { return .skipped }
        var size = CMBlockBufferGetDataLength(data)
        pts += 1
        var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: CMTime(value: pts, timescale: 60), decodeTimeStamp: .invalid)
        var sb: CMSampleBuffer?
        guard CMSampleBufferCreateReady(allocator: kCFAllocatorDefault, dataBuffer: data, formatDescription: format, sampleCount: 1,
                                        sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 1, sampleSizeArray: &size,
                                        sampleBufferOut: &sb) == noErr, let sb else { return .skipped }
        if codec == .hevc { return decode(sb, key: key, replay: replay) }
        if let atts = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: true), CFArrayGetCount(atts) > 0 {
            let d = unsafeBitCast(CFArrayGetValueAtIndex(atts, 0), to: CFMutableDictionary.self)
            CFDictionarySetValue(d, Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(), Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
            if replay { CFDictionarySetValue(d, Unmanaged.passUnretained(kCMSampleAttachmentKey_DoNotDisplay).toOpaque(), Unmanaged.passUnretained(kCFBooleanTrue).toOpaque()) }
            if !key { CFDictionarySetValue(d, Unmanaged.passUnretained(kCMSampleAttachmentKey_NotSync).toOpaque(), Unmanaged.passUnretained(kCFBooleanTrue).toOpaque()) }
        }
        renderer.enqueue(sb)
        needKey = false
        return replay ? .decodedOnly : .shown
    }

    /// Why decoding stopped, for the log.
    var decodeError: String {
        if codec == .hevc { return lastDecodeStatus == noErr ? "?" : "VideoToolbox \(lastDecodeStatus)" }
        return renderer.error?.localizedDescription ?? "?"
    }

    /// `flush` from another thread (the main one): after whatever is already queued.
    func flushSoon(removeImage: Bool) { queue.async { self.flush(removeImage: removeImage) } }

    /// Throw away queued frames and the decoder's state (a key frame must come next). `removeImage`: also clear what's
    /// on screen (another device). On `queue`.
    func flush(removeImage: Bool) {
        renderer.flush(removingDisplayedImage: removeImage, completionHandler: nil)
        needKey = true
        if removeImage {
            format = nil; config = Data(); visible = nil; coded = nil
            if let session { VTDecompressionSessionInvalidate(session); self.session = nil }
            clearPicture()
        }
    }

    /// Pixel size of the stream: the visible picture (from the screen message), else from its parameter sets.
    var videoSize: CGSize? {
        if codec == .hevc, let visible, visible.width > 0, visible.height > 0 { return visible }
        guard let format else { return nil }
        let d = CMVideoFormatDescriptionGetDimensions(format)
        return d.width > 0 && d.height > 0 ? CGSize(width: Int(d.width), height: Int(d.height)) : nil
    }

    /// The picture on screen right now (decoded), to look at; nil before the first one.
    func displayedPixelBuffer() -> CVPixelBuffer? { codec == .hevc ? shownBuffers.last?.0 : renderer.displayedPixelBuffer() }

    /// The picture on screen is pure black (asleep, locked off): at most 2 lit points in a 24 × 24 copy of it, as for
    /// JPEG frames. nil: nothing on screen, or it couldn't be read. On `queue`, about once a second.
    func displayedIsDark() -> Bool? {
        if codec == .hevc {
            guard let (pb, w, h) = shownBuffers.last else { return nil }
            return BGRA.isDark(pb, width: w, height: h)
        }
        guard let pb = renderer.displayedPixelBuffer() else { return nil }
        // Decoded pictures can be in a GPU-compressed layout: VideoToolbox scales and converts to plain BGRA.
        if transfer == nil {
            var t: VTPixelTransferSession?
            VTPixelTransferSessionCreate(allocator: kCFAllocatorDefault, pixelTransferSessionOut: &t)
            transfer = t
        }
        let n = 24
        if thumb == nil {
            var b: CVPixelBuffer?
            CVPixelBufferCreate(kCFAllocatorDefault, n, n, kCVPixelFormatType_32BGRA, [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &b)
            thumb = b
        }
        guard let transfer, let thumb, VTPixelTransferSessionTransferImage(transfer, from: pb, to: thumb) == noErr else { return nil }
        return BGRA.isDark(thumb, width: n, height: n)
    }
    private var transfer: VTPixelTransferSession?
    private var thumb: CVPixelBuffer?

    // MARK: HEVC

    private var session: VTDecompressionSession?
    private var outSize = (w: 0, h: 0)
    private var lastDecodeStatus: OSStatus = noErr
    /// The pictures handed to the layer, newest last, with their visible size: kept so the decoder's pool doesn't
    /// reuse a surface the window server may still be showing.
    private var shownBuffers: [(CVPixelBuffer, Int, Int)] = []

    private func makeSession(_ fd: CMVideoFormatDescription) {
        if let session { VTDecompressionSessionInvalidate(session); self.session = nil }
        let d = CMVideoFormatDescriptionGetDimensions(fd)
        let cw = Int(d.width), ch = Int(d.height)
        guard cw > 0, ch > 0 else { return }
        // Decode straight to the size shown (≤ maxSize on the visible picture's longer side), in BGRA so the layer
        // shows it as is.
        let vis = max(visible.map { Int(max($0.width, $0.height)) } ?? max(cw, ch), 1)
        let k = min(1.0, Double(maxSize) / Double(vis))
        let ow = max(2, Int((Double(cw) * k / 2).rounded()) * 2), oh = max(2, Int((Double(ch) * k / 2).rounded()) * 2)
        let attrs: [CFString: Any] = [
            kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey: ow, kCVPixelBufferHeightKey: oh,
            kCVPixelBufferIOSurfacePropertiesKey: [:] as [CFString: Any],
        ]
        var s: VTDecompressionSession?
        let st = VTDecompressionSessionCreate(allocator: kCFAllocatorDefault, formatDescription: fd, decoderSpecification: nil,
                                              imageBufferAttributes: attrs as CFDictionary, outputCallback: nil, decompressionSessionOut: &s)
        guard st == noErr, let s else { lastDecodeStatus = st; return }
        VTSessionSetProperty(s, key: kVTDecompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        session = s
        outSize = (ow, oh)
    }

    private func decode(_ sb: CMSampleBuffer, key: Bool, replay: Bool) -> Result {
        if session == nil, let format { makeSession(format) }
        guard let session else { return .failed }
        var out: CVImageBuffer?
        var outStatus: OSStatus = noErr
        let st = VTDecompressionSessionDecodeFrame(session, sampleBuffer: sb, flags: replay ? [._DoNotOutputFrame] : [], infoFlagsOut: nil) { status, _, image, _, _ in
            outStatus = status; out = image
        }
        VTDecompressionSessionWaitForAsynchronousFrames(session)
        if st != noErr || outStatus != noErr {
            lastDecodeStatus = st != noErr ? st : outStatus
            // the session is gone (the system reclaimed it) or the data is bad: start again from a key frame
            VTDecompressionSessionInvalidate(session); self.session = nil
            needKey = true
            return .failed
        }
        needKey = false
        if replay { return .decodedOnly }
        guard let pb = out else { return .decodedOnly }
        return present(pb) ? .shown : .decodedOnly
    }

    /// Hands the picture to the layer, cropped to what the phone drew. false: the same picture as on screen already.
    private func present(_ pb: CVPixelBuffer) -> Bool {
        let bw = CVPixelBufferGetWidth(pb), bh = CVPixelBufferGetHeight(pb)
        // the visible part, in this buffer's pixels
        let fw = coded.map { $0.width > 0 ? (visible?.width ?? $0.width) / $0.width : 1 } ?? 1
        let fh = coded.map { $0.height > 0 ? (visible?.height ?? $0.height) / $0.height : 1 } ?? 1
        let vw = min(bw, max(2, Int((Double(bw) * fw).rounded()))), vh = min(bh, max(2, Int((Double(bh) * fh).rounded())))
        if let last = shownBuffers.last, last.1 == vw, last.2 == vh, BGRA.same(last.0, pb, width: vw, height: vh) { return false }
        let (cw, ch) = BGRA.contentRect(pb, width: vw, height: vh)
        if cw != vw || ch != vh { shrunk += 1 }
        shownBuffers.append((pb, vw, vh))
        if shownBuffers.count > 3 { shownBuffers.removeFirst() }
        // contentsRect is in unit coordinates of the image, its origin at the top-left for an IOSurface
        let rect = CGRect(x: 0, y: 0, width: Double(cw) / Double(bw), height: Double(ch) / Double(bh))
        guard let surface = CVPixelBufferGetIOSurface(pb)?.takeUnretainedValue() else { return false }
        pendingLock.lock()
        pending = (surface, rect)
        let schedule = !scheduled
        scheduled = true
        pendingLock.unlock()
        if schedule { DispatchQueue.main.async { [weak self] in self?.showPending() } }
        return true
    }
    /// Pictures the phone had shrunk into its top-left corner (stretched back), for the perf log.
    private(set) var shrunk = 0
    private let pendingLock = NSLock()
    private var pending: (IOSurface, CGRect)?
    private var scheduled = false

    /// On the main thread: the newest picture (any older one waiting is skipped).
    private func showPending() {
        pendingLock.lock()
        let p = pending; pending = nil; scheduled = false
        pendingLock.unlock()
        guard let (surface, rect) = p else { return }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        picture.contents = surface
        if picture.contentsRect != rect { picture.contentsRect = rect }
        CATransaction.commit()
    }

    private func clearPicture() {
        shownBuffers.removeAll()
        pendingLock.lock(); pending = nil; pendingLock.unlock()
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            pendingLock.lock(); let busy = pending != nil; pendingLock.unlock()
            if busy { return }   // a newer picture is on its way
            CATransaction.begin(); CATransaction.setDisableActions(true)
            picture.contents = nil
            CATransaction.commit()
        }
    }
}

/// Reading decoded BGRA pictures (VideoRenderer's HEVC path).
enum BGRA {
    /// Calls `f` with the bytes and row length of a locked pixel buffer.
    static func read<T>(_ pb: CVPixelBuffer, _ f: (UnsafePointer<UInt8>, Int) -> T) -> T? {
        guard CVPixelBufferLockBaseAddress(pb, .readOnly) == kCVReturnSuccess else { return nil }
        defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(pb) else { return nil }
        return f(base.assumingMemoryBound(to: UInt8.self), CVPixelBufferGetBytesPerRow(pb))
    }

    /// The top-left width x height of both pictures holds the same pixels.
    static func same(_ a: CVPixelBuffer, _ b: CVPixelBuffer, width: Int, height: Int) -> Bool {
        guard CVPixelBufferGetWidth(a) >= width, CVPixelBufferGetWidth(b) >= width,
              CVPixelBufferGetHeight(a) >= height, CVPixelBufferGetHeight(b) >= height else { return false }
        return read(a) { pa, ra in
            read(b) { pb, rb in
                for y in 0..<height where memcmp(pa + y * ra, pb + y * rb, width * 4) != 0 { return false }
                return true
            } ?? false
        } ?? false
    }

    /// At most 2 lit points (any channel above 14) on a 24 x 24 grid over the top-left width x height.
    static func isDark(_ pb: CVPixelBuffer, width: Int, height: Int) -> Bool? {
        read(pb) { p, row in
            let n = 24
            var lit = 0
            for j in 0..<n {
                let y = min(height - 1, (j * height + height / 2) / n)
                for i in 0..<n {
                    let x = min(width - 1, (i * width + width / 2) / n)
                    let o = y * row + x * 4
                    if max(p[o], p[o + 1], p[o + 2]) > 14 { lit += 1; if lit > 2 { return false } }
                }
            }
            return true
        }
    }

    /// Under heavy motion the phone's encoder can draw a shrunk screen into the TOP-LEFT of the picture and fill the rest
    /// with flat grey (Y = Cb = Cr = 128, so R = G = B = 128). Returns that content rectangle within the width x height
    /// region (the region itself when there is none): the last column/row less than 60 % grey, used only when both
    /// sides are clearly smaller. Same rule as tools/pd-ios-video.swift `contentRect`.
    static func contentRect(_ pb: CVPixelBuffer, width w: Int, height h: Int) -> (Int, Int) {
        read(pb) { p, row -> (Int, Int) in
            @inline(__always) func grey(_ x: Int, _ y: Int) -> Bool {
                let o = y * row + x * 4
                return abs(Int(p[o]) - 128) < 8 && abs(Int(p[o + 1]) - 128) < 8 && abs(Int(p[o + 2]) - 128) < 8
            }
            // Quick look first: a shrunk picture leaves the bottom-right corner grey.
            var corner = true
            for j in 0..<4 where corner {
                for i in 0..<4 where corner {
                    if !grey(min(w - 1, w * (93 + 2 * i) / 100), min(h - 1, h * (93 + 2 * j) / 100)) { corner = false }
                }
            }
            if !corner { return (w, h) }
            let sx = max(1, w / 160), sy = max(1, h / 320)
            var right = 0, bottom = 0
            var x = 0
            while x < w { var g = 0, n = 0, y = 0; while y < h { n += 1; if grey(x, y) { g += 1 }; y += sy * 4 }; if g * 10 < n * 6 { right = x }; x += sx }
            var y = 0
            while y < h { var g = 0, n = 0, x2 = 0; while x2 < w { n += 1; if grey(x2, y) { g += 1 }; x2 += sx * 4 }; if g * 10 < n * 6 { bottom = y }; y += sy }
            let cw = min(w, right + sx), ch = min(h, bottom + sy)
            if cw > w / 5 && cw * 100 < w * 92 && ch > h / 5 && ch * 100 < h * 92 { return (cw, ch) }
            return (w, h)
        } ?? (w, h)
    }
}

/// One `GET /video` connection. Messages arrive on `queue`, in order; `onEnd` once, when it ends for any reason.
final class VideoConnection: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    enum End {
        /// No video here (an older daemon, a backend without it): don't try again for this device.
        case unsupported
        /// The daemon's video source gave up (the device can't stream): use the JPEG frames.
        case sourceFailed(APIError)
        /// HTTP error or the connection dropped.
        case failed(Error)
    }

    private var session: URLSession?
    private var reader = VideoWire.Reader()
    private let request: URLRequest
    private let queue: DispatchQueue
    private let onMessage: (VideoWire.Message) -> Void
    private let onEnd: (End) -> Void
    private var status = 0
    private var isVideo = false
    private var body = Data()
    private var ended = false
    private var streamError: APIError?

    init(request: URLRequest, queue: DispatchQueue, onMessage: @escaping (VideoWire.Message) -> Void, onEnd: @escaping (End) -> Void) {
        self.request = request
        self.onMessage = onMessage
        self.onEnd = onEnd
        self.queue = queue
        super.init()
        let oq = OperationQueue()
        oq.maxConcurrentOperationCount = 1
        oq.underlyingQueue = queue
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 8          // the daemon pings every second
        cfg.timeoutIntervalForResource = 7 * 24 * 3600
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: cfg, delegate: self, delegateQueue: oq)
    }

    func start() { session?.dataTask(with: request).resume() }

    /// Ends it (onEnd still comes, once). Any thread.
    func cancel() {
        queue.async { [self] in
            session?.invalidateAndCancel(); session = nil
            finish(.failed(URLError(.cancelled)))
        }
    }

    private func finish(_ e: End) {
        guard !ended else { return }
        ended = true
        onEnd(e)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let http = response as? HTTPURLResponse
        status = http?.statusCode ?? 0
        isVideo = status == 200 && (http?.value(forHTTPHeaderField: "Content-Type") ?? "").hasPrefix(VideoWire.contentType)
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard !ended else { return }
        guard isVideo else { if body.count < 64 * 1024 { body.append(data) }; return }
        for m in reader.push(data) {
            if m.type == VideoWire.state, let o = try? JSONSerialization.jsonObject(with: m.payload) as? [String: Any], o["state"] as? String == "error" {
                streamError = APIError(status: 502, code: o["code"] as? String ?? "stream_failed", message: o["message"] as? String ?? "The live video stopped")
                continue
            }
            onMessage(m)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        session.finishTasksAndInvalidate()
        if let e = streamError { finish(.sourceFailed(e)); return }
        if !isVideo && status != 0 {
            let e = try? JSONDecoder().decode(APIErrorBody.self, from: body)
            // An older daemon (no such route), or a backend without video. (A 404 for the device itself is a failure.)
            if status == 404 && (e?.error.detail ?? "").contains("No route") || status == 501 || status == 200 { finish(.unsupported); return }
            if let e {
                finish(.failed(APIError(status: status, code: e.error.code ?? "error", message: e.error.message ?? "HTTP \(status)", hints: e.error.hints ?? [], detail: e.error.detail)))
            } else {
                finish(.failed(APIError(status: status, code: "http_\(status)", message: String(decoding: body.prefix(300), as: UTF8.self))))
            }
            return
        }
        finish(.failed(error ?? URLError(.networkConnectionLost)))
    }
}

/// A Date shared between the video queue and the main actor.
final class SharedDate: @unchecked Sendable {
    private let lock = NSLock()
    private var v = Date.distantPast
    var value: Date { lock.lock(); defer { lock.unlock() }; return v }
    func set(_ d: Date) { lock.lock(); v = d; lock.unlock() }
}

extension DaemonClient {
    /// `GET /v1/devices/:id/video` (streamed; no overall timeout).
    func videoRequest(_ id: String, maxSize: Int) throws -> URLRequest {
        var r = try request("GET", dev(id, "/video"), query: ["maxSize": String(maxSize)], timeout: 8)
        r.setValue(VideoWire.contentType, forHTTPHeaderField: "Accept")
        return r
    }
}
