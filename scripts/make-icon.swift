// Builds the extension icon (resources/icon.png, the "icon" of package.json) from its source
// resources/icon-space.svg — the icon of the universe page of gw (a planet in its orbit among
// stars; in this copy the small star that was over the label is moved under the big star on the
// right, and the big star on the left up and to the left) —, turned by -90°, with the label
// CLAUDE (the same picture as the icons of babylon-editor and tts-stt-md-aloud, which have the
// labels BABYLON and TTS/STT MD). The picture fills a square with rounded corners (its drawn bounds, outline
// included, centred, with a margin); the label stays inside those bounds, in their bottom right
// corner: its right edge at the outermost star on the right, its bottom a little above the bottom
// tip of the big star on the left (labelLift). Both are drawn in ink with an outline in paper (the
// colour of the background, so the label cuts the lines it crosses), on the square of paper —
// white on black.
//
//   swift scripts/make-icon.swift
//
// Run from the project root (macOS: AppKit draws the SVG).

import AppKit
import Foundation

let source = "resources/icon-space.svg"
let output = "resources/icon.png"
let N = 1024                 // drawing size
let size = 256               // the size written (the Marketplace shows 128 px, 256 px on Retina screens)
let margin: CGFloat = 46     // free space between the picture and the edges of the background, at the drawing size
let cornerRadius: CGFloat = 184 // the background: a square with rounded corners, at the drawing size
let paper = "#000000"        // the colour of the background and of the outlines
let ink = "#ffffff"          // the colour of the picture and of the label
let label = "CLAUDE"
let labelShare: CGFloat = 0.7 // width of the label as a share of the width of the picture
let labelLift: CGFloat = 0.05 // the label stands this share of the height of the picture above its bottom edge
let pictureOutline = 18      // width of the white outline of the picture, in units of its viewBox
let pictureRotation = -90    // degrees, as SVG turns (negative: counter-clockwise), about the centre of the viewBox

guard let svg = try? String(contentsOfFile: source, encoding: .utf8) else { fatalError("cannot read \(source)") }

/// The viewBox of the SVG: x, y, width, height.
func viewBox() -> [Double] {
    guard let start = svg.range(of: "viewBox=\""),
          let end = svg.range(of: "\"", range: start.upperBound..<svg.endIndex) else { fatalError("no viewBox in \(source)") }
    let box = svg[start.upperBound..<end.lowerBound].split(whereSeparator: { $0 == " " || $0 == "," }).compactMap { Double($0) }
    guard box.count == 4 else { fatalError("no viewBox in \(source)") }
    return box
}

/// The SVG with all its shapes in one group of the given paint (the shapes have no paint of their
/// own), turned by pictureRotation; its viewBox is widened by the outline on every side, so the
/// outline of a shape at the edge (the top star once turned) is not cut off.
func painted(_ paint: String) -> NSImage {
    guard let open = svg.range(of: ">", range: svg.range(of: "<svg")!.upperBound..<svg.endIndex),
          let close = svg.range(of: "</svg>", options: .backwards),
          let attribute = svg.range(of: "viewBox=\"[^\"]*\"", options: .regularExpression) else { fatalError("not an SVG") }
    let box = viewBox()
    let (cx, cy) = (box[0] + box[2] / 2, box[1] + box[3] / 2)
    let pad = Double(pictureOutline)
    let widened = "viewBox=\"\(box[0] - pad) \(box[1] - pad) \(box[2] + 2 * pad) \(box[3] + 2 * pad)\""
    let header = svg[..<open.upperBound].replacingCharacters(in: attribute, with: widened)
    let group = "<g transform=\"rotate(\(pictureRotation) \(cx) \(cy))\" \(paint)>"
    let text = header + group + svg[open.upperBound..<close.lowerBound] + "</g></svg>"
    guard let image = NSImage(data: Data(text.utf8)) else { fatalError("cannot draw the SVG") }
    return image
}

/// - Parameter hex: `#rrggbb`
/// - Returns: the colour
func color(_ hex: String) -> NSColor {
    let value = Int(hex.dropFirst(), radix: 16) ?? 0
    return NSColor(srgbRed: CGFloat((value >> 16) & 255) / 255, green: CGFloat((value >> 8) & 255) / 255,
                   blue: CGFloat(value & 255) / 255, alpha: 1)
}

