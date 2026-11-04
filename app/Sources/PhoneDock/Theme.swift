// Theme.swift — PhoneDock design tokens + shared components.
// macOS 15 deployment target, Swift 5 language mode. Liquid Glass only behind #available(macOS 26, *).

import SwiftUI
import AppKit

// MARK: - Tokens

enum Theme {

    // MARK: Color plumbing

    /// sRGB colour from 0xRRGGBB.
    static func rgb(_ hex: UInt32, alpha: CGFloat = 1) -> NSColor {
        NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: alpha)
    }

    static func isDark(_ appearance: NSAppearance) -> Bool {
        let names: [NSAppearance.Name] = [.aqua, .darkAqua, .accessibilityHighContrastAqua, .accessibilityHighContrastDarkAqua]
        let match = appearance.bestMatch(from: names)
        return match == .darkAqua || match == .accessibilityHighContrastDarkAqua
    }

    /// System Settings › Accessibility › Display › Increase contrast.
    static func isHighContrast(_ appearance: NSAppearance) -> Bool {
        let names: [NSAppearance.Name] = [.aqua, .darkAqua, .accessibilityHighContrastAqua, .accessibilityHighContrastDarkAqua]
        let match = appearance.bestMatch(from: names)
        return match == .accessibilityHighContrastAqua || match == .accessibilityHighContrastDarkAqua
    }

    /// Light/dark colour resolved by AppKit for the view's effective appearance.
    static func dynamic(light: UInt32, dark: UInt32, lightAlpha: CGFloat = 1, darkAlpha: CGFloat = 1) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            Theme.isDark(appearance) ? Theme.rgb(dark, alpha: darkAlpha) : Theme.rgb(light, alpha: lightAlpha)
        })
    }

    /// Like `dynamic`, with stronger values when Increase Contrast is on (system colours do this on their own).
    static func dynamic(light: UInt32, dark: UInt32, lightAlpha: CGFloat = 1, darkAlpha: CGFloat = 1,
                        contrastLight: UInt32, contrastDark: UInt32, contrastLightAlpha: CGFloat = 1, contrastDarkAlpha: CGFloat = 1) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = Theme.isDark(appearance)
            if Theme.isHighContrast(appearance) {
                return isDark ? Theme.rgb(contrastDark, alpha: contrastDarkAlpha) : Theme.rgb(contrastLight, alpha: contrastLightAlpha)
            }
            return isDark ? Theme.rgb(dark, alpha: darkAlpha) : Theme.rgb(light, alpha: lightAlpha)
        })
    }

    // MARK: Surfaces

    enum Surface {
        /// Chrome, inspector, sheets (system).
        static let window = Color(nsColor: .windowBackgroundColor)
        /// Lists, form rows, code and log wells (system).
        static let content = Color(nsColor: .controlBackgroundColor)
        /// Behind the device frame.
        static let stage = Theme.dynamic(light: 0xE8E8EC, dark: 0x161618)
        /// Raised cards, glass fallback.
        static let card = Theme.dynamic(light: 0xFFFFFF, dark: 0x2A2A2D)
    }

    // MARK: Text

    enum Ink {
        static let primary = Color(nsColor: .labelColor)
        /// Informational secondary text. System secondaryLabelColor is ~3.95:1 on white, below AA.
        static let secondary = Theme.dynamic(light: 0x5C5C61, dark: 0xAEAEB2, contrastLight: 0x3A3A3E, contrastDark: 0xD1D1D6)
        /// Placeholders, disabled and decorative text only (fails AA by design).
        static let tertiary = Color(nsColor: .tertiaryLabelColor)
        static let onFill = Color.white
    }

    // MARK: Lines

    enum Line {
        static let separator = Color(nsColor: .separatorColor)
        static let card = Theme.dynamic(light: 0x000000, dark: 0xFFFFFF, lightAlpha: 0.08, darkAlpha: 0.10,
                                        contrastLight: 0x000000, contrastDark: 0xFFFFFF, contrastLightAlpha: 0.35, contrastDarkAlpha: 0.40)
    }

    // MARK: Accent (indigo)

    enum Accent {
        static let fill = Theme.dynamic(light: 0x5856D6, dark: 0x5E5CE6)
        static let text = Theme.dynamic(light: 0x5856D6, dark: 0xA5A3FF)
    }

    // MARK: Status

    enum Status {
        static let running = Theme.dynamic(light: 0x248A3D, dark: 0x30D158)
        static let booting = Theme.dynamic(light: 0x9A7B00, dark: 0xFFD60A)
        static let error = Theme.dynamic(light: 0xD70015, dark: 0xFF453A)
        static let errorText = Theme.dynamic(light: 0xC0000F, dark: 0xFF6961)
        static let agent = Theme.dynamic(light: 0xAF52DE, dark: 0xBF5AF2)
        static let agentStrong = Theme.dynamic(light: 0x7A2FA8, dark: 0x8E44C8)   // button fill, white text
        static let agentText = Theme.dynamic(light: 0x7A2FA8, dark: 0xD08CFF)
        static let agentTint = Theme.dynamic(light: 0xE5DAEA, dark: 0x433749)
        static let human = Theme.dynamic(light: 0x5856D6, dark: 0x7D7AFF)
        static let handoff = Theme.dynamic(light: 0xC2410C, dark: 0xFF9F0A)
        static let handoffStrong = Color(nsColor: Theme.rgb(0xC2410C))           // button/tile fill, white glyph/text
        static let handoffText = Theme.dynamic(light: 0x9A3D00, dark: 0xFF9F0A)
        static let handoffTint = Theme.dynamic(light: 0xE7D7D1, dark: 0x4B3F2D)
        static let recording = Theme.dynamic(light: 0xFF3B30, dark: 0xFF453A)
    }

    /// Drawn on top of device pixels (UI-tree highlight). Not appearance-dependent: it sits on the device's own colours.
    enum Inspect {
        static let stroke = Color(nsColor: Theme.rgb(0xFF2D92))
        static let fill = Color(nsColor: Theme.rgb(0xFF2D92, alpha: 0.14))
        static let halo = Color.white.opacity(0.85)
    }

    enum DeviceFrame {
        static let bezel = Color(nsColor: Theme.rgb(0x0B0B0C))
        static let rim = Theme.dynamic(light: 0x2C2C2E, dark: 0x3A3A3E)
        static let shadow = Theme.dynamic(light: 0x000000, dark: 0x000000, lightAlpha: 0.18, darkAlpha: 0.50)
        static let iosCorner: CGFloat = 0.12
        static let androidCorner: CGFloat = 0.07
        static let bezelRatio: CGFloat = 0.035
    }

    enum Elevation {
        static let card = Theme.dynamic(light: 0x000000, dark: 0x000000, lightAlpha: 0.06, darkAlpha: 0)
        static let float = Color.black.opacity(0.18)
    }

    // MARK: Type

    enum Fonts {
        static let display = Font.title2.weight(.semibold)                 // 17
        static let title = Font.title3.weight(.semibold)                   // 15
        static let headline = Font.headline                                 // 13 bold
        static let body = Font.body                                         // 13
        static let callout = Font.callout                                   // 12
        static let meta = Font.subheadline                                  // 11
        static let caption = Font.caption                                   // 10
        static let eyebrow = Font.caption.weight(.semibold)                 // 10, uppercase + tracking 0.4
        static let mono = Font.system(size: 11, design: .monospaced)
        static let monoSmall = Font.system(size: 10, design: .monospaced)
        static let numeric = Font.body.monospacedDigit()
        static let countdown = Font.system(.title2, design: .rounded).weight(.semibold).monospacedDigit()
    }

    // MARK: Layout

    enum Space {
        static let xxs: CGFloat = 2
        static let xs: CGFloat = 4
        static let s: CGFloat = 6      // label → control
        static let m: CGFloat = 8
        static let l: CGFloat = 12     // separators, inspector padding
        static let xl: CGFloat = 16
        static let xxl: CGFloat = 20   // window/sheet margins
        static let xxxl: CGFloat = 28
        static let windowTop: CGFloat = 14
    }

    /// The device stage reserves fixed slots above and below the frame for the floating bars, so showing or hiding
    /// them never moves or rescales the screen.
    enum Stage {
        /// StageTopBar: who's in control / needs you. Tall enough for a one-row handoff card whose reason wraps to a
        /// second line, so the reason is never cut at the default window size.
        static let topSlot: CGFloat = 72
        static let bottomSlot: CGFloat = 56   // floating hardware bar
        /// Below this stage width the handoff card can't keep its words on one row, so it stacks (reason, then the
        /// answers on their own row) and the top slot is reserved taller. The choice depends only on the stage width,
        /// never on what the bar shows, so the screen still never moves when a card appears.
        static let stackBelowWidth: CGFloat = 660
        static let topSlotStacked: CGFloat = 112
        static func topSlot(stageWidth: CGFloat) -> CGFloat { stageWidth < stackBelowWidth ? topSlotStacked : topSlot }
    }

    enum Radius {
        static let badge: CGFloat = 4
        static let control: CGFloat = 6
        static let card: CGFloat = 10
        static let panel: CGFloat = 14
    }

    // MARK: Motion

    enum Motion {
        static let quick = Animation.easeOut(duration: 0.12)
        static let standard = Animation.snappy(duration: 0.22)
        static let gentle = Animation.smooth(duration: 0.30)
        /// Decorative animation, or nil under Reduce Motion.
        static func decorative(_ animation: Animation, reduceMotion: Bool) -> Animation? {
            reduceMotion ? nil : animation
        }
        /// Disclosures and Details: a quick ease-out, instant under Reduce Motion (§6).
        @MainActor static func expand(_ change: () -> Void) {
            if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { change() } else { withAnimation(quick, change) }
        }
    }
}

