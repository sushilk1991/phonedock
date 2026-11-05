import SwiftUI

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
                        }.pickerStyle(.segmented).testAnchor("Device appearance")
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
                        }.pickerStyle(.segmented).testAnchor("Color Filter")
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
        do { update(try await client.get(DeviceSettingsResponse.self, client.dev(device.id, "/settings"))); loadFailed = false }
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
