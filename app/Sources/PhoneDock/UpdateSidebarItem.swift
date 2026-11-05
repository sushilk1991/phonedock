// UpdateSidebarItem.swift — the update item at the bottom of the main window's sidebar.
// Nothing shows until there is something to say: an update to install, its progress, or why it didn't work (and
// "Checking for updates…" while a check someone asked for runs). State lives in UpdateController.

import SwiftUI

extension View {
    /// Pins the update item under the sidebar's list. On macOS 26 it's a safe-area bar, so rows scrolling under it get
    /// the system's scroll-edge effect; earlier versions inset the list instead.
    @ViewBuilder func sidebarUpdateItem() -> some View {
        if #available(macOS 26.0, *) {
            safeAreaBar(edge: .bottom, spacing: 0) { UpdateSidebarItem() }
        } else {
            safeAreaInset(edge: .bottom, spacing: 0) { UpdateSidebarItem() }
        }
    }
}

struct UpdateSidebarItem: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var updates: UpdateController { .shared }

    var body: some View {
        let phase = updates.phase
        ZStack {
            if phase != .idle {
                card(phase)
                    .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(reduceMotion ? .linear(duration: 0.12) : Theme.Motion.standard, value: Kind(phase))
        .onAppear { updates.attach(model) }
    }

    /// What changes the item's shape (so the progress bar's ticks don't animate the whole item).
    private enum Kind: Equatable { case idle, checking, available, downloading, installing, relaunching, failed
        init(_ p: UpdatePhase) {
            switch p {
            case .idle: self = .idle
            case .checking: self = .checking
            case .available: self = .available
            case .downloading: self = .downloading
            case .installing: self = .installing
            case .relaunching: self = .relaunching
            case .failed: self = .failed
            }
        }
    }

    private func card(_ phase: UpdatePhase) -> some View {
        content(phase)
            .padding(.horizontal, Theme.Space.m)
            .padding(.vertical, Theme.Space.m)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.6), in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous).strokeBorder(Theme.Line.card, lineWidth: 0.5))
            // Sidebar rows sit 10 pt in from the column's edges; the glyph lines up with theirs.
            .padding(.horizontal, 10)
            .padding(.top, Theme.Space.s)
            .padding(.bottom, Theme.Space.m + Theme.Space.xxs)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Software update")
            .testAnchor("update-item")
    }

    @ViewBuilder private func content(_ phase: UpdatePhase) -> some View {
        switch phase {
        case .idle:
            EmptyView()
        case .checking:
            HStack(spacing: Theme.Space.m) {
                ProgressView().controlSize(.small).frame(width: 20)
                Text("Checking for updates…").font(Theme.Fonts.callout).foregroundStyle(.secondary).lineLimit(1)
                Spacer(minLength: 0)
            }
            .testAnchor("update-checking")
        case .available(let offer):
            available(offer)
        case .downloading(let offer, let fraction):
            progress(offer, verb: "Downloading", fraction: fraction, cancel: { updates.cancelDownload() })
                .testAnchor("update-downloading")
        case .installing(let offer):
            progress(offer, verb: "Installing", fraction: nil, cancel: nil)
                .testAnchor("update-installing")
        case .relaunching(let offer, let stuck):
            VStack(alignment: .leading, spacing: Theme.Space.s) {
                progress(offer, verb: "Restarting", fraction: nil, cancel: nil, named: false)
                if stuck {
                    Button("Restart Now") { updates.retryRestart() }
                        .controlSize(.small)
                        .padding(.leading, 20 + Theme.Space.m)
                        .help("Quit PhoneDock to finish the update")
                }
            }
            .testAnchor("update-relaunching")
        case .failed(let offer, let problem):
            failure(offer, problem)
        }
    }

    // MARK: States

    private func available(_ offer: UpdateOffer) -> some View {
        HStack(spacing: Theme.Space.m) {
            glyph
            VStack(alignment: .leading, spacing: 1) {
                // The name and version, then the state, like the device rows above.
                ViewThatFits(in: .horizontal) {
                    Text("PhoneDock \(offer.version)")
                    Text(offer.version)
                }
                .font(Theme.Fonts.body)
                .foregroundStyle(Theme.Ink.primary)
                .lineLimit(1)
                Text(offer.infoOnly ? "New version" : "Update available")
                    .font(Theme.Fonts.meta)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .layoutPriority(1)
            Spacer(minLength: Theme.Space.xs)
            Button(offer.infoOnly ? "Learn More" : "Update") { updates.install() }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .fixedSize()
                .help(offer.infoOnly ? "Open the release page" : "Download PhoneDock \(offer.version), install it and restart")
                .testAnchor("Update")
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("PhoneDock \(offer.version) is available")
        .contextMenu {
            Button(offer.infoOnly ? "Learn More" : "Update") { updates.install() }
            if offer.releaseNotes != nil { Button("Release Notes") { updates.openReleaseNotes() } }
        }
        .testAnchor("update-available")
    }

    private func progress(_ offer: UpdateOffer, verb: String, fraction: Double?, cancel: (() -> Void)?, named: Bool = true) -> some View {
        HStack(alignment: .top, spacing: Theme.Space.m) {
            glyph
            VStack(alignment: .leading, spacing: Theme.Space.xs) {
                ViewThatFits(in: .horizontal) {
                    if named { Text("\(verb) PhoneDock \(offer.version)…") }
                    if named { Text("\(verb) \(offer.version)…") }
                    Text(verb == "Restarting" ? "Restarting PhoneDock…" : "\(verb)…")
                    Text("\(verb)…")
                }
                .font(Theme.Fonts.callout)
                .foregroundStyle(Theme.Ink.primary)
                .lineLimit(1)
                HStack(spacing: Theme.Space.s) {
                    Group {
                        if let fraction {
                            ProgressView(value: fraction)
                        } else {
                            ProgressView()
                        }
                    }
                    .progressViewStyle(.linear)
                    .controlSize(.small)
                    .tint(Theme.Accent.fill)
                    if let fraction {
                        Text(fraction, format: .percent.precision(.fractionLength(0)))
                            .font(Theme.Fonts.meta.monospacedDigit())
                            .foregroundStyle(.secondary)
                            .frame(minWidth: 30, alignment: .trailing)
                    }
                }
            }
            if let cancel {
                // The same plain × as Dismiss on an error (a filled circle all but vanished on the dark card).
                Button(action: cancel) { closeGlyph }
                    .buttonStyle(.plain)
                .help("Stop Downloading")
                .accessibilityLabel("Stop Downloading")
                .testAnchor("Stop Downloading")
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(verb) PhoneDock \(offer.version)")
    }

    private func failure(_ offer: UpdateOffer?, _ problem: FriendlyError) -> some View {
        HStack(alignment: .top, spacing: Theme.Space.m) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(Theme.Fonts.body)
                .foregroundStyle(Theme.Status.error)
                .frame(width: 20)
                .accessibilityHidden(true)
            // Line limits, not fixedSize: the bar is measured with any width, and text that may grow without limit
            // there made the bar taller than the window (the sidebar's rows and the stage slid off screen).
            VStack(alignment: .leading, spacing: Theme.Space.xs) {
                Text(problem.title)
                    .font(Theme.Fonts.callout.weight(.semibold))
                    .foregroundStyle(Theme.Ink.primary)
                    .lineLimit(2)
                if let message = problem.message {
                    Text(message)
                        .font(Theme.Fonts.meta)
                        .foregroundStyle(.secondary)
                        .lineLimit(4)
                }
                if UpdateErrors.canRetry(problem) {
                    Button("Try Again") { updates.retry() }
                        .controlSize(.small)
                        .padding(.top, Theme.Space.xxs)
                        .testAnchor("Try Again")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button { updates.dismissError() } label: { closeGlyph }
            .buttonStyle(.plain)
            .help("Dismiss")
            .accessibilityLabel("Dismiss")
            .testAnchor("Dismiss update error")
        }
        .help(problem.details ?? "")
        .contextMenu {
            if let details = problem.details { Button("Copy Details") { Clipboard.copy(details) } }
            Button("Dismiss") { updates.dismissError() }
        }
        .testAnchor("update-error")
    }

    /// Stop Downloading and Dismiss: a small × in secondary ink (its tooltip and accessibility label say which).
    private var closeGlyph: some View {
        Image(systemName: "xmark")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(.secondary)
            .frame(width: 16, height: 16)
            .contentShape(Rectangle())
    }

    private var glyph: some View {
        Image(systemName: "arrow.down.circle.fill")
            .symbolRenderingMode(.palette)
            .foregroundStyle(Theme.Ink.onFill, Theme.Accent.fill)
            .font(Theme.Fonts.body)
            .imageScale(.large)
            .frame(width: 20)
            .accessibilityHidden(true)
    }
}