// MARK: - Status model

/// What a dot/badge means. Colour is never the only signal: each case has a shape or symbol and a label.
enum PDStatus: Equatable {
    case running, booting, stopping, stopped, error, agent, human, handoff, recording

    init(deviceState: String) {
        switch deviceState {
        case "running": self = .running
        case "booting", "creating": self = .booting
        case "stopping": self = .stopping
        case "error": self = .error
        default: self = .stopped          // stopped, shutdown, offline, unauthorized
        }
    }

    var fill: Color {
        switch self {
        case .running: return Theme.Status.running
        case .booting, .stopping: return Theme.Status.booting
        case .stopped: return Theme.Ink.secondary
        case .error: return Theme.Status.error
        case .agent: return Theme.Status.agent
        case .human: return Theme.Status.human
        case .handoff: return Theme.Status.handoff
        case .recording: return Theme.Status.recording
        }
    }

    var text: Color {
        switch self {
        case .error: return Theme.Status.errorText
        case .agent: return Theme.Status.agentText
        case .human: return Theme.Accent.text
        case .handoff: return Theme.Status.handoffText
        case .recording: return Theme.Ink.primary
        case .running, .booting, .stopping, .stopped: return Theme.Ink.secondary
        }
    }

    var symbol: String? {
        switch self {
        case .agent: return "sparkles"
        case .human: return "person.fill"
        case .handoff: return "hand.raised.fill"
        default: return nil
        }
    }

