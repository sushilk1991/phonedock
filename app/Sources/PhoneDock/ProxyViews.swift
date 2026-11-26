import SwiftUI
import AppKit

// Bring your own proxy: Settings › Proxies (paste, test exit IP/country on the spot, save, delete)
// and InfoTab › Proxy (live attach/detach picker on Android devices; honest explanation on iOS).

// MARK: - Models

struct ProxyTestResult: Codable, Equatable, Sendable {
    var ok: Bool
    var ip: String?
    var country: String?
    var city: String?
    var org: String?
    var latencyMs: Int
    var at: String
    var error: String?

    var locationText: String? {
        let parts = [city, country].compactMap { $0 }.filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    var summaryLine: String {
        if !ok { return error ?? "Proxy test failed" }
        var parts: [String] = []
        if let ip { parts.append(ip) }
        if let loc = locationText { parts.append(loc) }
        if let org, !org.isEmpty { parts.append(org) }
        parts.append("\(latencyMs) ms")
        return parts.joined(separator: " · ")
    }
}

struct SavedProxy: Decodable, Identifiable, Equatable, Sendable {
    var id: String
    var name: String
    var scheme: String
    var host: String
    var port: Int
    var username: String?
    var hasAuth: Bool
    var url: String
    var createdAt: String
    var updatedAt: String
    var lastTest: ProxyTestResult?
}

struct SavedProxyTestResponse: Decodable, Sendable {
    var proxy: SavedProxy
    var result: ProxyTestResult
}

struct DeviceProxyState: Decodable, Equatable, Sendable {
    var deviceId: String
    var supported: Bool
    var reason: String?
    var proxyId: String?
    var proxy: SavedProxy?
    var applied: Bool
    var localPort: Int?
    var error: String?
    var note: String?
}

// MARK: - Settings › Proxies

struct ProxiesSettings: View {
    @Environment(AppModel.self) private var model
    @State private var proxies: [SavedProxy] = []
    @State private var loading = false
    @State private var loadError: String?

    @State private var nameInput = ""
    @State private var urlInput = ""
    @State private var testingDraft = false
    @State private var savingDraft = false
    @State private var draftTest: ProxyTestResult?
    @State private var draftError: String?

    @State private var testingId: String?
    @State private var deleteTarget: SavedProxy?

