import AppKit
import CoreGraphics
import CoreText
import Foundation

guard CommandLine.arguments.count == 2 else { exit(2) }
let output = URL(fileURLWithPath: CommandLine.arguments[1])
let width = 1600
let height = 1000
var mediaBox = CGRect(x: 0, y: 0, width: width, height: height)
guard let consumer = CGDataConsumer(url: output as CFURL),
      let context = CGContext(consumer: consumer, mediaBox: &mediaBox, nil) else {
    exit(3)
}

// Page 1 is native PDF text. PDF.js must retain this layer and skip OCR.
context.beginPDFPage(nil)
context.setFillColor(NSColor.white.cgColor)
context.fill(mediaBox)
context.textMatrix = .identity
let searchable = NSAttributedString(
    string: "SEARCHABLE CONTRACT COVER PAGE",
    attributes: [
        .font: NSFont.systemFont(ofSize: 64, weight: .medium),
        .foregroundColor: NSColor.black,
    ]
)
context.textPosition = CGPoint(x: 100, y: 760)
CTLineDraw(CTLineCreateWithAttributedString(searchable), context)
context.endPDFPage()

// Page 2 is a raster-only scan. The words are visible to Vision but there is
// deliberately no PDF text layer.
guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: width,
    pixelsHigh: height,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
) else { exit(4) }
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSColor.white.setFill()
NSRect(x: 0, y: 0, width: width, height: height).fill()
let scanAttributes: [NSAttributedString.Key: Any] = [
    .font: NSFont.monospacedSystemFont(ofSize: 72, weight: .medium),
    .foregroundColor: NSColor.black,
]
NSString(string: "SCANNED EXHIBIT PAYMENT 480000").draw(
    at: NSPoint(x: 100, y: 650),
    withAttributes: scanAttributes
)
NSString(string: "EVIDENCE DATE 2026-06-28").draw(
    at: NSPoint(x: 100, y: 460),
    withAttributes: scanAttributes
)
NSGraphicsContext.restoreGraphicsState()
guard let scan = bitmap.cgImage else { exit(5) }
context.beginPDFPage(nil)
context.draw(scan, in: mediaBox)
context.endPDFPage()

// Page 3 is intentionally blank. A successful empty OCR response is a review
// signal, not a missing provider response.
context.beginPDFPage(nil)
context.setFillColor(NSColor.white.cgColor)
context.fill(mediaBox)
context.endPDFPage()
context.closePDF()
