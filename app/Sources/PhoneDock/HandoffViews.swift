import SwiftUI
import AppKit
import UserNotifications

// MARK: - Time helpers (shared by the stage bar, recording timer, inspector and crashes)

enum PDTime {
    /// "4:32", or "1:04:32" past an hour. Rounds up so a countdown never shows 0:00 while time remains.
    static func clock(_ t: TimeInterval, roundUp: Bool = false) -> String {
        let s = max(0, Int(roundUp ? t.rounded(.up) : t.rounded(.down)))
        return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60) : String(format: "%d:%02d", s / 60, s % 60)
    }

    /// "just now", "2 min ago", "3 hr ago", "2 days ago". No formatter allocation.
    static func ago(_ date: Date, now: Date = Date()) -> String {
        let s = max(0, Int(now.timeIntervalSince(date)))
        if s < 60 { return "just now" }
        if s < 3600 { return "\(s / 60) min ago" }
        if s < 86_400 { return "\(s / 3600) hr ago" }
        let d = s / 86_400
        return d == 1 ? "yesterday" : "\(d) days ago"
    }

    private static let timeOnly: DateFormatter = {
        let f = DateFormatter(); f.dateStyle = .none; f.timeStyle = .short; return f
    }()
    private static let dayAndTime: DateFormatter = {
        let f = DateFormatter(); f.dateStyle = .medium; f.timeStyle = .short; f.doesRelativeDateFormatting = true; return f
    }()

    /// "14:02" (locale-aware short time).
    static func time(_ date: Date) -> String { timeOnly.string(from: date) }
    /// "Today 14:02", "Yesterday 09:10", "3 Nov 2026 14:02".
    static func dayTime(_ date: Date) -> String { dayAndTime.string(from: date).replacingOccurrences(of: " at ", with: " ") }
}

// MARK: - Stage top bar

/// Remembers, per device, which agent you took over from, so Hand Back can say who continues ("Let Claude Code
/// continue"). Kept across launches: the daemon keeps your lease when the app quits.
@MainActor
@Observable
final class TakeoverMemory {
    static let shared = TakeoverMemory()
    private static let key = "takeover.from"
    /// deviceId → display name of the agent you took over from.
    private(set) var from: [String: String] = UserDefaults.standard.dictionary(forKey: key) as? [String: String] ?? [:]

    func remember(_ deviceId: String, agent: String?) {
        guard from[deviceId] != agent else { return }
        from[deviceId] = agent
        UserDefaults.standard.set(from, forKey: Self.key)
    }
}

