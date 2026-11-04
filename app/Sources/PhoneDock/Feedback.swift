import AppKit
import SwiftUI

// Shared feedback layer: agent display names, error copy, toasts and the blocking alert.
// Views never show raw owner strings, commands, codes or HTTP statuses; those live under Details.

// MARK: - Agent display names

enum OwnerName {
    private static let known: [String: String] = [
        "claude-code": "Claude Code", "claude": "Claude", "codex": "Codex", "codex-mcp-client": "Codex",
        "cursor": "Cursor", "cursor-vscode": "Cursor", "windsurf": "Windsurf", "gemini-cli": "Gemini CLI",
        "copilot": "GitHub Copilot", "vscode": "VS Code", "zed": "Zed", "agent": "An agent",
        "anonymous": "An agent", "unknown": "An agent",
    ]

    /// "mcp:claude-code:48213" → "Claude Code", "cli:*" → "Terminal", "sdk:*" → "A script", "app:human" → "You".
    static func display(_ owner: String?) -> String {
        guard let o = owner?.trimmingCharacters(in: .whitespaces), !o.isEmpty else { return "An agent" }
        if o == AppIdentity.owner { return "You" }
        let parts = o.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        switch parts[0] {
        case "mcp": return client(parts.count > 1 ? parts[1] : "")
        case "cli": return "Terminal"
        case "sdk": return "A script"
        case "app": return "PhoneDock"
        default: return client(parts[0])
        }
    }

    private static func client(_ raw: String) -> String {
        let k = raw.lowercased()
        if let n = known[k] { return n }
        if k.contains("codex") { return "Codex" }
        if k.contains("claude") { return "Claude" }
        let words = raw.split(whereSeparator: { "-_. ".contains($0) })
        guard !words.isEmpty else { return "An agent" }
        return words.map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }
}

extension Device {
    /// Who holds the lease, as a person would say it; nil when nobody does.
    var controllerName: String? { lease.map { OwnerName.display($0.owner) } }
}

extension Handoff {
    var requesterName: String { OwnerName.display(requestedBy) }
}

// MARK: - Error copy

extension FriendlyError {
    /// Plain-words error from anything thrown. `title` is what failed ("Couldn’t start Pixel 9"); the body comes
    /// from the daemon's error code or first hint; the raw text goes to `details`.
    static func from(_ error: Error, title: String, device: Device? = nil) -> FriendlyError {
        guard let e = error as? APIError else {
            if let u = error as? URLError, [.cannotConnectToHost, .networkConnectionLost, .timedOut, .notConnectedToInternet].contains(u.code) {
                return FriendlyError(title: "PhoneDock isn’t responding", message: "It reconnects automatically.", details: error.localizedDescription)
            }
            return FriendlyError(title: title, message: "Try again.", details: error.localizedDescription)
        }
        var t = title
        let body: String?
        switch e.code {
        case "lease_conflict":
            t = "\(device?.controllerName ?? "An agent") is using this device"
            body = "Take over to use it yourself."
        case "not_supported", "http_501":
            // The service sometimes says why in plain words ("Physical phones are turned off for this service"):
            // show that and its first plain hint. Its generic "… is not supported by …" stays a plain sentence.
            let m = e.message.trimmingCharacters(in: .whitespacesAndNewlines)
            if !m.isEmpty, m.count <= 140, isHumanHint(m), !m.localizedCaseInsensitiveContains("not supported") {
                body = ([sentence(m)] + [e.hints.first(where: isHumanHint).map(sentence)].compactMap { $0 }).joined(separator: " ")
            } else {
                body = "This device doesn’t support it."
            }
        case "timeout", "device_timeout":
            body = "It may still finish. Try again in a moment."
        case "boot_failed":
            body = "Try a cold boot from the Power menu."
        case "no_image":
            body = "Download a system version in New Device."
        case "needs_human":
            body = "Only you can do this on the device."
        default:
            body = e.hints.first(where: isHumanHint) ?? generic
        }
        return FriendlyError(title: t, message: body, details: e.rawDetails)
    }

    /// A failed job (create, boot, clone, download). The service writes job errors for people ("iOS 27.0 isn’t ready
    /// to use on this Mac" + how to fix it), so the body leads with that message and its first plain-words hint; the
    /// raw error and the job's last progress line go to Details.
    static func from(job: Job, title: String, device: Device? = nil, fallback: String = generic) -> FriendlyError {
        let lastLine = job.lastLine.map { "\nLast step: " + $0 } ?? ""
        guard let e = job.apiError else {
            return FriendlyError(title: title, message: fallback, details: (job.errorText ?? "The job failed.") + lastLine)
        }
        var f = from(e, title: title, device: device)
        let message = e.message.trimmingCharacters(in: .whitespacesAndNewlines)
        if !message.isEmpty, message.count <= 140, isHumanHint(message) {
            let hint = e.hints.first(where: isHumanHint)
            f.message = [sentence(message), hint.map(sentence)].compactMap { $0 }.joined(separator: " ")
        } else if f.message == generic {
            f.message = fallback
        }
        f.details = e.rawDetails + lastLine
        return f
    }

    static let generic = "Try again. If it keeps happening, copy the details and report it."

    /// Ends with a full stop unless it already ends with punctuation.
    private static func sentence(_ s: String) -> String {
        guard let last = s.last else { return s }
        return ".!?…".contains(last) ? s : s + "."
    }