    var label: String {
        switch self {
        case .running: return "Running"
        case .booting: return "Starting…"
        case .stopping: return "Shutting down…"
        case .stopped: return "Off"
        case .error: return "Needs attention"
        case .agent: return "Agent in control"
        case .human: return "You’re in control"
        case .handoff: return "Needs you"
        case .recording: return "Recording"
        }
    }
}

// MARK: - 1. StatusDot

struct StatusDot: View {
    let status: PDStatus
    var size: CGFloat = 8
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.backgroundProminence) private var prominence

    var body: some View {
        ZStack {
            if status == .stopped {
                Circle().strokeBorder(status.fill, lineWidth: 1.5)
            } else {
                Circle().fill(status.fill)
            }
            if animates {
                Circle()
                    .stroke(status.fill, lineWidth: 1.5)
                    .phaseAnimator([false, true]) { ring, expanded in
                        ring.scaleEffect(expanded ? 2.2 : 1).opacity(expanded ? 0 : 0.7)
                    } animation: { expanded in
                        expanded ? .easeOut(duration: 1.1) : .linear(duration: 0.01)
                    }
            }
        }
        .frame(width: size, height: size)
        // Selected sidebar rows sit on the accent colour; a white halo keeps every status legible there.
        .overlay {
            if prominence == .increased {
                Circle().strokeBorder(Color.white, lineWidth: 1).padding(-1.5)
            }
        }
        // An 8 pt dot is a hard hover target: the tooltip answers on a 16 pt square, without changing the layout.
        .padding(4)
        .contentShape(Rectangle())
        .help(status.label)
        .padding(-4)
        .accessibilityElement()
        .accessibilityLabel("Status")
        .accessibilityValue(status.label)
    }

    private var animates: Bool {
        !reduceMotion && (status == .booting || status == .stopping)
    }
}

