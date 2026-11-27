import SwiftUI
import AppKit
import UniformTypeIdentifiers

private struct DeviceSettingsValues: Decodable {
    var appearance: String?
    var textSize: Double?
    var boldText: Bool?
    var increaseContrast: Bool?
    var reduceMotion: Bool?
    var reduceTransparency: Bool?
    var colorFilter: String?
}
private struct DeviceSettingsResponse: Decodable {
    var settings: DeviceSettingsValues
    var supported: [String]
}

/// Uses the daemon's reported values; the daemon enforces the same lease as all other input.
struct DeviceSettingsView: View {
    @Environment(AppModel.self) private var model
    let device: Device
    @State private var result: DeviceSettingsResponse?
    @State private var working = false
    @State private var loadFailed = false
    @State private var sizeStep = 0.0
    private var sizes: [Double] {
        device.platform == "ios" ? [14, 15, 16, 17, 19, 21, 23, 28, 33, 40, 47, 53].map { $0 / 17 } : [0.85, 1, 1.15, 1.3, 1.5, 1.8, 2]
    }
    private func has(_ key: String) -> Bool { result?.supported.contains(key) == true }
    private var disabled: Bool { working || !device.isRunning || device.leasedByAgent }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHeader("Device Settings")
            if device.backend == "ios-device" {
                Text("iOS doesn’t allow these settings to be changed on an iPhone.")
                    .font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                    .padding(.horizontal, Theme.Space.l)
            } else if let result {
                VStack(alignment: .leading, spacing: Theme.Space.m) {
                    if has("appearance") {
                        Picker("Appearance", selection: Binding(get: { result.settings.appearance ?? "light" }, set: { apply(["appearance": $0]) })) {
                            Text("Light").tag("light"); Text("Dark").tag("dark")
                        }.pdSegmented().testAnchor("Device appearance")
                    }
                    if has("textSize") {
                        HStack {
                            Text("Text Size")
                            Spacer()
                            Text(String(format: "%.0f%%", (result.settings.textSize ?? 1) * 100)).monospacedDigit().foregroundStyle(Theme.Ink.secondary)
                            Button("Default") { apply(["textSize": "default"]) }.controlSize(.small).testAnchor("Default text size")
                        }
                        Slider(value: $sizeStep, in: 0...Double(sizes.count - 1), step: 1, onEditingChanged: { editing in
                            if !editing { apply(["textSize": sizes[Int(sizeStep)]]) }
                        }).accessibilityLabel("Text Size").testAnchor("Device text size")
                    }
                    if has("boldText") { toggle("Bold Text", "boldText", result.settings.boldText ?? false) }
                    if has("increaseContrast") { toggle("Increase Contrast", "increaseContrast", result.settings.increaseContrast ?? false) }
                    if has("reduceMotion") { toggle("Reduce Motion", "reduceMotion", result.settings.reduceMotion ?? false) }
                    if has("reduceTransparency") { toggle("Reduce Transparency", "reduceTransparency", result.settings.reduceTransparency ?? false) }
                    if has("colorFilter") {
                        Picker("Color Filter", selection: Binding(get: { result.settings.colorFilter ?? "none" }, set: { apply(["colorFilter": $0]) })) {
                            Text("None").tag("none"); Text("Grayscale").tag("grayscale"); Text("Invert").tag("invert")
                        }.pdSegmented().testAnchor("Color Filter")
                    }
                }
                .font(Theme.Fonts.callout).padding(.horizontal, Theme.Space.l)
                .disabled(disabled)
                .help(device.leasedByAgent ? "Take over from the agent to change device settings." : "")
            } else if loadFailed {
                Button("Retry Device Settings") { Task { await load() } }
                    .controlSize(.small).padding(.horizontal, Theme.Space.l)
            } else if device.isRunning {
                DelayedSpinner().frame(height: 36)
            } else {
                Text("Start the device to change its settings.").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                    .padding(.horizontal, Theme.Space.l)
            }
            if device.can("location") {
                Divider().padding(.vertical, Theme.Space.m)
                DeviceLocationSection(device: device)
            }
            if device.backend != "ios-simulator" {
                Divider().padding(.vertical, Theme.Space.m)
                DevicePasscodeSection(device: device)
            }
        }
        .task(id: "\(device.id):\(device.state)") { await load() }
    }

    private func toggle(_ title: String, _ key: String, _ value: Bool) -> some View {
        // Label on the left, switch on the right edge, so every row's switch lines up.
        HStack {
            Text(title)
            Spacer()
            Toggle(title, isOn: Binding(get: { value }, set: { apply([key: $0]) }))
                .labelsHidden().toggleStyle(.switch).controlSize(.small).testAnchor(title)
        }
    }
    private func update(_ response: DeviceSettingsResponse) {
        result = response
        let value = response.settings.textSize ?? 1
        sizeStep = Double(sizes.indices.min(by: { abs(sizes[$0] - value) < abs(sizes[$1] - value) }) ?? 0)
    }
    private func load() async {
        guard device.can("settings"), device.isRunning, let client = model.client else { return }
        do { update(try await client.get(DeviceSettingsResponse.self, client.dev(device.id, "/settings"), observe: true)); loadFailed = false }
        catch { loadFailed = true; model.fail("Couldn’t read device settings", error, device: device) }
    }
    private func apply(_ values: [String: Any]) {
        guard !disabled, let client = model.client else { return }
        working = true
        Task {
            defer { working = false }
            do {
                let data = try await client.send("POST", client.dev(device.id, "/settings"), json: values)
                update(try JSONDecoder().decode(DeviceSettingsResponse.self, from: data))
            } catch {
                model.fail("Couldn’t change device settings", error, device: device)
                await load()
            }
        }
    }
}