/// The one floating bar at the top of the device stage: who's in control, or "needs you" during a handoff.
/// It sits in the reserved top slot (`Theme.Stage.topSlot(stageWidth:)`), so it never covers or moves the device screen.
/// Contract: DeviceDetailView places it; HandoffViews.swift owns its look and behavior.
///
/// Every state comes from the daemon (device lease, pending handoffs, a fetched final handoff state). Buttons only
/// send requests; the bar changes after the following refresh confirms it.
struct StageTopBar: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let device: Device
    /// The stage is narrow and its top slot is reserved taller: the handoff card stacks instead of truncating.
    var stacked = false

    /// The pending handoff the bar last showed; used to explain why it went away.
    @State private var shown: Handoff?
    /// Handoffs this person answered here (Done / Can't Do It); their disappearance is expected.
    @State private var answered: Set<String> = []
    /// A handoff that ended without an answer from here (timed out, cancelled by the agent, answered elsewhere).
    @State private var ended: Handoff?
    /// A lease request (Take Over / Hand Back) is in flight; cleared when the lease changes or after a few seconds.
    @State private var leaseRequest: String?

    private var pending: Handoff? { model.pendingHandoff(for: device.id) }
    private var memory: TakeoverMemory { TakeoverMemory.shared }

    private enum Mode: Equatable { case empty, agent, you, handoff(String), ended(String) }

    private var mode: Mode {
        if let h = pending { return .handoff(h.id) }
        if let e = ended { return .ended(e.id) }
        // A phone that's off has nobody "in control" of it: no pill.
        if !device.isRunning { return .empty }
        if device.leasedByAgent { return .agent }
        // Whenever you hold the device, Hand Back is on screen: the app only takes a device from an agent (or for a
        // handoff), and a lease kept from an earlier launch must not be invisible.
        if device.leasedByHuman { return .you }
        return .empty
    }

    /// The oldest help request on another device in the sidebar. It shows as one line above this device's capsule,
    /// inside the reserved slot, so the screen never moves for it. (This device's own card takes the whole slot.)
    private var elsewhere: (handoff: Handoff, device: Device, more: Int)? {
        let listed = Dictionary(model.devices.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let list = model.handoffs.values
            .filter { $0.isPending && $0.deviceId != device.id && listed[$0.deviceId] != nil }
            .sorted { ($0.createdAt ?? "") < ($1.createdAt ?? "") }
        guard let h = list.first, let d = listed[h.deviceId] else { return nil }
        return (h, d, list.count - 1)
    }

    /// A Take Over or Hand Back is on its way, from here or from the Device menu or the sidebar.
    private var takingOver: Bool { leaseRequest == "take" || model.pending[device.id] == "Taking over…" }
    private var handingBack: Bool { leaseRequest == "back" || model.pending[device.id] == "Handing back…" }

    var body: some View {
        VStack(spacing: Theme.Space.xs) {
            if [.empty, .agent, .you].contains(mode), let e = elsewhere {
                ElsewhereRequestPill(handoff: e.handoff, device: e.device, more: e.more)
                    .transition(.opacity)
            }
            switch mode {
            case .empty:
                EmptyView()
            case .agent:
                agentCapsule.transition(.opacity)
            case .you:
                youCapsule.transition(.opacity)
            case .handoff:
                if let h = pending {
                    HandoffCard(device: device, handoff: h, stacked: stacked, onAnswer: { answered.insert($0) },
                                onTakeOver: { takeOver() }, takingOver: takingOver)
                        .id(h.id)
                        .transition(.opacity)
                }
            case .ended:
                if let e = ended { endedCard(e).transition(.opacity) }
            }
        }
        .padding(.horizontal, Theme.Space.xl)
        // Bars sit a fixed gap above the device, whatever their height and the slot's.
        .padding(.bottom, Theme.Space.m)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: mode)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: elsewhere?.handoff.id)
        .onChange(of: pending?.id, initial: true) { _, newId in handoffChanged(newId) }
        .onChange(of: device.lease?.owner, initial: true) { old, new in leaseChanged(old, new) }
    }

    // MARK: Lease capsules

    private var agentCapsule: some View {
        let name = device.controllerName ?? "An agent"
        return HStack(spacing: Theme.Space.m) {
            Image(systemName: "sparkles")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.Status.agent)
                .accessibilityHidden(true)
            Text("\(name) is in control")
                .font(Theme.Fonts.body.weight(.medium))
                .foregroundStyle(Theme.Ink.primary)
                .lineLimit(1)
                .testAnchor("Controlled by agent")
            Button { takeOver() } label: {
                HStack(spacing: Theme.Space.xs) {
                    if takingOver { ProgressView().controlSize(.mini).environment(\.colorScheme, .dark) }
                    Text(takingOver ? "Taking Over…" : "Take Over")
                }
                .padding(.horizontal, Theme.Space.xxs)
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.capsule)
            .tint(Theme.Status.agentStrong)
            .controlSize(.large)   // the time-sensitive action: a full 24 pt target, not a 16 pt chip
            .fixedSize()
            .disabled(leaseRequest != nil || takingOver)
            .help("Take control of \(device.name) from \(name)")
            .testAnchor("Take Over")
        }
        .padding(.leading, Theme.Space.s)
        .padding(.vertical, Theme.Space.xxs)
        .pdFloatingBar()
        .help(sinceText.map { "Since \($0)" } ?? "")
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(name) is in control")
    }

    private var youCapsule: some View {
        let from = memory.from[device.id]
        return HStack(spacing: Theme.Space.m) {
            Image(systemName: "person.fill")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.Status.human)
                .accessibilityHidden(true)
            Text("You’re in control")
                .font(Theme.Fonts.body.weight(.medium))
                .foregroundStyle(Theme.Ink.primary)
                .lineLimit(1)
                .testAnchor("You have control")
            Button { handBack() } label: {
                HStack(spacing: Theme.Space.xs) {
                    if handingBack { ProgressView().controlSize(.mini) } else { Image(systemName: "arrow.uturn.backward") }
                    Text(handingBack ? "Handing Back…" : "Hand Back")
                }
                .padding(.horizontal, Theme.Space.xxs)
            }
            .buttonBorderShape(.capsule)
            .controlSize(.large)
            .fixedSize()
            .disabled(leaseRequest != nil || handingBack)
            .help(from.map { "Let \($0) continue" } ?? "Release control")
            .testAnchor("Hand Back")
        }
        .padding(.leading, Theme.Space.s)
        .padding(.vertical, Theme.Space.xxs)
        .pdFloatingBar()
        .help(sinceText.map { "Since \($0)" } ?? "")
        .accessibilityElement(children: .contain)
    }

    private var sinceText: String? {
        device.lease?.acquiredAt.flatMap(ISO8601DateFormatter.flexible).map(PDTime.time)
    }

    // MARK: Ended

    private func endedCard(_ h: Handoff) -> some View {
        HStack(spacing: Theme.Space.m) {
            Image(systemName: "hand.raised.slash")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.Ink.secondary)
                .frame(width: 28, height: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text("This request has ended")
                    .font(Theme.Fonts.headline)
                    .foregroundStyle(Theme.Ink.primary)
                Text(endedReason(h))
                    .font(Theme.Fonts.callout)
                    .foregroundStyle(Theme.Ink.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .help(h.reason)
            }
            .frame(minWidth: 80, alignment: .leading)
            Spacer(minLength: Theme.Space.m)
            Button("Dismiss") { ended = nil }
                .testAnchor("Dismiss Handoff")
        }
        .padding(.horizontal, Theme.Space.l)
        .padding(.vertical, Theme.Space.s)
        .frame(maxWidth: 560)
        .background(Theme.Surface.card, in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous).strokeBorder(Theme.Line.card, lineWidth: 1))
        .shadow(color: Theme.Elevation.card, radius: 2, x: 0, y: 1)
        .accessibilityElement(children: .contain)
        .testAnchor("Handoff ended")
    }

    private func endedReason(_ h: Handoff) -> String {
        switch h.state {
        case "timeout": return "Nobody answered in time."
        case "cancelled" where h.resolvedBy == h.requestedBy: return "\(h.requesterName) no longer needs it."
        case "cancelled": return "Answered elsewhere: Can’t Do It."
        case "done": return "Answered elsewhere: Done."
        default: return "\(h.requesterName) no longer needs it."
        }
    }

    // MARK: State changes (all driven by the daemon)

    private func handoffChanged(_ newId: String?) {
        if let newId, let h = pending, h.id == newId {
            shown = h
            ended = nil
            return
        }
        // The handoff we showed is gone from the daemon's pending list. If someone answered it here, that's expected;
        // otherwise ask the daemon what happened before saying anything.
        guard let gone = shown else { return }
        shown = nil
        if answered.contains(gone.id) || model.answeredHere.contains(gone.id) { return }   // card, menu or notification
        guard let c = model.client else { return }
        Task {
            let final = try? await c.get(Handoff.self, "/v1/handoffs/\(DaemonClient.enc(gone.id))", timeout: 10)
            if let final, final.isPending { return }   // still pending: the list will bring it back
            guard pending == nil else { return }
            var h = final ?? gone
            if final == nil { h.state = "ended" }       // the daemon forgot it (restart): it has ended either way
            ended = h
        }
    }

    private func leaseChanged(_ old: String?, _ new: String?) {
        leaseRequest = nil
        if new == AppIdentity.owner {
            if let old, old != AppIdentity.owner { memory.remember(device.id, agent: OwnerName.display(old)) }
        } else {
            memory.remember(device.id, agent: nil)   // someone else holds it, or nobody does (a no-op if already clear)
        }
    }

    private func takeOver() {
        if let name = device.controllerName, device.leasedByAgent { memory.remember(device.id, agent: name) }
        leaseRequest = "take"
        model.takeOver(device)
        clearRequestLater()
    }

    private func handBack() {
        leaseRequest = "back"
        model.handBack(device)
        clearRequestLater()
    }

    /// The refresh after the request normally clears it; this only re-enables the buttons if nothing changed.
    private func clearRequestLater() {
        Task {
            try? await Task.sleep(for: .seconds(6))
            leaseRequest = nil
        }
    }
}

