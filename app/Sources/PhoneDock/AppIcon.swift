import AppKit
import SwiftUI

/// Programmatic app icon: an indigo squircle with a glass dock cradle holding a dark phone; the agent sparkle lives on
/// the phone's screen. Sizes up to 32 px use a simplified render (no highlight or rim, bigger phone and sparkle) so it
/// stays legible. Compiled on its own by scripts/build-app.sh, so it must not depend on other app files.
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

    /// A four-point star centred in `r`, `r.width` wide.
    private static func sparkle(in r: CGRect) -> CGPath {
        let cx = r.midX, cy = r.midY, a = r.width / 2, k = a * 0.16
        let p = CGMutablePath()
        p.move(to: CGPoint(x: cx, y: cy + a))
        p.addQuadCurve(to: CGPoint(x: cx + a, y: cy), control: CGPoint(x: cx + k, y: cy + k))
        p.addQuadCurve(to: CGPoint(x: cx, y: cy - a), control: CGPoint(x: cx + k, y: cy - k))
        p.addQuadCurve(to: CGPoint(x: cx - a, y: cy), control: CGPoint(x: cx - k, y: cy - k))
        p.addQuadCurve(to: CGPoint(x: cx, y: cy + a), control: CGPoint(x: cx - k, y: cy + k))
        p.closeSubpath()
        return p
    }

    static func cgImage(size: Int) -> CGImage? {
        let s = CGFloat(size)
        let small = size <= 32
        guard let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        let u = s / 1024   // design units: a 1024 canvas
        // CoreGraphics is y-up: rect.minY is the bottom edge.
        let rect = CGRect(x: 100 * u, y: 100 * u, width: 824 * u, height: 824 * u)
        let squircle = continuous(rect, radius: 185 * u)

        // Drop shadow under the squircle.
        ctx.saveGState()
        ctx.setShadow(offset: CGSize(width: 0, height: -12 * u), blur: 30 * u, color: CGColor(gray: 0, alpha: small ? 0.25 : 0.35))
        ctx.addPath(squircle)
        ctx.setFillColor(color(0x2B2280))
        ctx.fillPath()
        ctx.restoreGState()

        ctx.saveGState()
        ctx.addPath(squircle)
        ctx.clip()

        // Background: indigo, top to bottom, plus a soft top-left highlight.
        ctx.drawLinearGradient(gradient([color(0x5B4FE9), color(0x2B2280)]),
                               start: CGPoint(x: rect.midX, y: rect.maxY), end: CGPoint(x: rect.midX, y: rect.minY), options: [])
        if !small {
            let c = CGPoint(x: rect.minX + rect.width * 0.22, y: rect.maxY - rect.height * 0.16)
            ctx.drawRadialGradient(gradient([CGColor(gray: 1, alpha: 0.14), CGColor(gray: 1, alpha: 0)]),
                                   startCenter: c, startRadius: 0, endCenter: c, endRadius: rect.width * 0.75, options: [])
        }

        // Geometry: the cradle sits 18% up; the phone's bottom 6% hides behind its lip.
        let dockW = rect.width * 0.62, dockH = rect.height * (small ? 0.10 : 0.09)
        let dock = CGRect(x: rect.midX - dockW / 2, y: rect.minY + rect.height * (small ? 0.08 : 0.18), width: dockW, height: dockH)
        let pw = rect.width * (small ? 0.44 : 0.34)
        let ph = pw * (small ? 1.75 : 2.05)
        let phone = CGRect(x: rect.midX - pw / 2, y: dock.maxY - ph * 0.06, width: pw, height: ph)
        let phoneRadius = pw * 0.22

        // Phone: soft shadow, rim, body.
        ctx.saveGState()
        ctx.setShadow(offset: CGSize(width: 0, height: -10 * u), blur: 36 * u, color: CGColor(gray: 0, alpha: 0.45))
        ctx.addPath(continuous(phone, radius: phoneRadius))
        ctx.setFillColor(color(0x0E0E12))
        ctx.fillPath()
        ctx.restoreGState()
        let rim = small ? 0 : s * 0.012
        if rim > 0 {
            ctx.saveGState()
            ctx.addPath(continuous(phone, radius: phoneRadius))
            ctx.clip()
            ctx.drawLinearGradient(gradient([color(0x6E6E80), color(0x2A2A33)]),
                                   start: CGPoint(x: phone.midX, y: phone.maxY), end: CGPoint(x: phone.midX, y: phone.minY), options: [])
            ctx.restoreGState()
            let body = phone.insetBy(dx: rim, dy: rim)
            ctx.addPath(continuous(body, radius: phoneRadius - rim))
            ctx.setFillColor(color(0x0E0E12))
            ctx.fillPath()
        }

        // Screen: dark indigo (a white screen blows out at small sizes) with the agent sparkle.
        let inset = pw * 0.06
        let screen = phone.insetBy(dx: inset, dy: inset)
        ctx.saveGState()
        ctx.addPath(continuous(screen, radius: max(0, phoneRadius - inset)))
        ctx.clip()
        ctx.drawLinearGradient(gradient([color(0x1A1640), color(0x3A2FA0)]),
                               start: CGPoint(x: screen.midX, y: screen.maxY), end: CGPoint(x: screen.midX, y: screen.minY), options: [])
        let sw = screen.width * (small ? 0.5 : 0.4)
        let visibleMid = (screen.maxY + dock.maxY) / 2   // centre on the part of the screen above the cradle
        let star = CGRect(x: screen.midX - sw / 2, y: visibleMid - sw / 2, width: sw, height: sw)
        ctx.addPath(sparkle(in: star))
        ctx.clip()
        ctx.drawLinearGradient(gradient([CGColor(gray: 1, alpha: 1), color(0xC9C3FF)]),
                               start: CGPoint(x: star.midX, y: star.maxY), end: CGPoint(x: star.midX, y: star.minY), options: [])
        ctx.restoreGState()

        // Cradle: frosted glass slab over the phone's foot, with a bright top edge.
        let cradle = continuous(dock, radius: dockH * 0.32)
        ctx.addPath(cradle)
        ctx.setFillColor(CGColor(gray: 1, alpha: small ? 0.30 : 0.16))
        ctx.fillPath()
        if !small {
            ctx.saveGState()
            ctx.addPath(cradle)
            ctx.clip()
            let edge = max(1, 2 * u)
            ctx.setFillColor(CGColor(gray: 1, alpha: 0.35))
            ctx.fill(CGRect(x: dock.minX, y: dock.maxY - edge, width: dock.width, height: edge))
            ctx.restoreGState()
        }

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