// MARK: - 2. Card

struct CardModifier: ViewModifier {
    var padding: CGFloat

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous)
        return content
            .padding(padding)
            .background(Theme.Surface.card, in: shape)
            .overlay(shape.strokeBorder(Theme.Line.card, lineWidth: 1))
            .shadow(color: Theme.Elevation.card, radius: 2, x: 0, y: 1)
    }
}

// MARK: - 3. SectionHeader

struct SectionHeader<Trailing: View>: View {
    let title: String
    let trailing: Trailing

    init(_ title: String, @ViewBuilder trailing: () -> Trailing) {
        self.title = title
        self.trailing = trailing()
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Space.m) {
            Text(title)
                .font(Theme.Fonts.headline)
                .foregroundStyle(Theme.Ink.primary)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: Theme.Space.m)
            trailing
                .font(Theme.Fonts.callout)
                .controlSize(.small)
                .buttonStyle(.borderless)
                // Accent *text* ("+ Save…", "All Apps ⌄", ⋯): the text token, which is light enough to read in dark
                // mode. The root tint is the fill colour, about 2.9:1 on the dark inspector.
                .tint(Theme.Accent.text)
        }
        .padding(.horizontal, Theme.Space.l)
        .padding(.top, Theme.Space.l)
        .padding(.bottom, Theme.Space.s)
    }
}

extension SectionHeader where Trailing == EmptyView {
    init(_ title: String) { self.init(title) { EmptyView() } }
}

// MARK: - 4. Floating bar (Liquid Glass on macOS 26+)

struct FloatingBarModifier: ViewModifier {
    @ViewBuilder
    func body(content: Content) -> some View {
        let padded = content
            .padding(.horizontal, Theme.Space.m)
            .padding(.vertical, Theme.Space.xs)
        if #available(macOS 26.0, *) {
            padded.glassEffect(.regular, in: Capsule())
        } else {
            padded
                .background(.regularMaterial, in: Capsule())
                .overlay(Capsule().strokeBorder(Theme.Line.card, lineWidth: 0.5))
                .shadow(color: Theme.Elevation.float, radius: 12, x: 0, y: 4)
        }
    }
}

// MARK: - 5. ProblemView (the error pattern)

/// Plain-words title, what to do next, raw detail only on request.
struct FriendlyError: Identifiable, Equatable {
    let id = UUID()
    var title: String
    var message: String? = nil
    var details: String? = nil
}