// MARK: - Handoff card

/// Who needs you and why, how long ago, time left, and the three answers. One row on a wide stage; on a narrow one
/// (`stacked`) the answers move to their own row so the reason and every button label stay readable.
private struct HandoffCard: View {
    @Environment(AppModel.self) private var model
    let device: Device
    let handoff: Handoff
    var stacked = false
    let onAnswer: (String) -> Void
    let onTakeOver: () -> Void
    let takingOver: Bool

    @State private var note = ""
    @State private var showNote = false
    @State private var busy = false
    @State private var showReason = false
    @State private var reason = ""

    private var name: String { handoff.requesterName }

    var body: some View {
        // Widest layout that fits: full labels, then shorter ones (every answer keeps its words), then, only on a
        // stage far narrower than the minimum window gives it, icons.
        Group {
            if stacked {
                ViewThatFits(in: .horizontal) {
                    stackedRows(.medium)
                    stackedRows(.compact)
                }
            } else {
                ViewThatFits(in: .horizontal) {
                    row(.full)
                    row(.medium)
                    row(.compact)
                }
            }
        }
        .padding(.horizontal, Theme.Space.m)
        .padding(.vertical, Theme.Space.s)
        .frame(maxWidth: 880)
        .background(Theme.Status.handoffTint, in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous).strokeBorder(Theme.Line.card, lineWidth: 1))
        .shadow(color: Theme.Elevation.card, radius: 2, x: 0, y: 1)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(name) needs you: \(handoff.reason)")
        .testAnchor("Agent needs you")
    }

    private enum Density { case full, medium, compact }

    private func row(_ density: Density) -> some View {
        HStack(spacing: Theme.Space.m) {
            tile
            // Who and when on top (eyebrow), the reason on its own line so it gets the full width.
            VStack(alignment: .leading, spacing: 1) {
                eyebrow
                reason(lines: 2)
            }
            // The ideal width is what ViewThatFits measures: the reason keeps at least this much room (it truncates
            // past it, with the full text in the tooltip). The stage is stacked well before it would get less.
            .frame(minWidth: 90, idealWidth: density == .full ? 240 : density == .medium ? 170 : 120,
                   maxWidth: .infinity, alignment: .leading)
            countdown.fixedSize()
            buttons(density).fixedSize()
        }
    }

    /// Two rows: tile, who/why and time left; then the answers, trailing. The reason may wrap to a second line.
    private func stackedRows(_ density: Density) -> some View {
        VStack(alignment: .trailing, spacing: Theme.Space.s) {
            HStack(alignment: .top, spacing: Theme.Space.m) {
                tile
                VStack(alignment: .leading, spacing: 1) {
                    eyebrow
                    reason(lines: 2)
                }
                .frame(minWidth: 90, idealWidth: 120, maxWidth: .infinity, alignment: .leading)
                countdown.fixedSize()
            }
            buttons(density).fixedSize()
        }
    }

    private var tile: some View {
        Image(systemName: "hand.raised.fill")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(Theme.Ink.onFill)
            .frame(width: 28, height: 28)
            .background(Theme.Status.handoffStrong, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .accessibilityHidden(true)
    }

    /// "Claude Code needs you · Asked 2 min ago"; drops the time rather than cut the name.
    private var eyebrow: some View {
        TimelineView(.periodic(from: .now, by: 30)) { ctx in
            let who = Text("\(name) needs you").font(Theme.Fonts.callout.weight(.semibold)).foregroundStyle(Theme.Status.handoffText)
            ViewThatFits(in: .horizontal) {
                (who + Text(" · " + meta(now: ctx.date)).font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary))
                    .lineLimit(1)
                who.lineLimit(1)
            }
        }
    }

    private func reason(lines: Int) -> some View {
        Text(handoff.reason)
            .font(Theme.Fonts.headline)
            .foregroundStyle(Theme.Ink.primary)
            .lineLimit(lines)
            .truncationMode(.tail)
            .fixedSize(horizontal: false, vertical: true)
            .help(handoff.reason)
    }

    private func meta(now: Date) -> String {
        // Once you hold the device that's the news; until then, how long the agent has been waiting.
        if device.leasedByHuman { return "You’re in control" }
        if let c = handoff.createdDate { return "Asked \(PDTime.ago(c, now: now))" }
        return device.name
    }

    /// "14:25 left" in every layout: a bare clock reads as the time of day.
    @ViewBuilder private var countdown: some View {
        if let exp = handoff.expiresDate {
            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                let left = max(0, exp.timeIntervalSince(ctx.date))
                HStack(alignment: .firstTextBaseline, spacing: 3) {
                    Text(PDTime.clock(left, roundUp: true))
                        .font(Theme.Fonts.callout.monospacedDigit().weight(.medium))
                        .foregroundStyle(left <= 0 ? Theme.Status.errorText : left < 60 ? Theme.Status.handoffText : Theme.Ink.primary)
                    Text("left").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(left > 0 ? "\(PDTime.clock(left, roundUp: true)) left" : "No time left")
            }
        }
    }

    @ViewBuilder private func buttons(_ density: Density) -> some View {
        // One prominent action: Take Over while you don't hold the device, Done once you do. The other answers are quiet.
        HStack(spacing: Theme.Space.s) {
            Button { showNote.toggle() } label: {
                let icon = Image(systemName: note.isEmpty ? "square.and.pencil" : "text.bubble.fill")
                    .foregroundStyle(note.isEmpty ? Theme.Ink.secondary : Theme.Status.handoffText)
                if density == .compact {
                    icon.frame(width: 24, height: 24).contentShape(Rectangle())
                } else {
                    HStack(spacing: Theme.Space.xs) {
                        icon
                        Text(note.isEmpty ? "Note" : "Edit Note").foregroundStyle(Theme.Ink.secondary)
                    }
                    .frame(height: 24).contentShape(Rectangle())
                }
            }
            .buttonStyle(.borderless)
            .help(note.isEmpty ? "Add a note for \(name)" : "Edit your note for \(name)")
            .accessibilityLabel(note.isEmpty ? "Add Note" : "Edit Note")
            .popover(isPresented: $showNote, arrowEdge: .bottom) { notePopover }
            .testAnchor("Add Note")
            Button { showReason.toggle() } label: { Text("Can’t Do It") }
                .help("Tell \(name) you can’t do this")
                .accessibilityLabel("Can’t Do It")
                .popover(isPresented: $showReason, arrowEdge: .bottom) { reasonPopover }
                .testAnchor("Can't Do It")
            if !device.leasedByHuman {
                Button(action: onTakeOver) {
                    HStack(spacing: Theme.Space.xs) {
                        if takingOver { ProgressView().controlSize(.mini).environment(\.colorScheme, .dark) }
                        switch density {
                        case .full: Label(takingOver ? "Taking Over…" : "Take Over", systemImage: "hand.point.up.left.fill")
                        case .medium: Text(takingOver ? "Taking Over…" : "Take Over")
                        case .compact: Image(systemName: "hand.point.up.left.fill")
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.Status.agentStrong)
                .disabled(takingOver || busy)
                .help("Take control of the screen so you can do it")
                .accessibilityLabel("Take Over")
                .testAnchor("Take Over")
                Button { resolve(done: true, reason: nil) } label: { Text("Done") }
                    .help("Tell \(name) it’s done and hand control back")
                    .testAnchor("Done")
            } else {
                Button { resolve(done: true, reason: nil) } label: { Label("Done", systemImage: "checkmark") }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.Status.handoffStrong)
                    .help("Tell \(name) it’s done and hand control back")
                    .testAnchor("Done")
            }
        }
        .controlSize(.large)   // the answers are time-sensitive: full-size targets
        .disabled(busy)
    }

    /// Can't Do It asks for an optional reason before it sends.
    private var reasonPopover: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            Text("Why can’t you?").font(Theme.Fonts.headline)
            TextField("Optional", text: $reason, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(2...4)
                .frame(width: 280)
                .accessibilityLabel("Reason")
                .testAnchor("Cant Do It reason")
                .onSubmit { sendCantDo() }
            HStack {
                Text("\(name) sees this.").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                Spacer()
                Button("Cancel") { showReason = false }
                Button("Send") { sendCantDo() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .testAnchor("Send Cant Do It")
            }
        }
        .padding(Theme.Space.l)
    }

    private func sendCantDo() {
        showReason = false
        resolve(done: false, reason: reason)
    }

    private var notePopover: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            Text("Note for \(name)").font(Theme.Fonts.headline)
            TextField("Optional", text: $note, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(2...4)
                .frame(width: 280)
                .accessibilityLabel("Handoff note")
                .testAnchor("Handoff note")
            Text("Sent with Done or Can’t Do It.")
                .font(Theme.Fonts.callout)
                .foregroundStyle(Theme.Ink.secondary)
        }
        .padding(Theme.Space.l)
    }

    private func resolve(done: Bool, reason why: String?) {
        busy = true
        showNote = false
        onAnswer(handoff.id)
        // A reason for Can't Do It travels as the note, ahead of any note you wrote.
        let n = [why, note].compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.joined(separator: "\n")
        Task {
            await model.resolveHandoff(handoff, done: done, note: n)
            busy = false
        }
    }
}