/// A transparent N × N bitmap context, drawn into with AppKit.
func canvas() -> CGContext {
    let ctx = CGContext(data: nil, width: N, height: N, bitsPerComponent: 8, bytesPerRow: N * 4,
                        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
    return ctx
}

/// The bounds of the opaque pixels of a context (origin at the bottom left, as CoreGraphics draws).
func drawnBounds(_ ctx: CGContext) -> CGRect {
    let pixels = ctx.data!.bindMemory(to: UInt8.self, capacity: N * N * 4)
    var minX = N, minY = N, maxX = -1, maxY = -1
    for row in 0..<N {
        for column in 0..<N where pixels[(row * N + column) * 4 + 3] > 8 {
            minX = min(minX, column); maxX = max(maxX, column)
            minY = min(minY, row); maxY = max(maxY, row)
        }
    }
    guard maxX >= 0 else { fatalError("the picture is empty") }
    // The bitmap rows run from the top
    return CGRect(x: minX, y: N - 1 - maxY, width: maxX - minX + 1, height: maxY - minY + 1)
}

// The picture over the whole canvas: its outline (the shapes stroked wide), then the shapes
let full = NSRect(x: 0, y: 0, width: N, height: N)
let pictureCanvas = canvas()
painted("fill=\"\(paper)\" stroke=\"\(paper)\" stroke-width=\"\(pictureOutline * 2)\" stroke-linejoin=\"round\"").draw(in: full)
painted("fill=\"\(ink)\"").draw(in: full)
let bounds = drawnBounds(pictureCanvas)

// Its drawn bounds fill the icon, centred
let scale = (CGFloat(N) - 2 * margin) / max(bounds.width, bounds.height)
let placed = CGRect(x: (CGFloat(N) - bounds.width * scale) / 2, y: (CGFloat(N) - bounds.height * scale) / 2,
                    width: bounds.width * scale, height: bounds.height * scale)
let ctx = canvas()
ctx.interpolationQuality = .high
color(paper).setFill()
let background = NSBezierPath(roundedRect: full, xRadius: cornerRadius, yRadius: cornerRadius)
background.fill()
// Nothing is drawn outside the background (the outline of a corner of the label)
background.addClip()
ctx.draw(pictureCanvas.makeImage()!, in: CGRect(x: placed.minX - bounds.minX * scale, y: placed.minY - bounds.minY * scale,
                                                width: CGFloat(N) * scale, height: CGFloat(N) * scale))

// The label: a condensed black face, labelShare of the picture wide, with an outline as wide as the
// picture's; its outline ends at the right edge of the picture, labelLift above its bottom edge
let outline = 2 * CGFloat(pictureOutline) * CGFloat(N) / CGFloat(viewBox()[2] + 2 * Double(pictureOutline)) * scale
let font = NSFont(name: "HelveticaNeue-CondensedBlack", size: 100) ?? NSFont.systemFont(ofSize: 100, weight: .black)
let probe = NSAttributedString(string: label, attributes: [.font: font]).size()
let fitted = font.withSize(100 * labelShare * placed.width / probe.width)
let box = NSAttributedString(string: label, attributes: [.font: fitted]).size()
// (a string is drawn from the bottom of its box, the descender below the baseline)
let origin = NSPoint(x: placed.maxX - outline / 2 - box.width,
                     y: placed.minY + outline / 2 + labelLift * placed.height + fitted.descender)
// The outline first, then the letters over it
NSAttributedString(string: label, attributes: [
    .font: fitted, .strokeColor: color(paper), .strokeWidth: 100 * outline / fitted.pointSize,
]).draw(at: origin)
NSAttributedString(string: label, attributes: [.font: fitted, .foregroundColor: color(ink)]).draw(at: origin)

// Scaled down to the icon size
let small = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4,
                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
small.interpolationQuality = .high
small.draw(ctx.makeImage()!, in: CGRect(x: 0, y: 0, width: size, height: size))
let rep = NSBitmapImageRep(cgImage: small.makeImage()!)
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output))
print("wrote \(output) (\(size) px)")
