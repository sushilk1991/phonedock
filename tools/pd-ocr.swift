// pd-ocr: OCR a PNG with Apple Vision and print JSON to stdout.
// Usage: pd-ocr <image.png> [--fast]
// Output: [{"text","confidence","x","y","width","height"}] in image PIXELS, top-left origin.
import Foundation
import Vision
import ImageIO
import CoreGraphics

struct Item: Codable { let text: String; let confidence: Double; let x: Int; let y: Int; let width: Int; let height: Int }

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
request.usesLanguageCorrection = true
let handler = VNImageRequestHandler(cgImage: image, options: [:])
do { try handler.perform([request]) } catch { fail("vision failed: \(error)") }

var items: [Item] = []
for obs in request.results ?? [] {
    guard let cand = obs.topCandidates(1).first else { continue }
    let bb = obs.boundingBox // normalized, bottom-left origin
    let x = bb.minX * w, y = (1.0 - bb.maxY) * h
    items.append(Item(text: cand.string, confidence: Double(cand.confidence),
                      x: Int(x.rounded()), y: Int(y.rounded()),
                      width: Int((bb.width * w).rounded()), height: Int((bb.height * h).rounded())))
}
let enc = JSONEncoder()
enc.outputFormatting = [.withoutEscapingSlashes]
FileHandle.standardOutput.write(try! enc.encode(items))
FileHandle.standardOutput.write("\n".data(using: .utf8)!)