// MARK: - Notifications

/// Tells the person an agent needs them when they may not be looking: a notification "Claude Code needs you on
/// Pixel 9" with the reason, and buttons to Take Over or answer Done / Can't Do It without switching apps. Clicking
/// it selects the device. Falls back to a Dock bounce when notifications are off or the app isn't a bundle. Also
/// keeps the Dock badge: the number of waiting requests on devices in the sidebar.
///
/// Permission is asked for at moments that explain themselves, never at launch: when someone copies the Connect an
/// Agent command, turns the setting on, or the first time an agent actually asks for help.
@MainActor
final class HandoffNotifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = HandoffNotifier()
    var onOpen: ((String) -> Void)?
    /// A notification button was pressed: (action, deviceId, handoffId).
    var onAction: ((Action, String, String) -> Void)?
    /// True when the person can already see this device's request card (app active, device selected): no banner.
    var isShowing: ((String) -> Bool)?
    private var authorized: Bool?
    private var configured = false
    /// What was last posted, for the self-test log.
    private(set) var lastPosted: String?

    enum Action: String { case takeOver = "TAKE_OVER", done = "DONE", cantDo = "CANT_DO" }
    static let category = "HANDOFF"

    /// UNUserNotificationCenter needs a real app bundle; calling it from a bare `swift build` binary crashes.
    /// Background self-tests post none (no permission prompt, no banners on the person's screen) unless
    /// PHONEDOCK_APP_SELFTEST_NOTIFY=1.
    private var center: UNUserNotificationCenter? {
        guard DaemonLocator.isBundled, Bundle.main.bundleIdentifier != nil else { return nil }
        if SelfTest.background, ProcessInfo.processInfo.environment["PHONEDOCK_APP_SELFTEST_NOTIFY"] != "1" { return nil }
        return UNUserNotificationCenter.current()
    }

    private var enabled: Bool { UserDefaults.standard.object(forKey: Prefs.notifyOnHandoff) as? Bool ?? true }

    private func configure(_ c: UNUserNotificationCenter) {
        guard !configured else { return }
        configured = true
        c.delegate = self
        let take = UNNotificationAction(identifier: Action.takeOver.rawValue, title: "Take Over", options: [.foreground])
        let done = UNNotificationAction(identifier: Action.done.rawValue, title: "Done", options: [])
        let cant = UNNotificationAction(identifier: Action.cantDo.rawValue, title: "Can’t Do It", options: [])
        c.setNotificationCategories([UNNotificationCategory(identifier: Self.category, actions: [take, done, cant],
                                                            intentIdentifiers: [], options: [])])
    }

    /// Asks for permission if it was never asked (macOS shows its prompt once). Call it when the reason is obvious
    /// to the person; never at launch.
    func requestPermissionIfNeeded() {
        guard enabled, let c = center else { return }
        configure(c)
        Task { _ = await permission(c) }
    }

    /// True when notifications may be shown; asks first if they never were.
    private func permission(_ c: UNUserNotificationCenter) async -> Bool {
        if let authorized { return authorized }
        let ok: Bool
        switch await c.notificationSettings().authorizationStatus {
        case .authorized, .provisional, .ephemeral: ok = true
        case .denied: ok = false
        default: ok = (try? await c.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        }
        authorized = ok
        return ok
    }

    func notify(_ h: Handoff, deviceName: String) {
        // Settings › General › "Notify me when an agent needs help" (default on). The Dock badge always updates.
        guard enabled else { return }
        guard let c = center else { bounce(); return }
        configure(c)
        let title = "\(h.requesterName) needs you on \(deviceName)"
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = h.reason
        content.sound = .default
        content.categoryIdentifier = Self.category
        content.threadIdentifier = h.deviceId
        content.interruptionLevel = .timeSensitive
        content.userInfo = ["deviceId": h.deviceId, "handoffId": h.id]
        let req = UNNotificationRequest(identifier: "handoff-\(h.id)", content: content, trigger: nil)
        // Never asked before: an agent asking for help is the moment that explains the prompt.
        Task {
            guard await permission(c) else { bounce(); return }
            do {
                try await c.add(req)
                lastPosted = "\"\(title)\" body \"\(h.reason)\" actions [Take Over, Done, Can’t Do It]"
            } catch {
                bounce()
            }
        }
    }

    /// macOS has notifications for PhoneDock turned off (System Settings › Notifications). False when never asked.
    func isDenied() async -> Bool {
        guard let c = center else { return false }
        return await c.notificationSettings().authorizationStatus == .denied
    }

    static func openNotificationSettings() {
        if SelfTest.blocksForeground("open System Settings › Notifications") { return }
        let id = Bundle.main.bundleIdentifier ?? ""
        if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(id)") {
            NSWorkspace.shared.open(url)
        }
    }

    /// Self-test evidence: permission, categories and the last notification posted.
    func describe(_ done: @escaping @MainActor (String) -> Void) {
        let last = "last=" + (lastPosted ?? "none")
        guard let c = center else { done("not bundled: Dock bounce only; \(last)"); return }
        configure(c)
        Task {
            let status = await c.notificationSettings().authorizationStatus.rawValue
            let cats = await c.notificationCategories()
            let text = cats.map { "\($0.identifier)[\($0.actions.map(\.title).joined(separator: ", "))]" }.joined(separator: " ")
            done("authorization=\(status) categories=\(text) \(last)")
        }
    }

    func withdraw(_ handoffId: String) {
        center?.removeDeliveredNotifications(withIdentifiers: ["handoff-\(handoffId)"])
    }

    func setBadge(_ n: Int) {
        let label = n > 0 ? String(n) : nil
        if NSApp.dockTile.badgeLabel != label { NSApp.dockTile.badgeLabel = label }
    }

    private func bounce() {
        guard !NSApp.isActive, !SelfTest.blocksForeground("bounce the Dock icon") else { return }
        NSApp.requestUserAttention(.criticalRequest)
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let id = notification.request.content.userInfo["deviceId"] as? String
        Task { @MainActor in
            // The request card is already on screen: keep it in Notification Center, without a banner or sound.
            let showing = id.flatMap { HandoffNotifier.shared.isShowing?($0) } ?? false
            completionHandler(showing ? [.list] : [.banner, .list, .sound])
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let id = info["deviceId"] as? String
        let handoffId = info["handoffId"] as? String
        let action = response.actionIdentifier
        Task { @MainActor in
            let n = HandoffNotifier.shared
            if let id {
                if let a = Action(rawValue: action), let handoffId {
                    if a == .takeOver { n.onOpen?(id) }
                    n.onAction?(a, id, handoffId)
                } else {
                    n.onOpen?(id)   // the notification itself: show that device
                }
            }
            completionHandler()
        }
    }
}