    private var trimmedName: String { nameInput.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedUrl: String { urlInput.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canTestDraft: Bool { !trimmedUrl.isEmpty && !testingDraft && !savingDraft && model.connection.isConnected }
    private var canSaveDraft: Bool { !trimmedName.isEmpty && !trimmedUrl.isEmpty && !testingDraft && !savingDraft && model.connection.isConnected }

    var body: some View {
        SettingsPane {
            SettingsSection(
                "Add a proxy",
                note: "Supports HTTP, SOCKS5 and SOCKS5H URLs. Credentials are saved with 0600 permissions on this Mac and never shown again."
            ) {
                SettingsCard {
                    VStack(alignment: .leading, spacing: Theme.Space.m) {
                        HStack(spacing: Theme.Space.m) {
                            Text("Name")
                                .font(Theme.Fonts.body)
                                .foregroundStyle(Theme.Ink.primary)
                                .frame(width: 56, alignment: .leading)
                            TextField("Name", text: $nameInput, prompt: Text("e.g. Boston US"))
                                .textFieldStyle(.roundedBorder)
                                .testAnchor("Proxy name field")
                        }
                        HStack(spacing: Theme.Space.m) {
                            Text("URL")
                                .font(Theme.Fonts.body)
                                .foregroundStyle(Theme.Ink.primary)
                                .frame(width: 56, alignment: .leading)
                            TextField("Proxy URL", text: $urlInput, prompt: Text("socks5://user:pass@host:1080 or http://host:8080"))
                                .textFieldStyle(.roundedBorder)
                                .font(Theme.Fonts.monoSmall)
                                .onChange(of: urlInput) { draftTest = nil; draftError = nil }
                                .testAnchor("Proxy URL field")
                        }
                        if let draftTest {
                            proxyTestBadge(draftTest)
                        }
                        if let draftError {
                            Text(draftError)
                                .font(Theme.Fonts.callout)
                                .foregroundStyle(Theme.Status.errorText)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        HStack(spacing: Theme.Space.s) {
                            Spacer()
                            Button(testingDraft ? "Testing…" : "Test") { runDraftTest() }
                                .disabled(!canTestDraft)
                                .testAnchor("Test proxy button")
                            Button(savingDraft ? "Saving…" : "Save") { saveDraft() }
                                .buttonStyle(.borderedProminent)
                                .disabled(!canSaveDraft)
                                .testAnchor("Save proxy button")
                        }
                    }
                    .padding(Theme.Space.l)
                }
            }

            SettingsSection(
                "Saved proxies",
                note: "Attach a proxy from any Android device’s Info tab. Applies live without restarting for apps that honor the system HTTP proxy; UDP/QUIC is not proxied. iOS simulators and iPhones do not support per-device proxies."
            ) {
                SettingsCard {
                    if let loadError {
                        SettingsRow {
                            Text(loadError)
                                .font(Theme.Fonts.callout)
                                .foregroundStyle(Theme.Status.errorText)
                        } trailing: {
                            Button("Try Again") { Task { await load() } }
                        }
                    } else if loading && proxies.isEmpty {
                        SettingsRow {
                            HStack(spacing: Theme.Space.s) {
                                ProgressView().controlSize(.small)
                                Text("Loading proxies…").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                            }
                        } trailing: { EmptyView() }
                    } else if proxies.isEmpty {
                        SettingsRow {
                            Text("No saved proxies yet.")
                                .font(Theme.Fonts.callout)
                                .foregroundStyle(Theme.Ink.secondary)
                        } trailing: { EmptyView() }
                    } else {
                        ForEach(proxies) { proxy in
                            savedProxyRow(proxy)
                        }
                    }
                }
            }
        }
        .task(id: model.connection.isConnected) { await load() }
        .alert(
            "Delete “\(deleteTarget?.name ?? "")”?",
            isPresented: Binding(get: { deleteTarget != nil }, set: { if !$0 { deleteTarget = nil } }),
            presenting: deleteTarget
        ) { target in
            Button("Delete", role: .destructive) { deleteProxy(target) }
            Button("Cancel", role: .cancel) {}.keyboardShortcut(.defaultAction)
        } message: { _ in
            Text("Any Android device using this proxy will be detached.")
        }
    }

    @ViewBuilder
    private func savedProxyRow(_ proxy: SavedProxy) -> some View {
        let isTesting = testingId == proxy.id
        SettingsRow {
            VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                HStack(spacing: Theme.Space.s) {
                    Text(proxy.name)
                        .font(Theme.Fonts.body.weight(.medium))
                        .foregroundStyle(Theme.Ink.primary)
                    Text(proxy.url)
                        .font(Theme.Fonts.monoSmall)
                        .foregroundStyle(Theme.Ink.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                if let last = proxy.lastTest {
                    proxyTestBadge(last)
                } else {
                    Text("Not tested yet")
                        .font(Theme.Fonts.meta)
                        .foregroundStyle(Theme.Ink.tertiary)
                }
            }
        } trailing: {
            HStack(spacing: Theme.Space.s) {
                Button(isTesting ? "Testing…" : "Test") { testSaved(proxy) }
                    .controlSize(.small)
                    .disabled(isTesting || testingId != nil)
                Button(role: .destructive) { deleteTarget = proxy } label: {
                    Image(systemName: "trash")
                }
                .controlSize(.small)
                .help("Delete \(proxy.name)")
                .accessibilityLabel("Delete \(proxy.name)")
            }
        }
    }

    private func proxyTestBadge(_ result: ProxyTestResult) -> some View {
        HStack(spacing: Theme.Space.xs) {
            Image(systemName: result.ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .foregroundStyle(result.ok ? Theme.Status.running : Theme.Status.error)
                .accessibilityHidden(true)
            Text(result.summaryLine)
                .font(Theme.Fonts.callout)
                .foregroundStyle(result.ok ? Theme.Ink.primary : Theme.Status.errorText)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func load() async {
        guard let c = model.client else { proxies = []; return }
        loading = true
        defer { loading = false }
        do {
            proxies = try await c.proxies()
            loadError = nil
        } catch {
            loadError = (error as? APIError)?.message ?? "Couldn’t load saved proxies."
        }
    }

    private func runDraftTest() {
        guard let c = model.client, canTestDraft else { return }
        let url = trimmedUrl
        testingDraft = true
        draftError = nil
        Task {
            defer { testingDraft = false }
            do {
                draftTest = try await c.testProxyUrl(url)
            } catch {
                draftTest = nil
                draftError = (error as? APIError)?.message ?? error.localizedDescription
            }
        }
    }

    private func saveDraft() {
        guard let c = model.client, canSaveDraft else { return }
        let name = trimmedName
        let url = trimmedUrl
        let priorTest = draftTest
        savingDraft = true
        draftError = nil
        Task {
            defer { savingDraft = false }
            do {
                let saved = try await c.addProxy(name: name, url: url, lastTest: priorTest)
                proxies.append(saved)
                nameInput = ""
                urlInput = ""
                draftTest = nil
            } catch {
                draftError = (error as? APIError)?.message ?? error.localizedDescription
            }
        }
    }

    private func testSaved(_ proxy: SavedProxy) {
        guard let c = model.client, testingId == nil else { return }
        testingId = proxy.id
        Task {
            defer { testingId = nil }
            do {
                let res = try await c.testSavedProxy(proxy.id)
                if let idx = proxies.firstIndex(where: { $0.id == proxy.id }) {
                    proxies[idx] = res.proxy
                }
            } catch {
                loadError = (error as? APIError)?.message ?? error.localizedDescription
            }
        }
    }

    private func deleteProxy(_ proxy: SavedProxy) {
        guard let c = model.client else { return }
        Task {
            do {
                try await c.deleteProxy(proxy.id)
                proxies.removeAll { $0.id == proxy.id }
            } catch {
                loadError = (error as? APIError)?.message ?? error.localizedDescription
            }
        }
    }
}

// MARK: - Inspector › Info › Proxy

struct DeviceProxyView: View {
    @Environment(AppModel.self) private var model
    @AppStorage(Prefs.settingsTab) private var settingsTab = "general"
    @Environment(\.openSettings) private var openSettings

    let device: Device
    @State private var state: DeviceProxyState?
    @State private var proxies: [SavedProxy] = []
    @State private var working = false
    @State private var loadError: String?

    private var isSupported: Bool {
        device.backend == "android-emulator" || device.backend == "android-device"
    }

    private var disabled: Bool {
        working || device.leasedByAgent || !model.connection.isConnected
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHeader("Proxy") {
                if isSupported {
                    Button("Manage…") {
                        settingsTab = "proxies"
                        openSettings()
                    }
                    .controlSize(.small)
                    .buttonStyle(.pdLink)
                }
            }
            if !isSupported {
                Text(device.backend == "ios-simulator"
                     ? "iOS simulators share this Mac’s network stack and don’t support per-device proxies."
                     : "A real iPhone keeps its HTTP proxy in Settings › Wi-Fi on the device.")
                    .font(Theme.Fonts.callout)
                    .foregroundStyle(Theme.Ink.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, Theme.Space.l)
            } else if let state {
                VStack(alignment: .leading, spacing: Theme.Space.s) {
                    HStack(spacing: Theme.Space.s) {
                        Picker("Proxy", selection: Binding(
                            get: { state.proxyId ?? "" },
                            set: { choose($0) }
                        )) {
                            Text("None").tag("")
                            ForEach(proxies) { p in
                                Text(pickerLabel(p)).tag(p.id)
                            }
                        }
                        .labelsHidden()
                        .pickerStyle(.menu)
                        .disabled(disabled)
                        .testAnchor("Device proxy picker")

                        if working {
                            ProgressView().controlSize(.mini)
                        }
                    }

                    if let proxy = state.proxy {
                        HStack(spacing: Theme.Space.xs) {
                            Image(systemName: state.error != nil ? "exclamationmark.triangle.fill" : (state.applied ? "checkmark.circle.fill" : "clock"))
                                .foregroundStyle(state.error != nil ? Theme.Status.error : (state.applied ? Theme.Status.running : Theme.Ink.secondary))
                                .accessibilityHidden(true)
                            Text(statusText(state, proxy))
                                .font(Theme.Fonts.meta)
                                .foregroundStyle(state.error != nil ? Theme.Status.errorText : Theme.Ink.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    } else if proxies.isEmpty {
                        Text("Add a proxy in Settings › Proxies to route this device.")
                            .font(Theme.Fonts.meta)
                            .foregroundStyle(Theme.Ink.secondary)
                    }
                }
                .font(Theme.Fonts.callout)
                .padding(.horizontal, Theme.Space.l)
                .help(device.leasedByAgent ? "Take over from the agent to change this device’s proxy." : "")
            } else if let loadError {
                VStack(alignment: .leading, spacing: Theme.Space.xs) {
                    Text(loadError)
                        .font(Theme.Fonts.callout)
                        .foregroundStyle(Theme.Status.errorText)
                    Button("Retry") { Task { await load() } }.controlSize(.small)
                }
                .padding(.horizontal, Theme.Space.l)
            } else {
                DelayedSpinner().frame(height: 30)
            }
        }
        .task(id: "\(device.id):\(device.state)") { await load() }
    }

    private func pickerLabel(_ p: SavedProxy) -> String {
        if let last = p.lastTest, last.ok, let loc = last.locationText ?? last.ip {
            return "\(p.name) (\(loc))"
        }
        return p.name
    }

    private func statusText(_ st: DeviceProxyState, _ p: SavedProxy) -> String {
        if let err = st.error { return err }
        var parts: [String] = [st.applied ? "Active live" : "Saved — applies on boot"]
        if let last = p.lastTest, last.ok {
            if let ip = last.ip { parts.append(ip) }
            if let loc = last.locationText { parts.append(loc) }
        }
        return parts.joined(separator: " · ")
    }

    private func load() async {
        guard isSupported, let c = model.client else { return }
        do {
            async let st = c.deviceProxy(device.id)
            async let list = c.proxies()
            state = try await st
            proxies = try await list
            loadError = nil
        } catch {
            loadError = (error as? APIError)?.message ?? "Couldn’t read proxy status."
        }
    }

    private func choose(_ newId: String) {
        guard !disabled, let c = model.client else { return }
        if newId == (state?.proxyId ?? "") { return }
        working = true
        Task {
            defer { working = false }
            do {
                if newId.isEmpty {
                    state = try await c.detachProxy(device.id)
                } else {
                    state = try await c.attachProxy(device.id, proxyId: newId)
                }
                loadError = nil
            } catch {
                model.fail("Couldn’t update proxy", error, device: device)
                await load()
            }
        }
    }
}