    /// Hints written for agents (API paths, commands, flags, env vars) stay under Details.
    private static let technical = ["/v1/", "`", " --", "$", "phonedock ", "adb ", "xcrun", "simctl", "devicectl", "PHONEDOCK_", "http://", "127.0.0.1"]
    static func isHumanHint(_ hint: String) -> Bool { !technical.contains { hint.contains($0) } }
}

extension APIError {
    /// Everything a bug report needs, never shown by default.
    var rawDetails: String {
        var lines = [message]
        lines += hints.map { "• " + $0 }
        if let detail, !detail.isEmpty { lines.append(detail) }
        lines.append("code \(code)" + (status > 0 ? " · HTTP \(status)" : ""))
        return lines.joined(separator: "\n")
    }
}

// MARK: - Toasts

/// A one-off message at the bottom of the window. Disappears on its own; never blocks.
struct Toast: Identifiable, Equatable {
    enum Kind { case error, success, info }
    let id = UUID()
    var kind: Kind = .error
    var title: String
    var message: String? = nil
    var details: String? = nil
    var actionTitle: String? = nil
    var action: (@MainActor () -> Void)? = nil
    /// Seconds on screen; default 4, or 8 when there is an action.
    var duration: Double? = nil
    /// "Claude Code is using this device": goes away by itself once that device's control changes (you take it, or it's free).
    var clearsOnControlChange: String? = nil

    static func == (a: Toast, b: Toast) -> Bool { a.id == b.id }

    var symbol: String {
        switch kind {
        case .error: return "exclamationmark.triangle.fill"
        case .success: return "checkmark.circle.fill"
        case .info: return "info.circle.fill"
        }
    }
    var tint: Color {
        switch kind {
        case .error: return Theme.Status.error
        case .success: return Theme.Status.running
        case .info: return Theme.Accent.text
        }
    }
}

/// How far above the bottom of the detail column toasts sit. The device stage reports where its hardware bar is
/// (`DeviceDetailView`), so a toast always clears the controls; nil when there's no bar.
struct ToastLiftKey: PreferenceKey {
    static let defaultValue: CGFloat? = nil
    static func reduce(value: inout CGFloat?, nextValue: () -> CGFloat?) { value = nextValue() ?? value }
}

struct ToastHost: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var copied = false
    /// Distance from the bottom of the host to the toast's bottom edge.
    var bottomInset: CGFloat = Theme.Space.xxl

    var body: some View {
        ZStack {
            if let t = model.toast {
                HStack(spacing: Theme.Space.m) {
                    Image(systemName: t.symbol).foregroundStyle(t.tint).accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(t.title).font(Theme.Fonts.headline).foregroundStyle(Theme.Ink.primary).lineLimit(2)
                        // The message is often the remedy: up to three lines in a narrow window, never cut at two.
                        if let m = t.message {
                            Text(m).font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                                .lineLimit(3)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    if let title = t.actionTitle, let action = t.action {
                        Button(title) { model.toast = nil; action() }.testAnchor(title)
                    }
                    if let d = t.details {
                        Button {
                            Clipboard.copy(d)
                            copied = true
                        } label: {
                            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                                .frame(width: 24, height: 24).contentShape(Rectangle())   // a comfortable hit target
                        }
                        .buttonStyle(.borderless)
                        .help("Copy Details")
                        .accessibilityLabel("Copy Details")
                    }
                    Button { model.toast = nil } label: {
                        Image(systemName: "xmark").font(Theme.Fonts.callout.weight(.semibold))
                            .frame(width: 24, height: 24).contentShape(Rectangle())
                    }
                        .buttonStyle(.borderless)
                        .foregroundStyle(Theme.Ink.secondary)
                        .help("Dismiss")
                        .accessibilityLabel("Dismiss")
                }
                .padding(.horizontal, Theme.Space.m + Theme.Space.xs)
                .padding(.vertical, Theme.Space.m)
                // Opaque, not glass: above the hardware bar the toast can overlap the bottom of a live screen, and
                // glass over changing pixels is hard to read (the same rule as banners and status pills).
                .background(Theme.Surface.card, in: Capsule())
                .overlay(Capsule().strokeBorder(Theme.Line.card, lineWidth: 1))
                .shadow(color: Theme.Elevation.float, radius: 12, x: 0, y: 4)
                .frame(maxWidth: 520)
                .padding(.horizontal, Theme.Space.xl)
                .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
                .id(t.id)
                .task(id: t.id) {
                    copied = false
                    try? await Task.sleep(for: .seconds(t.duration ?? (t.action == nil ? 4 : 8)))
                    if model.toast?.id == t.id { model.toast = nil }
                }
                .accessibilityElement(children: .contain)
            }
        }
        .animation(Theme.Motion.decorative(Theme.Motion.standard, reduceMotion: reduceMotion), value: model.toast)
        .padding(.bottom, bottomInset)
    }
}

// MARK: - Blocking alert

extension View {
    /// The one alert: only for a blocking action the user started (create, delete, connect, restart).
    func pdProblemAlert(_ model: AppModel) -> some View {
        alert(model.problem?.title ?? "", isPresented: Binding(get: { model.problem != nil }, set: { if !$0 { model.problem = nil } }),
              presenting: model.problem) { p in
            // OK is the default (Return, rightmost); with a cancel role macOS would make Copy Details the default.
            Button("OK") { model.problem = nil }
            if let d = p.details {
                Button("Copy Details") {
                    Clipboard.copy(d)
                    model.problem = nil
                }
            }
        } message: { p in Text(p.message ?? "") }
    }
}