// MARK: - Sidebar badges

/// The sidebar row's trailing badge (§8.2), shown before the StatusDot. Show at most one, in priority order:
/// `.handoff` › `.agent` › `.recording`. Stays legible on a selected (accent-coloured) row.
struct RowBadge: View {
    enum Kind: Equatable { case handoff, agent, recording }
    let kind: Kind
    var selected = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.backgroundProminence) private var prominence

    init(_ kind: Kind, selected: Bool = false) {
        self.kind = kind
        self.selected = selected
    }

    /// Legacy call shape (pre-redesign sidebar). Maps to a `Kind`; colours come from Theme, not the arguments.
    init(text: String?, symbol: String? = nil, color: Color, onWhite: Color, selected: Bool, filled: Bool = false, pulse: Bool = false) {
        self.kind = symbol == "hand.raised.fill" ? .handoff : (symbol == "record.circle" || text == "rec") ? .recording : .agent
        self.selected = selected
    }

    private var onAccent: Bool { selected || prominence == .increased }

    var body: some View {
        Group {
            switch kind {
            case .handoff:
                Image(systemName: "hand.raised.fill")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(Theme.Ink.onFill)
                    .symbolEffect(.pulse, options: .repeating, isActive: !reduceMotion)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Theme.Status.handoffStrong, in: Capsule())
                    .overlay { if onAccent { Capsule().strokeBorder(Color.white, lineWidth: 1).padding(-1) } }
                    .help("Needs you")
                    .accessibilityLabel("Needs you")
            case .agent:
                Image(systemName: "sparkles")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(onAccent ? Color.white : Theme.Status.agent)
                    .help("An agent is in control")
                    .accessibilityLabel("Agent in control")
            case .recording:
                Circle()
                    .fill(Theme.Status.recording)
                    .frame(width: 6, height: 6)
                    .overlay { if onAccent { Circle().strokeBorder(Color.white, lineWidth: 1).padding(-1) } }
                    .help("Recording")
                    .accessibilityLabel("Recording")
            }
        }
        .accessibilityElement(children: .ignore)
    }
}

