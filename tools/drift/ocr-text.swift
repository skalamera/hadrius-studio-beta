// Local, offline text recognition for drift evidence (macOS Vision framework; no network).
// Usage: swift tools/drift/ocr-text.swift [--roi x,y,w,h] IMAGE.png [IMAGE2.png ...]  -> JSON {"<path>": ["line", ...]}
//   --roi: optional region of interest in normalized TOP-LEFT image coordinates (0..1), e.g. the app's company
//          switcher 0,0,0.2,0.16. Only text inside it is returned.
// Evidence: repair-report.mjs uses it to corroborate what a recorded slide shows; tenant-evidence.mjs uses it (with
// --roi on the company switcher) as one of several conditions for the tenant of a script whose URLs name no company.
import Foundation
import Vision
import AppKit

var args = Array(CommandLine.arguments.dropFirst())
var roi: CGRect? = nil
if let i = args.firstIndex(of: "--roi"), i + 1 < args.count {
  let p = args[i + 1].split(separator: ",").compactMap { Double($0) }
  if p.count == 4 {
    // Vision's regionOfInterest is normalized with a BOTTOM-left origin.
    roi = CGRect(x: p[0], y: 1.0 - p[1] - p[3], width: p[2], height: p[3])
  }
  args.removeSubrange(i...(i + 1))
}
var out: [String: [String]] = [:]
for path in args {
  guard let image = NSImage(contentsOfFile: path),
        let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { out[path] = []; continue }
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = false
  if let r = roi { request.regionOfInterest = r }
  try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([request])
  out[path] = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
}
let data = try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
