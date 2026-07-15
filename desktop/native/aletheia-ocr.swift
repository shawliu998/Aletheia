import AppKit
import Foundation
import PDFKit
import Vision

struct OCRBoundingBox: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct OCRBlock: Codable {
    let text: String
    let confidence: Double
    let boundingBox: OCRBoundingBox
}

struct OCRPage: Codable {
    let page: Int
    let text: String
    let confidence: Double
    let blocks: [OCRBlock]
}

struct OCRResult: Codable {
    let schemaVersion: String
    let engine: String
    let coordinateSpace: String
    let pages: [OCRPage]
}

enum OCRError: Error, CustomStringConvertible {
    case invalidPDF
    case tooManyPages
    case invalidArguments
    case invalidPageSelection
    case pageOutOfRange(Int)
    case missingPage(Int)
    case renderFailed(Int)

    var description: String {
        switch self {
        case .invalidPDF: return "invalid_pdf"
        case .tooManyPages: return "too_many_pages"
        case .invalidArguments: return "invalid_arguments"
        case .invalidPageSelection: return "invalid_page_selection"
        case .pageOutOfRange(let page): return "page_out_of_range_\(page)"
        case .missingPage(let page): return "missing_page_\(page)"
        case .renderFailed(let page): return "render_failed_\(page)"
        }
    }
}

func selectedPages(arguments: [String], pageCount: Int) throws -> [Int] {
    if arguments.isEmpty {
        return Array(1...pageCount)
    }
    guard arguments.count == 2, arguments[0] == "--pages" else {
        throw OCRError.invalidArguments
    }
    let specification = arguments[1]
    guard !specification.isEmpty, specification.utf8.count <= 4096 else {
        throw OCRError.invalidPageSelection
    }
    var result: [Int] = []
    var seen = Set<Int>()
    let components = specification.split(separator: ",", omittingEmptySubsequences: false)
    for component in components {
        guard !component.isEmpty else { throw OCRError.invalidPageSelection }
        let bounds = component.split(separator: "-", omittingEmptySubsequences: false)
        let start: Int
        let end: Int
        if bounds.count == 1, let page = Int(bounds[0]) {
            start = page
            end = page
        } else if bounds.count == 2,
                  let first = Int(bounds[0]),
                  let last = Int(bounds[1]),
                  first <= last {
            start = first
            end = last
        } else {
            throw OCRError.invalidPageSelection
        }
        guard start >= 1, end <= pageCount else {
            throw OCRError.pageOutOfRange(start < 1 ? start : end)
        }
        for page in start...end {
            guard !seen.contains(page) else { throw OCRError.invalidPageSelection }
            seen.insert(page)
            result.append(page)
            guard result.count <= pageCount else { throw OCRError.invalidPageSelection }
        }
    }
    guard !result.isEmpty else { throw OCRError.invalidPageSelection }
    return result.sorted()
}

func render(_ page: PDFPage, pageNumber: Int) throws -> CGImage {
    let bounds = page.bounds(for: .mediaBox)
    let longest = max(bounds.width, bounds.height)
    let scale = min(3.0, max(1.5, 3200.0 / max(longest, 1.0)))
    let width = max(1, Int(ceil(bounds.width * scale)))
    let height = max(1, Int(ceil(bounds.height * scale)))
    guard let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        throw OCRError.renderFailed(pageNumber)
    }
    context.setFillColor(CGColor(gray: 1.0, alpha: 1.0))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.saveGState()
    context.scaleBy(x: scale, y: scale)
    page.draw(with: .mediaBox, to: context)
    context.restoreGState()
    guard let image = context.makeImage() else {
        throw OCRError.renderFailed(pageNumber)
    }
    return image
}

func recognize(_ image: CGImage, pageNumber: Int) throws -> OCRPage {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    let observations = (request.results ?? []).sorted { left, right in
        let verticalDelta = left.boundingBox.midY - right.boundingBox.midY
        if abs(verticalDelta) > 0.012 { return verticalDelta > 0 }
        return left.boundingBox.minX < right.boundingBox.minX
    }
    let recognized = observations.compactMap { observation -> (VNRecognizedTextObservation, VNRecognizedText)? in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        return (observation, candidate)
    }
    let blocks = recognized.map { observation, candidate -> OCRBlock in
        let source = observation.boundingBox
        let left = min(1.0, max(0.0, source.minX))
        let right = min(1.0, max(left, source.maxX))
        // Vision coordinates use a bottom-left origin. Vera exposes normalized
        // top-left coordinates so PDF/image viewers can locate a block without
        // depending on the rendered pixel dimensions.
        let top = min(1.0, max(0.0, 1.0 - source.maxY))
        let bottom = min(1.0, max(top, 1.0 - source.minY))
        return OCRBlock(
            text: candidate.string,
            confidence: Double(candidate.confidence),
            boundingBox: OCRBoundingBox(
                x: Double(left),
                y: Double(top),
                width: Double(right - left),
                height: Double(bottom - top)
            )
        )
    }
    let text = recognized.map { $0.1.string }.joined(separator: "\n")
    let confidence = recognized.isEmpty
        ? 0.0
        : recognized.reduce(0.0) { $0 + Double($1.1.confidence) } / Double(recognized.count)
    return OCRPage(page: pageNumber, text: text, confidence: confidence, blocks: blocks)
}

do {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard let document = PDFDocument(data: input) else { throw OCRError.invalidPDF }
    guard document.pageCount <= 500 else { throw OCRError.tooManyPages }
    guard document.pageCount > 0 else { throw OCRError.invalidPDF }
    let requestedPages = try selectedPages(
        arguments: Array(CommandLine.arguments.dropFirst()),
        pageCount: document.pageCount
    )
    var pages: [OCRPage] = []
    for pageNumber in requestedPages {
        guard let page = document.page(at: pageNumber - 1) else {
            throw OCRError.missingPage(pageNumber)
        }
        pages.append(
            try recognize(
                try render(page, pageNumber: pageNumber),
                pageNumber: pageNumber
            )
        )
    }
    let result = OCRResult(
        schemaVersion: "aletheia-native-ocr-v1",
        engine: "apple-vision",
        coordinateSpace: "normalized-top-left",
        pages: pages
    )
    FileHandle.standardOutput.write(try JSONEncoder().encode(result))
} catch {
    let message = String(describing: error).replacingOccurrences(of: "\n", with: " ")
    FileHandle.standardError.write(Data(message.utf8))
    exit(1)
}