// MARK: - Help request banner (any device)

/// A help request on a device you aren't looking at must not hide in the sidebar: this banner sits at the top of the
/// detail area on every other device, names the phone and the agent, and Show takes you there. (The Dock icon carries
/// the count too.)
/// "✋ Claude Code needs you on Pixel 9 · Show ›": a help request on another device, as one line in the stage's top
/// slot. The whole pill is the Show button; the reason is in its tooltip and the other device's card.
struct ElsewhereRequestPill: View {
    @Environment(AppModel.self) private var model
    let handoff: Handoff
    let device: Device
    var more = 0

    var body: some View {
        Button { model.selection = device.id } label: {
            HStack(spacing: Theme.Space.s) {
                Image(systemName: "hand.raised.fill")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.Status.handoffText)
                    .accessibilityHidden(true)
                // The whole sentence when it fits; in a narrow stage the device name goes (the tooltip keeps it)
                // rather than a cut through the middle of the sentence.
                ViewThatFits(in: .horizontal) {
                    Text("\(handoff.requesterName) needs you on \(DisplayText.unbroken(device.name))" + (more > 0 ? " and \(more) more" : ""))
                        .fixedSize()
                    Text("\(handoff.requesterName) needs you on another device" + (more > 0 ? " and \(more) more" : ""))
                        .fixedSize()
                    Text("\(handoff.requesterName) needs you")
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .font(Theme.Fonts.callout.weight(.medium))
                .foregroundStyle(Theme.Ink.primary)
                HStack(spacing: 2) {
                    Text("Show")
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .bold))
                }
                .font(Theme.Fonts.callout.weight(.semibold))
                .foregroundStyle(Theme.Status.handoffText)
                .fixedSize()
            }
            .padding(.horizontal, Theme.Space.m)
            .frame(minHeight: 24)
            .background(Theme.Status.handoffTint, in: Capsule())
            .background(Theme.Surface.card, in: Capsule())
            .overlay(Capsule().strokeBorder(Theme.Status.handoff.opacity(0.35), lineWidth: 1))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .help("\(handoff.requesterName) needs you on \(device.name): \(handoff.reason)")
        .accessibilityLabel("\(handoff.requesterName) needs you on \(device.name): \(handoff.reason)")
        .accessibilityHint("Shows \(device.name)")
        .testAnchor("Show Help Request")
    }
}