struct ProblemView: View {
    let problem: FriendlyError
    var symbol = "exclamationmark.triangle.fill"
    var tint: Color = Theme.Status.error
    var retryTitle = "Try Again"
    var retry: (() -> Void)? = nil
    /// A second way out, such as "Open Privacy Settings" next to Try Again.
    var otherTitle: String? = nil
    var other: (() -> Void)? = nil
    @Environment(\.pdProblemFullWidth) private var fullWidth
    @State private var showDetails = false
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            Label {
                Text(problem.title).font(Theme.Fonts.headline).foregroundStyle(Theme.Ink.primary)
            } icon: {
                Image(systemName: symbol).foregroundStyle(tint)
            }
            if let message = problem.message {
                Text(message)
                    .font(Theme.Fonts.callout)
                    .foregroundStyle(Theme.Ink.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if retry != nil || other != nil || problem.details != nil {
                HStack(spacing: Theme.Space.l) {
                    if let other, let otherTitle {
                        Button(otherTitle, action: other).controlSize(.small).testAnchor(otherTitle)
                    }
                    if let retry {
                        Button(retryTitle, action: retry).controlSize(.small).testAnchor(retryTitle)
                    }
                    if problem.details != nil {
                        Button(showDetails ? "Hide Details" : "Show Details") {
                            Theme.Motion.expand { showDetails.toggle() }
                        }
                        .buttonStyle(.pdLink)
                        .controlSize(.small)
                        .testAnchor("Show Details")
                    }
                }
            }
            if showDetails, let details = problem.details {
                ScrollView {
                    Text(details)
                        .font(Theme.Fonts.monoSmall)
                        .foregroundStyle(Theme.Ink.secondary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(Theme.Space.m)
                }
                .frame(maxHeight: 160)
                .background(Theme.Surface.content,
                            in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
                .overlay(alignment: .topTrailing) {
                    Button {
                        Clipboard.copy(details)
                        copied = true
                    } label: {
                        Image(systemName: copied ? "checkmark" : "doc.on.doc")
                            .frame(width: 24, height: 24).contentShape(Rectangle())
                    }
                    .buttonStyle(.borderless)
                    .padding(Theme.Space.xs)
                    .help("Copy Details")
                    .accessibilityLabel("Copy Details")
                    .testAnchor("Copy Details")
                }
            }
        }
        // A readable measure on wide stages; in a sheet's column every card spans it, so right edges line up.
        .frame(maxWidth: fullWidth ? .infinity : 420, alignment: .leading)
        .pdCard()
    }
}

extension EnvironmentValues {
    /// Problem cards span their column (sheets), instead of stopping at a 420 pt measure.
    @Entry var pdProblemFullWidth = false
}

// MARK: - Link button

/// An inline text action ("Show Details", "Connect an Agent…") in `Accent.text`. The system `.link` style ignores
/// `.tint` and draws system blue, which clashes with the indigo `Link`s next to it.
struct PDLinkButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Label(configuration: configuration)
    }

    private struct Label: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.isEnabled) private var enabled

        var body: some View {
            configuration.label
                .foregroundStyle(enabled ? Theme.Accent.text : Theme.Ink.tertiary)
                .opacity(configuration.isPressed ? 0.6 : 1)
                .contentShape(Rectangle())
                .pointerStyle(.link)
        }
    }
}

extension ButtonStyle where Self == PDLinkButtonStyle {
    static var pdLink: PDLinkButtonStyle { PDLinkButtonStyle() }
}

// MARK: - Disclosure row

/// "› Set Up by Hand": a chevron and a title that open what's under them. The whole row is the click target (SwiftUI's
/// `DisclosureGroup` on macOS opens only from its small triangle), and every sheet uses this one look.
struct DisclosureRow<Content: View>: View {
    let title: String
    var detail: String? = nil
    @Binding var isExpanded: Bool
    var anchor: String? = nil
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            Button {
                Theme.Motion.expand { isExpanded.toggle() }
            } label: {
                HStack(spacing: Theme.Space.xs) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        .foregroundStyle(Theme.Ink.secondary)
                        .frame(width: 12)
                    Text(title).font(Theme.Fonts.callout.weight(.medium)).foregroundStyle(Theme.Ink.primary)
                    if let detail { Text(detail).font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary) }
                }
                .frame(minHeight: 24)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(title)
            .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
            .accessibilityHint(isExpanded ? "Hides the details" : "Shows the details")
            .testAnchor(anchor ?? title)
            if isExpanded {
                content().padding(.leading, 12 + Theme.Space.xs)
            }
        }
    }
}

// MARK: - Sheet size

/// The height of the window a sheet is attached to, so a tall sheet can scroll its middle instead of hanging out of
/// its window. nil until the sheet is in a window.
struct SheetParentHeight: NSViewRepresentable {
    @Binding var height: CGFloat?

    func makeNSView(context: Context) -> Probe { Probe { h in if height != h { height = h } } }
    func updateNSView(_ v: Probe, context: Context) {}

