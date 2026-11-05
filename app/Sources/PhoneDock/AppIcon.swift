import AppKit
import SwiftUI

/// Programmatic app icon: an indigo squircle holding two live phones, a dimmed one behind and a bright one in front
/// with the agent sparkle on its screen ("one place where your agents use your devices"). Sizes up to 40 px use a
/// simplified render (no rim, highlight or island; bigger phones and sparkle) so it stays legible.
/// Compiled on its own by scripts/build-app.sh, so it must not depend on other app files.
enum AppIcon {
    private static let space = CGColorSpace(name: CGColorSpace.sRGB)!

    private static func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
        CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
    }

    private static func gradient(_ colors: [CGColor], _ locations: [CGFloat]? = nil) -> CGGradient {
        CGGradient(colorsSpace: space, colors: colors as CFArray, locations: locations)!
    }

    /// Continuous ("squircle") corners, matching system icons.
    private static func continuous(_ r: CGRect, radius: CGFloat) -> CGPath {
        RoundedRectangle(cornerRadius: radius, style: .continuous).path(in: r).cgPath
    }

    /// A four-point star centred on `c` with arm length `a`.
    private static func sparkle(_ c: CGPoint, _ a: CGFloat) -> CGPath {
        let k = a * 0.16
        let p = CGMutablePath()
        p.move(to: CGPoint(x: c.x, y: c.y - a))
        p.addQuadCurve(to: CGPoint(x: c.x + a, y: c.y), control: CGPoint(x: c.x + k, y: c.y - k))
        p.addQuadCurve(to: CGPoint(x: c.x, y: c.y + a), control: CGPoint(x: c.x + k, y: c.y + k))
        p.addQuadCurve(to: CGPoint(x: c.x - a, y: c.y), control: CGPoint(x: c.x - k, y: c.y + k))
        p.addQuadCurve(to: CGPoint(x: c.x, y: c.y - a), control: CGPoint(x: c.x - k, y: c.y - k))
        p.closeSubpath()
        return p
    }

    /// Draws a phone (black body, metal rim, gradient screen, island) and returns its screen rect. y-down context.
    private static func phone(_ ctx: CGContext, _ r: CGRect, u: CGFloat, small: Bool,
                              screen: (CGColor, CGColor), shadow: CGFloat) -> CGRect {
        let radius = r.width * 0.22
        ctx.saveGState()
        ctx.setShadow(offset: CGSize(width: 0, height: 14 * u), blur: 40 * u, color: CGColor(gray: 0, alpha: shadow))
        ctx.addPath(continuous(r, radius: radius))
        ctx.setFillColor(color(0x0D0C14))
        ctx.fillPath()
        ctx.restoreGState()
        if !small {
            ctx.saveGState()
            ctx.addPath(continuous(r, radius: radius))
            ctx.clip()
            ctx.drawLinearGradient(gradient([color(0x8A88A0), color(0x2C2B38)]),
                                   start: CGPoint(x: r.midX, y: r.minY), end: CGPoint(x: r.midX, y: r.maxY), options: [])
            ctx.restoreGState()
            let body = r.insetBy(dx: 6 * u, dy: 6 * u)
            ctx.addPath(continuous(body, radius: radius - 6 * u))
            ctx.setFillColor(color(0x0D0C14))
            ctx.fillPath()
        }
        let inset = r.width * (small ? 0.09 : 0.065)
        let scr = r.insetBy(dx: inset, dy: inset)
        ctx.saveGState()
        ctx.addPath(continuous(scr, radius: max(0, radius - inset)))
        ctx.clip()
        ctx.drawLinearGradient(gradient([screen.0, screen.1]),
                               start: CGPoint(x: scr.midX, y: scr.minY), end: CGPoint(x: scr.midX, y: scr.maxY), options: [])
        ctx.restoreGState()
        if !small {
            let iw = scr.width * 0.30, ih = scr.width * 0.085
            let island = CGRect(x: scr.midX - iw / 2, y: scr.minY + scr.width * 0.06, width: iw, height: ih)
            ctx.addPath(CGPath(roundedRect: island, cornerWidth: ih / 2, cornerHeight: ih / 2, transform: nil))
            ctx.setFillColor(color(0x0D0C14))
            ctx.fillPath()
        }
        return scr
    }

    static func cgImage(size: Int) -> CGImage? {
        let s = CGFloat(size)
        let small = size <= 40
        guard let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        // Draw y-down, on a 1024-unit canvas.
        ctx.translateBy(x: 0, y: s)
        ctx.scaleBy(x: 1, y: -1)
        let u = s / 1024
        let rect = CGRect(x: 100 * u, y: 100 * u, width: 824 * u, height: 824 * u)
        let squircle = continuous(rect, radius: 185 * u)

        // Drop shadow under the squircle.
        ctx.saveGState()
        ctx.setShadow(offset: CGSize(width: 0, height: 12 * u), blur: 30 * u, color: CGColor(gray: 0, alpha: small ? 0.2 : 0.32))
        ctx.addPath(squircle)
        ctx.setFillColor(color(0x2B2280))
        ctx.fillPath()
        ctx.restoreGState()

        ctx.saveGState()
        ctx.addPath(squircle)
        ctx.clip()

        // Background: indigo, top to bottom, plus a soft top-left highlight.
        ctx.drawLinearGradient(gradient([color(0x6A5CF5), color(0x3A2DB8), color(0x24196E)], [0, 0.55, 1]),
                               start: CGPoint(x: rect.midX, y: rect.minY), end: CGPoint(x: rect.midX, y: rect.maxY), options: [])
        if !small {
            let c = CGPoint(x: rect.minX + rect.width * 0.25, y: rect.minY + rect.height * 0.12)
            ctx.drawRadialGradient(gradient([CGColor(gray: 1, alpha: 0.16), CGColor(gray: 1, alpha: 0)]),
                                   startCenter: c, startRadius: 0, endCenter: c, endRadius: rect.width * 0.8, options: [])
        }

        // Two phones: a dimmed one behind (up and left), the live one in front with the agent sparkle.
        let pw = (small ? 330 : 290) * u, ph = pw * (small ? 1.8 : 1.98)
        let shift = (small ? 34 : 40) * u
        let back = CGRect(x: 512 * u - pw * 0.98, y: 512 * u - ph / 2 - shift, width: pw, height: ph)
        ctx.saveGState()
        ctx.setAlpha(small ? 0.7 : 0.55)
        _ = phone(ctx, back, u: u, small: small, screen: (color(0xB9B2FF), color(0x8D83F2)), shadow: 0.3)
        ctx.restoreGState()
        let front = CGRect(x: 512 * u - pw * 0.08, y: 512 * u - ph / 2 + shift, width: pw, height: ph)
        let scr = phone(ctx, front, u: u, small: small, screen: (color(0xFFFFFF), color(0xE4E0FF)), shadow: 0.45)
        let c = CGPoint(x: scr.midX, y: scr.midY + scr.height * 0.03)
        let a = scr.width * (small ? 0.36 : 0.30)
        ctx.saveGState()
        ctx.addPath(sparkle(c, a))
        ctx.clip()
        ctx.drawLinearGradient(gradient([color(0x6A5CF5), color(0x3A2DB8)]),
                               start: CGPoint(x: c.x, y: c.y - a), end: CGPoint(x: c.x, y: c.y + a), options: [])
        ctx.restoreGState()

        ctx.restoreGState()
        return ctx.makeImage()
    }

    static func render(size: Int) -> NSImage? {
        guard let cg = cgImage(size: size) else { return nil }
        return NSImage(cgImage: cg, size: NSSize(width: size, height: size))
    }

    static func writePNG(size: Int, to url: URL) -> Bool {
        guard let cg = cgImage(size: size) else { return false }
        let rep = NSBitmapImageRep(cgImage: cg)
        guard let data = rep.representation(using: .png, properties: [:]) else { return false }
        return (try? data.write(to: url)) != nil
    }
}