/// With no device selected (nothing on the stage), a help request shows as a banner at the top of the window.
struct HelpRequestBanner: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var elsewhere: [Handoff] {
        let listed = Set(model.devices.map(\.id))
        return model.handoffs.values
            .filter { $0.isPending && $0.deviceId != model.selection && listed.contains($0.deviceId) }
            .sorted { ($0.createdAt ?? "") < ($1.createdAt ?? "") }
    }

    var body: some View {
        ZStack {
            if let h = elsewhere.first, let d = model.devices.first(where: { $0.id == h.deviceId }) {
                let extra = elsewhere.count - 1
                HStack(spacing: Theme.Space.m) {
                    Image(systemName: "hand.raised.fill")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Theme.Ink.onFill)
                        .frame(width: 24, height: 24)
                        .background(Theme.Status.handoffStrong, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 0) {
                        Text("\(h.requesterName) needs you on \(d.name)" + (extra > 0 ? " (and \(extra) more)" : ""))
                            .font(Theme.Fonts.callout.weight(.semibold))
                            .foregroundStyle(Theme.Status.handoffText)
                            .lineLimit(1)
                        Text(h.reason).font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.primary).lineLimit(1).truncationMode(.tail)
                    }
                    Spacer(minLength: Theme.Space.m)
                    Button("Show") { model.selection = d.id }
                        .buttonStyle(.borderedProminent)
                        .tint(Theme.Status.handoffStrong)
                        .controlSize(.large)
                        .testAnchor("Show Help Request")
                }
                .padding(.horizontal, Theme.Space.m)
                .padding(.vertical, Theme.Space.s)
                .frame(maxWidth: 640)
                .background(Theme.Status.handoffTint, in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
                .background(Theme.Surface.card, in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous).strokeBorder(Theme.Line.card, lineWidth: 1))
                .shadow(color: Theme.Elevation.float, radius: 10, x: 0, y: 3)
                .padding(.horizontal, Theme.Space.xl)
                .padding(.vertical, Theme.Space.m)
                .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
                .accessibilityElement(children: .contain)
                .testAnchor("Help request banner")
            }
        }
        .animation(Theme.Motion.decorative(Theme.Motion.standard, reduceMotion: reduceMotion), value: elsewhere.first?.id)
    }
}
