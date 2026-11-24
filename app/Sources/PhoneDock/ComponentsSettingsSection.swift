// ComponentsSettingsSection.swift — Settings › Advanced › Components:
// lists managed upstream runtimes (iPhone Control / ios-tools, Simulator Control / axe), their status, version,
// size, and Install / Update / Retry controls. Built from Settings' own parts (Theme.swift, SettingsView.swift).

import SwiftUI

struct ComponentsSettingsSection: View {
    @Environment(AppModel.self) private var model
    var failed: Bool
    var onReload: () async -> Void

    var body: some View {
        SettingsSection(
            "Components",
            note: "Downloaded on demand from pinned upstream releases and verified before use."
        ) {
            SettingsCard {
                if !model.connection.isConnected {
                    SettingsRow {
                        SettingsStatusHeadline(
                            health: .missing,
                            title: "Not available",
                            detail: "Shown once PhoneDock’s service is running."
                        )
                    } trailing: { EmptyView() }
                } else if failed && model.components.isEmpty {
                    SettingsRow {
                        SettingsStatusHeadline(
                            health: .problem,
                            title: "Couldn’t check components",
                            detail: "The service didn’t answer."
                        )
                    } trailing: {
                        Button("Try Again") { Task { await onReload() } }
                    }
                } else if model.components.isEmpty {
                    SettingsRow {
                        HStack(spacing: Theme.Space.s) {
                            ProgressView().controlSize(.small)
                            Text("Checking components…")
                                .font(Theme.Fonts.callout)
                                .foregroundStyle(Theme.Ink.secondary)
                        }
                    } trailing: { EmptyView() }
                } else {
                    ForEach(model.components) { comp in
                        ComponentRow(component: comp)
                    }
                }
            }
        }
        .testAnchor("settings-components")
    }
}

private struct ComponentRow: View {
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var scheme
    let component: ComponentStatus

    private static let byteFormatter: ByteCountFormatter = {
        let f = ByteCountFormatter()
        f.countStyle = .file
        f.allowedUnits = [.useMB, .useGB, .useKB]
        return f
    }()

    private var formattedSize: String {
        let bytes = component.sizeBytes ?? component.estimatedBytes
        return Self.byteFormatter.string(fromByteCount: bytes)
    }

    private var versionLabel: String {
        if let installed = component.installedVersion, installed != component.pinnedVersion {
            return "\(installed) → \(component.pinnedVersion)"
        }
        return component.installedVersion ?? component.pinnedVersion
    }

    private var metaLine: String {
        var parts = ["v\(versionLabel)", formattedSize]
        if component.state == "ready" {
            if component.source == "override" { parts.append("Custom override") }
            else if component.source == "external" { parts.append("Installed on Mac") }
        }
        return parts.joined(separator: " · ")
    }

    private var health: SettingsHealth {
        switch component.state {
        case "installing": return .working
        case "failed": return .problem
        case "ready": return component.updateAvailable ? .available : .ready
        default: return .missing
        }
    }

    private var progressDetail: String? {
        guard component.state == "installing" else { return nil }
        let p = component.progress
        let phase: String = switch p?.phase {
        case "downloading": "Downloading"
        case "verifying": "Verifying"
        case "extracting": "Extracting"
        case "installing": "Installing"
        case "checking": "Checking"
        default: "Preparing"
        }
        if let done = p?.bytesDone, let total = p?.bytesTotal, total > 0, p?.phase == "downloading" {
            let d = Self.byteFormatter.string(fromByteCount: done)
            let t = Self.byteFormatter.string(fromByteCount: total)
            return "\(phase) (\(d) of \(t))…"
        }
        return "\(phase)…"
    }

    var body: some View {
        SettingsRow {
            VStack(alignment: .leading, spacing: Theme.Space.xs) {
                HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s) {
                    statusGlyph
                        .frame(width: 16, height: 16)
                    VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                        HStack(spacing: Theme.Space.s) {
                            Text(component.displayName)
                                .font(Theme.Fonts.body)
                                .foregroundStyle(Theme.Ink.primary)
                            Text(metaLine)
                                .font(Theme.Fonts.meta.monospacedDigit())
                                .foregroundStyle(Theme.Ink.secondary)
                        }
                        if component.state == "installing" {
                            VStack(alignment: .leading, spacing: Theme.Space.xs) {
                                if let detail = progressDetail {
                                    Text(detail)
                                        .font(Theme.Fonts.callout)
                                        .foregroundStyle(Theme.Ink.secondary)
                                }
                                if let pct = component.progress?.percent {
                                    ProgressView(value: Double(pct) / 100.0)
                                        .progressViewStyle(.linear)
                                        .frame(maxWidth: 240)
                                } else {
                                    ProgressView()
                                        .progressViewStyle(.linear)
                                        .frame(maxWidth: 240)
                                }
                            }
                        } else if component.state == "failed" {
                            Text(component.error?.message ?? "Setup failed.")
                                .font(Theme.Fonts.callout)
                                .foregroundStyle(Theme.Status.errorText)
                                .fixedSize(horizontal: false, vertical: true)
                                .help(component.error?.detail ?? "")
                        } else if component.state == "ready", component.updateAvailable {
                            Text("Update available (v\(component.pinnedVersion))")
                                .font(Theme.Fonts.callout)
                                .foregroundStyle(Theme.Ink.secondary)
                        } else {
                            Text(component.description)
                                .font(Theme.Fonts.callout)
                                .foregroundStyle(Theme.Ink.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        } trailing: {
            trailingControl
        }
        .testAnchor("component-\(component.id)")
    }

    @ViewBuilder private var statusGlyph: some View {
        switch health {
        case .ready:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(Theme.Status.running)
                .accessibilityLabel("Ready")
        case .working:
            ProgressView()
                .controlSize(.mini)
                .id(scheme)
                .accessibilityLabel("Installing")
        case .problem:
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Theme.Status.error)
                .accessibilityLabel("Failed")
        case .missing:
            Image(systemName: "circle.dashed")
                .foregroundStyle(Theme.Ink.secondary)
                .accessibilityLabel("Not installed")
        case .available:
            Image(systemName: "arrow.down.circle.fill")
                .symbolRenderingMode(.palette)
                .foregroundStyle(Theme.Ink.onFill, Theme.Accent.fill)
                .accessibilityLabel("Update available")
        }
    }

    @ViewBuilder private var trailingControl: some View {
        switch component.state {
        case "installing":
            if let pct = component.progress?.percent {
                Text("\(pct)%")
                    .font(Theme.Fonts.callout.monospacedDigit())
                    .foregroundStyle(Theme.Ink.secondary)
            } else {
                Text("Installing…")
                    .font(Theme.Fonts.callout)
                    .foregroundStyle(Theme.Ink.secondary)
            }
        case "failed":
            Button("Retry") { model.installComponent(component.id) }
                .testAnchor("Retry \(component.id)")
        case "missing":
            Button("Install") { model.installComponent(component.id) }
                .testAnchor("Install \(component.id)")
        case "ready":
            if component.updateAvailable {
                Button("Update") { model.installComponent(component.id) }
                    .testAnchor("Update \(component.id)")
            } else {
                SettingsStateLabel(
                    text: component.source == "override" ? "Custom" : component.source == "external" ? "Host" : "Ready",
                    symbol: "checkmark.circle.fill",
                    tint: Theme.Status.running
                )
            }
        default:
            Button("Install") { model.installComponent(component.id) }
        }
    }
}