private struct LocationRouteState: Decodable {
    var active: Bool
    var name: String?
    var waypoints: Int
    var index: Int
    var speedMps: Double
    var loop: Bool
}

/// Location & GPX route controls inside Inspector › Device Settings.
private struct DeviceLocationSection: View {
    @Environment(AppModel.self) private var model
    let device: Device
    @State private var latText = ""
    @State private var lonText = ""
    @State private var speedMps = 5.0
    @State private var loopRoute = false
    @State private var route: LocationRouteState?
    @State private var statusMessage: String?
    @State private var working = false

    private static let presets: [(String, Double, Double)] = [
        ("San Francisco", 37.7749, -122.4194),
        ("New York", 40.7128, -74.0060),
        ("Boston", 42.3601, -71.0589),
        ("London", 51.5074, -0.1278),
        ("Tokyo", 35.6762, 139.6503),
        ("Bengaluru", 12.9716, 77.5946),
        ("Sydney", -33.8688, 151.2093),
    ]

    private var disabled: Bool { working || !device.isRunning || device.leasedByAgent }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.m) {
            SectionHeader("Location & GPX")
            VStack(alignment: .leading, spacing: Theme.Space.s) {
                HStack(spacing: Theme.Space.s) {
                    TextField("Lat", text: $latText)
                        .textFieldStyle(.roundedBorder)
                        .font(Theme.Fonts.numeric)
                    TextField("Lon", text: $lonText)
                        .textFieldStyle(.roundedBorder)
                        .font(Theme.Fonts.numeric)
                    Button("Set") { setCoordinates() }
                        .controlSize(.small)
                        .disabled(Double(latText.trimmingCharacters(in: .whitespaces)) == nil || Double(lonText.trimmingCharacters(in: .whitespaces)) == nil)
                }
                HStack(spacing: Theme.Space.s) {
                    Menu("Presets") {
                        ForEach(Self.presets, id: \.0) { city, lat, lon in
                            Button(city) {
                                latText = String(format: "%.4f", lat)
                                lonText = String(format: "%.4f", lon)
                                applyLocation(lat: lat, lon: lon, label: city)
                            }
                        }
                    }
                    .controlSize(.small)
                    Spacer()
                    Button("Load GPX…") { pickGpx() }
                        .controlSize(.small)
                }
                HStack(spacing: Theme.Space.s) {
                    Picker("Speed", selection: $speedMps) {
                        Text("Walk").tag(1.4)
                        Text("Bike").tag(5.0)
                        Text("Drive").tag(13.4)
                    }
                    .labelsHidden()
                    .pickerStyle(.segmented)
                    .controlSize(.small)
                    Toggle("Loop", isOn: $loopRoute)
                        .toggleStyle(.checkbox)
                        .controlSize(.small)
                }
                if let route, route.active {
                    HStack(spacing: Theme.Space.s) {
                        Label("\(route.name ?? "GPX route") (\(route.waypoints) pts)", systemImage: "location.fill")
                            .font(Theme.Fonts.meta)
                            .foregroundStyle(Theme.Ink.secondary)
                            .lineLimit(1)
                        Spacer()
                        Button("Stop") { stopRoute() }
                            .controlSize(.small)
                    }
                } else if let statusMessage {
                    Text(statusMessage)
                        .font(Theme.Fonts.meta)
                        .foregroundStyle(Theme.Ink.secondary)
                }
            }
            .font(Theme.Fonts.callout)
            .padding(.horizontal, Theme.Space.l)
            .disabled(disabled)
        }
        .task(id: "\(device.id):\(device.state)") {
            await loadRoute()
            while !Task.isCancelled && device.isRunning {
                try? await Task.sleep(for: .seconds(route?.active == true ? 2 : 5))
                if Task.isCancelled { break }
                await loadRoute()
            }
        }
    }

    private func loadRoute() async {
        guard device.isRunning, let c = model.client else { route = nil; return }
        route = try? await c.get(LocationRouteState.self, c.dev(device.id, "/location"), observe: true)
    }

    private func setCoordinates() {
        guard let lat = Double(latText.trimmingCharacters(in: .whitespaces)),
              let lon = Double(lonText.trimmingCharacters(in: .whitespaces)) else { return }
        applyLocation(lat: lat, lon: lon, label: String(format: "%.4f, %.4f", lat, lon))
    }

    private func applyLocation(lat: Double, lon: Double, label: String) {
        guard !disabled, let c = model.client else { return }
        working = true
        Task {
            defer { working = false }
            do {
                _ = try await c.send("POST", c.dev(device.id, "/location"), json: ["lat": lat, "lon": lon])
                route = nil
                statusMessage = "Location set to \(label)"
            } catch {
                model.fail("Couldn’t set location", error, device: device)
            }
        }
    }

    private func pickGpx() {
        let panel = NSOpenPanel()
        panel.title = "Choose a GPX Route"
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        if let gpxType = UTType(filenameExtension: "gpx") {
            panel.allowedContentTypes = [gpxType, .xml]
        }
        guard panel.runModal() == .OK, let url = panel.url, let c = model.client else { return }
        working = true
        Task {
            defer { working = false }
            do {
                let xml: String = try await Task.detached(priority: .userInitiated) {
                    let vals = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
                    guard vals.isRegularFile == true else {
                        throw APIError(status: 400, code: "bad_request", message: "Selected path is not a regular file.", hints: [], detail: nil)
                    }
                    if let sz = vals.fileSize, sz > 5 * 1024 * 1024 {
                        throw APIError(status: 400, code: "bad_request", message: "GPX file exceeds the 5 MB limit.", hints: [], detail: nil)
                    }
                    return try String(contentsOf: url, encoding: .utf8)
                }.value
                struct StartResp: Decodable { var route: LocationRouteState? }
                let data = try await c.send("POST", c.dev(device.id, "/location"), json: [
                    "gpx": xml,
                    "name": url.deletingPathExtension().lastPathComponent,
                    "speedMps": speedMps,
                    "loop": loopRoute,
                ])
                if let resp = try? JSONDecoder().decode(StartResp.self, from: data) {
                    route = resp.route
                }
                statusMessage = "Playing \(url.lastPathComponent)"
            } catch {
                model.fail("Couldn’t start GPX route", error, device: device)
            }
        }
    }

    private func stopRoute() {
        guard !disabled, let c = model.client else { return }
        working = true
        Task {
            defer { working = false }
            do {
                _ = try await c.send("DELETE", c.dev(device.id, "/location"))
                route = nil
                statusMessage = "Location route stopped"
            } catch {
                model.fail("Couldn’t stop location route", error, device: device)
            }
        }
    }
}

