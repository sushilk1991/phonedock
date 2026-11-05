// UpdatesSettingsSection.swift — Settings › General › Updates, the last section of General (SettingsView.swift):
// where this copy stands (up to date, an update, a problem) with Check Now or Update, and the automatic-check
// switch. Built from Settings' own parts (DESIGN.md › Settings). State lives in UpdateController; an update it finds
// also shows at the bottom of the main window's sidebar (UpdateSidebarItem.swift).

import SwiftUI

struct UpdatesSettingsSection: View {
    private var updates: UpdateController { .shared }

    var body: some View {
        let u = updates
        SettingsSection("Updates", note: u.unavailableReason == nil
                        ? "Updates are verified before they install, and PhoneDock restarts to finish." : nil) {
            SettingsCard {
                // "Checked 2 minutes ago" stays true while the window is open.
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    statusRow(u, now: context.date)
                }
                SettingsRow("Check for updates automatically", detail: "Once a day, and each time PhoneDock opens.") {
                    Toggle("Check for updates automatically", isOn: Binding(get: { u.automaticChecks }, set: { u.automaticChecks = $0 }))
                        .labelsHidden()
                        .toggleStyle(.switch)
                        .disabled(u.unavailableReason != nil)
                        .testAnchor("Check for updates automatically")
                }
            }
        }
        .testAnchor("settings-updates")
    }

    // MARK: Status

    private enum Status {
        /// Nothing known yet this session (or updates are off): the version and when it last checked, no verdict.
        case plain(detail: String)
        case headline(SettingsHealth, title: String, detail: String?, help: String?)
    }

    @ViewBuilder private func statusRow(_ u: UpdateController, now: Date) -> some View {
        switch status(u, now: now) {
        case .plain(let detail):
            SettingsRow("PhoneDock \(version(u))", detail: detail) { action(u) }
                .testAnchor("update-status")
        case .headline(let health, let title, let detail, let help):
            SettingsRow {
                SettingsStatusHeadline(health: health, title: title, detail: detail)
                    .help(help ?? "")
            } trailing: {
                action(u)
            }
            .testAnchor("update-status")
        }
    }

    private func status(_ u: UpdateController, now: Date) -> Status {
        let mine = "You have \(version(u))"
        if let reason = u.unavailableReason { return .plain(detail: reason) }
        switch u.phase {
        case .checking:
            return .headline(.working, title: "Checking for updates…", detail: mine, help: nil)
        case .available(let o):
            return .headline(.available, title: "PhoneDock \(o.version) is available", detail: mine, help: nil)
        case .downloading(let o, let f):
            let pct = f.map { " \(Int(($0 * 100).rounded(.down)))%" } ?? ""
            return .headline(.working, title: "Downloading PhoneDock \(o.version)…\(pct)", detail: mine, help: nil)
        case .installing(let o), .relaunching(let o, _):
            return .headline(.working, title: "Installing PhoneDock \(o.version)…", detail: mine, help: nil)
        case .failed(_, let problem):
            return .headline(.problem, title: problem.title, detail: problem.message, help: problem.details)
        case .idle:
            break
        }
        let checked = u.lastChecked.map { checkedPhrase($0, now: now) }
        switch u.lastResult {
        case .upToDate?:
            return .headline(.ready, title: "Up to date", detail: [mine, checked].compactMap { $0 }.joined(separator: " · "), help: nil)
        case .failed(let problem)?:
            return .headline(.problem, title: problem.title, detail: problem.message, help: problem.details)
        case .found?, nil:
            // An offer that has gone (opened on the web, say) or no check yet: no verdict, just the facts.
            return .plain(detail: checked ?? "Not checked yet")
        }
    }

    /// The row's control: Update when there's one, Try Again after a problem, otherwise Check Now.
    @ViewBuilder private func action(_ u: UpdateController) -> some View {
        switch u.phase {
        case .available:
            Button("Update") { u.install() }
                .buttonStyle(.borderedProminent)
                .testAnchor("Settings Update")
        case .downloading, .installing, .relaunching:
            EmptyView()
        case .failed(_, let problem):
            if UpdateErrors.canRetry(problem) { Button("Try Again") { u.retry() } }
        case .checking:
            Button("Checking…") {}.disabled(true)
        case .idle:
            if case .failed? = u.lastResult, u.unavailableReason == nil {
                Button("Try Again") { u.checkForUpdates(from: .settings) }
                    .disabled(!u.canCheck)
            } else {
                Button("Check Now") { u.checkForUpdates(from: .settings) }
                    .disabled(u.unavailableReason != nil || !u.canCheck)
                    .testAnchor("Check Now")
            }
        }
    }

    private func version(_ u: UpdateController) -> String {
        u.currentBuild.isEmpty || u.currentBuild == u.currentVersion ? u.currentVersion : "\(u.currentVersion) (\(u.currentBuild))"
    }

    private func checkedPhrase(_ date: Date, now: Date) -> String {
        if now.timeIntervalSince(date) < 60 { return "Checked just now" }
        return "Checked " + date.formatted(.relative(presentation: .named, unitsStyle: .wide))
    }
}

/// App menu › Check for Updates…, after About PhoneDock.
struct CheckForUpdatesMenuItem: View {
    private var updates: UpdateController { .shared }

    var body: some View {
        Button("Check for Updates…") { updates.checkForUpdates(from: .menu) }
            .disabled(updates.unavailableReason != nil || !updates.canCheck)
    }
}
