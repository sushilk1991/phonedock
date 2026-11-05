// pd-ocr: OCR a PNG with Apple Vision and print JSON to stdout.
// Usage: pd-ocr <image.png> [--fast]
// Output: [{"text","confidence","x","y","width","height","words"?}] in image PIXELS, top-left origin, one per line.
// "words": [{"text","x","y","width","height"}], the line's whitespace-separated words with their own boxes;
// present when the line has two or more words. No language correction, so codes, handles and names come out as
// they are drawn.
import Foundation
import Vision
import ImageIO
import CoreGraphics

struct Word: Codable { let text: String; let x: Int; let y: Int; let width: Int; let height: Int }
struct Item: Codable { let text: String; let confidence: Double; let x: Int; let y: Int; let width: Int; let height: Int; let words: [Word]? }

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(1)
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: pd-ocr <image.png> [--fast]") }
let url = URL(fileURLWithPath: args[1])
guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else { fail("cannot read image: \(args[1])") }
let w = Double(image.width), h = Double(image.height)

let request = VNRecognizeTextRequest()
request.recognitionLevel = args.contains("--fast") ? .fast : .accurate
request.usesLanguageCorrection = false
let handler = VNImageRequestHandler(cgImage: image, options: [:])
do { try handler.perform([request]) } catch { fail("vision failed: \(error)") }

/// Normalized box (bottom-left origin) to pixel x, y, width, height (top-left origin).
func pixels(_ bb: CGRect) -> (Int, Int, Int, Int) {
    (Int((bb.minX * w).rounded()), Int(((1.0 - bb.maxY) * h).rounded()), Int((bb.width * w).rounded()), Int((bb.height * h).rounded()))
}

/// Ranges of the whitespace-separated words of `s`.
func wordRanges(_ s: String) -> [Range<String.Index>] {
    var out: [Range<String.Index>] = []
    var i = s.startIndex
    while i < s.endIndex {
        while i < s.endIndex && s[i].isWhitespace { i = s.index(after: i) }
        if i == s.endIndex { break }
        let start = i
        while i < s.endIndex && !s[i].isWhitespace { i = s.index(after: i) }
        out.append(start..<i)
    }
    return out
}

var items: [Item] = []
for obs in request.results ?? [] {
    guard let cand = obs.topCandidates(1).first else { continue }
    let (x, y, bw, bh) = pixels(obs.boundingBox)
    let ranges = wordRanges(cand.string)
    var words: [Word]? = nil
    if ranges.count > 1 {
        words = ranges.compactMap { r in
            guard let box = try? cand.boundingBox(for: r)?.boundingBox, box.width > 0, box.height > 0 else { return nil }
            let (wx, wy, ww, wh) = pixels(box)
            return Word(text: String(cand.string[r]), x: wx, y: wy, width: ww, height: wh)
        }
        if words?.isEmpty == true { words = nil }
    }
    items.append(Item(text: cand.string, confidence: Double(cand.confidence), x: x, y: y, width: bw, height: bh, words: words))
}
let enc = JSONEncoder()
enc.outputFormatting = [.withoutEscapingSlashes, .sortedKeys]
FileHandle.standardOutput.write(try! enc.encode(items))
FileHandle.standardOutput.write("\n".data(using: .utf8)!)