private struct PasscodeTrippedInfo: Decodable {
    var at: String
    var reason: String
}

private struct PasscodeUnlockInfo: Decodable {
    var at: String
    var ok: Bool
    var method: String?
    var error: String?
}

private struct PasscodeStatusResponse: Decodable {
    var supported: Bool
    var reason: String?
    var hasPasscode: Bool
    var enabled: Bool
    var storage: String?
    var savedAt: String?
    var tripped: PasscodeTrippedInfo?
    var lastUnlock: PasscodeUnlockInfo?
}

private struct UnlockActionResponse: Decodable {
    var ok: Bool
    var unlocked: Bool
    var alreadyUnlocked: Bool?
    var method: String?
}

/// Keychain-backed unattended passcode unlock controls inside Inspector › Device Settings.
/// Passcodes are written directly to the local daemon (stored in macOS Keychain) and never returned or exposed to agents.
private struct DevicePasscodeSection: View {
    @Environment(AppModel.self) private var model
    let device: Device
    @State private var status: PasscodeStatusResponse?
    @State private var loadFailed = false
    @State private var passcodeInput = ""
    @State private var working = false
    @State private var feedback: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.m) {
            SectionHeader("Unattended Unlock")
            VStack(alignment: .leading, spacing: Theme.Space.s) {
                if let status {
                    if !status.supported {
                        Text(status.reason ?? "Unattended passcode unlock isn’t supported on this device.")
                            .font(Theme.Fonts.callout)
                            .foregroundStyle(Theme.Ink.secondary)
                    } else {
                        if let tripped = status.tripped {
                            HStack(alignment: .top, spacing: Theme.Space.s) {
                                Image(systemName: "exclamationmark.triangle.fill")
                                    .foregroundStyle(Theme.Status.handoffStrong)
                                    .accessibilityHidden(true)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Paused after a failed unlock attempt")
                                        .font(Theme.Fonts.callout.weight(.semibold))
                                        .foregroundStyle(Theme.Status.handoffText)
                                    Text("Re-enter and save your passcode below to re-enable unattended unlock.")
                                        .font(Theme.Fonts.meta)
                                        .foregroundStyle(Theme.Ink.secondary)
                                        .help(tripped.reason)
                                }
                            }
                            .padding(Theme.Space.s)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Theme.Status.handoffTint, in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
                        }

                        HStack {
                            Text("Allow agent to unlock")
                            Spacer()
                            Toggle("Allow agent to unlock", isOn: Binding(
                                get: { status.enabled },
                                set: { setEnabled($0) }
                            ))
                            .labelsHidden()
                            .toggleStyle(.switch)
                            .controlSize(.small)
                            .disabled(working || !status.hasPasscode || status.tripped != nil)
                            .testAnchor("Allow agent to unlock")
                        }

                        HStack(spacing: Theme.Space.s) {
                            SecureField(status.hasPasscode ? "New passcode to update" : "Passcode or PIN", text: $passcodeInput)
                                .textFieldStyle(.roundedBorder)
                                .onSubmit { savePasscode() }
                                .testAnchor("Device passcode")
                            Button(status.hasPasscode ? "Update" : "Save") { savePasscode() }
                                .controlSize(.small)
                                .disabled(working || passcodeInput.isEmpty)
                                .testAnchor("Save passcode")
                        }

                        if status.hasPasscode {
                            HStack(spacing: Theme.Space.s) {
                                Label(
                                    status.storage == "keychain" ? "Saved in macOS Keychain" : "Saved locally",
                                    systemImage: "key.fill"
                                )
                                .font(Theme.Fonts.meta)
                                .foregroundStyle(Theme.Ink.secondary)
                                Spacer()
                                Button("Unlock Now") { unlockNow() }
                                    .controlSize(.small)
                                    .disabled(working || !device.isRunning || device.leasedByAgent || !status.enabled || status.tripped != nil)
                                    .testAnchor("Unlock Now")
                                Button("Remove", role: .destructive) { removePasscode() }
                                    .controlSize(.small)
                                    .disabled(working)
                                    .testAnchor("Remove passcode")
                            }
                        }

                        if let feedback {
                            Text(feedback)
                                .font(Theme.Fonts.meta)
                                .foregroundStyle(Theme.Ink.secondary)
                        } else if let last = status.lastUnlock {
                            Text(last.ok
                                ? "Last unlock succeeded\(last.method.map { " (\($0))" } ?? "")."
                                : "Last unlock failed: \(last.error ?? "unknown error")")
                                .font(Theme.Fonts.meta)
                                .foregroundStyle(Theme.Ink.secondary)
                        }

                        Text("Agents never see your passcode. Face ID, Touch ID, and purchases still wait for you.")
                            .font(Theme.Fonts.meta)
                            .foregroundStyle(Theme.Ink.tertiary)
                    }
                } else if loadFailed {
                    Button("Retry Unattended Unlock") { Task { await load() } }
                        .controlSize(.small)
                } else {
                    DelayedSpinner().frame(height: 28)
                }
            }
            .font(Theme.Fonts.callout)
            .padding(.horizontal, Theme.Space.l)
        }
        .task(id: "\(device.id):\(device.state):\(device.meta?["passcode"]?.description ?? "")") { await load() }
    }

    private func load() async {
        guard let c = model.client else { return }
        do {
            status = try await c.get(PasscodeStatusResponse.self, c.dev(device.id, "/passcode"), observe: true)
            loadFailed = false
        } catch {
            loadFailed = true
        }
    }

    private func savePasscode() {
        let secret = passcodeInput
        guard !secret.isEmpty, !working, let c = model.client else { return }
        let wasExisting = status?.hasPasscode == true
        let wasTripped = status?.tripped != nil
        let targetEnabled: Bool = wasExisting ? (wasTripped ? false : (status?.enabled ?? false)) : true
        working = true
        feedback = nil
        Task {
            defer { working = false }
            do {
                let data = try await c.send("PUT", c.dev(device.id, "/passcode"), json: ["passcode": secret, "enabled": targetEnabled])
                status = try JSONDecoder().decode(PasscodeStatusResponse.self, from: data)
                passcodeInput = ""
                if wasTripped {
                    feedback = "Passcode updated. Turn on \"Allow agent to unlock\" to re-enable."
                } else {
                    feedback = wasExisting ? "Passcode updated in macOS Keychain." : "Passcode saved in macOS Keychain."
                }
            } catch {
                model.fail("Couldn’t save passcode", error, device: device)
            }
        }
    }

    private func setEnabled(_ enabled: Bool) {
        guard !working, let c = model.client else { return }
        working = true
        feedback = nil
        Task {
            defer { working = false }
            do {
                let data = try await c.send("PUT", c.dev(device.id, "/passcode"), json: ["enabled": enabled])
                status = try JSONDecoder().decode(PasscodeStatusResponse.self, from: data)
                feedback = enabled ? "Unattended unlock turned on." : "Unattended unlock turned off."
            } catch {
                model.fail("Couldn’t update unattended unlock", error, device: device)
                await load()
            }
        }
    }

    private func removePasscode() {
        guard !working, let c = model.client else { return }
        working = true
        feedback = nil
        Task {
            defer { working = false }
            do {
                _ = try await c.send("DELETE", c.dev(device.id, "/passcode"))
                passcodeInput = ""
                await load()
                feedback = "Passcode removed."
            } catch {
                model.fail("Couldn’t remove passcode", error, device: device)
            }
        }
    }

    private func unlockNow() {
        guard !working, device.isRunning, let c = model.client else { return }
        working = true
        feedback = nil
        Task {
            defer { working = false }
            do {
                let data = try await c.send("POST", c.dev(device.id, "/unlock"), json: [:])
                let res = try? JSONDecoder().decode(UnlockActionResponse.self, from: data)
                feedback = res?.alreadyUnlocked == true ? "Device is already unlocked." : "Device unlocked."
                await load()
            } catch {
                model.fail("Couldn’t unlock device", error, device: device)
                await load()
            }
        }
    }
}