    final class Probe: NSView {
        let report: (CGFloat) -> Void
        nonisolated(unsafe) private var token: NSObjectProtocol?
        init(_ report: @escaping (CGFloat) -> Void) { self.report = report; super.init(frame: .zero) }
        required init?(coder: NSCoder) { fatalError() }
        deinit { if let token { NotificationCenter.default.removeObserver(token) } }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let token { NotificationCenter.default.removeObserver(token); self.token = nil }
            guard window != nil else { return }
            // The sheet window gets its parent just after its views move in.
            DispatchQueue.main.async { [weak self] in self?.observeParent() }
        }

        private func observeParent() {
            guard token == nil, let parent = window?.sheetParent else { return }
            report(parent.contentLayoutRect.height)
            token = NotificationCenter.default.addObserver(forName: NSWindow.didResizeNotification, object: parent, queue: .main) { [weak self] n in
                guard let w = n.object as? NSWindow else { return }
                MainActor.assumeIsolated { self?.report(w.contentLayoutRect.height) }
            }
        }
    }
}

// MARK: - Modifier sugar

extension View {
    /// A segmented picker with the system's neutral selected segment, as in the approved mockups. The root
    /// `.tint(Accent.fill)` would otherwise fill the selected segment with indigo, the loudest thing in the chrome.
    func pdSegmented() -> some View { pickerStyle(.segmented).tint(nil) }
    func pdCard(padding: CGFloat = Theme.Space.l) -> some View { modifier(CardModifier(padding: padding)) }
    func pdFloatingBar() -> some View { modifier(FloatingBarModifier()) }
}

// MARK: - Platform glyph

/// The sidebar's platform mark: SF Symbols' iPhone for iOS and the Android robot's head for Android. SF Symbols has
/// no Android mark, and its generic `smartphone` reads as the same phone. (The Android robot is Google's, shared
/// under CC BY 3.0.) Sized like a `.large` body symbol and coloured by the foreground style like one.
struct PlatformGlyph: View {
    let platform: String
    let symbol: String

    var body: some View {
        if platform == "android" {
            AndroidHead().frame(width: 15, height: 15)
        } else {
            Image(systemName: symbol).font(Theme.Fonts.body).imageScale(.large)
        }
    }
}

struct AndroidHead: View {
    var body: some View {
        GeometryReader { g in
            let s = min(g.size.width, g.size.height)
            ZStack {
                Head().fill(style: FillStyle(eoFill: true))
                Antennae().stroke(style: StrokeStyle(lineWidth: max(1, s * 0.085), lineCap: .round))
            }
            .frame(width: s, height: s)
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityHidden(true)
    }

    private struct Head: Shape {
        func path(in r: CGRect) -> Path {
            let s = r.width, radius = s * 0.5
            let base = CGPoint(x: r.midX, y: r.minY + s * 0.80)
            var p = Path()
            p.move(to: CGPoint(x: r.minX, y: base.y))
            p.addArc(center: base, radius: radius, startAngle: .degrees(180), endAngle: .degrees(360), clockwise: false)
            p.closeSubpath()
            let eye = s * 0.085
            for dx in [-0.21, 0.21] {
                let c = CGPoint(x: r.midX + s * dx, y: base.y - radius * 0.46)
                p.addEllipse(in: CGRect(x: c.x - eye, y: c.y - eye, width: eye * 2, height: eye * 2))
            }
            return p
        }
    }

    /// Clear of the head, so a translucent style (`.secondary`) doesn't darken where the two would overlap.
    private struct Antennae: Shape {
        func path(in r: CGRect) -> Path {
            let s = r.width
            let base = CGPoint(x: r.midX, y: r.minY + s * 0.80)
            var p = Path()
            for side in [-1.0, 1.0] {
                let a = Angle.degrees(270 + side * 30).radians
                p.move(to: CGPoint(x: base.x + cos(a) * s * 0.57, y: base.y + sin(a) * s * 0.57))
                p.addLine(to: CGPoint(x: base.x + cos(a) * s * 0.74, y: base.y + sin(a) * s * 0.74))
            }
            return p
        }
    }
}
