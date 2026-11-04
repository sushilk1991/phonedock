import SwiftUI
import AppKit
import CoreImage.CIFilterBuiltins

/// An Android phone found on the Wi-Fi (`GET /v1/android/discover`).
struct AndroidPhone: Codable, Hashable, Identifiable, Sendable {
    var serial: String
    var model: String?
    var host: String?
    var ip: String?
    /// Advertised while Wireless debugging is on.
    var connectPort: Int?
    /// Advertised only while the phone's pairing screen is open.
    var pairingPort: Int?
    var connected: Bool
    var id: String { serial }
    var title: String { model ?? "Android phone" }
}

/// Self-test only: `PHONEDOCK_APP_FAKE_ANDROID_DISCOVERY=<json file>` replaces discovery, pairing and connecting with a canned
/// answer, so the sheet's states can be captured without a phone. The file is read again on every poll:
/// `{"phones":[{"serial":"A1","model":"Pixel 8","ip":"192.168.1.30","pairingPort":41000,"connected":false}],
///   "pairError":{"code":"adb_blocked_local_network","message":"…","hints":["…"],"detail":"…"},"restartFixes":true}`
struct FakeAndroidDiscovery: Decodable {
    struct Failure: Decodable { var code: String; var message: String; var hints: [String]?; var detail: String? }
    var phones: [AndroidPhone] = []
    var pairError: Failure?
    var restartFixes: Bool?

    @MainActor static func load() -> FakeAndroidDiscovery? {
        guard SelfTest.enabled, let path = ProcessInfo.processInfo.environment["PHONEDOCK_APP_FAKE_ANDROID_DISCOVERY"], !path.isEmpty,
              let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return nil }
        return try? JSONDecoder().decode(FakeAndroidDiscovery.self, from: data)
    }

    /// What pairing or connecting does under the fake: fails with `pairError` until the user restarts adb.
    func respond(restart: Bool) async throws -> Data {
        try? await Task.sleep(for: .milliseconds(700))
        if let f = pairError, !(restart && restartFixes != false) {
            throw APIError(status: 502, code: f.code, message: f.message, hints: f.hints ?? [], detail: f.detail)
        }
        return Data("{\"ok\":true}".utf8)
    }
}

/// Android over Wi-Fi: phones with Wireless debugging appear by themselves; type the code shown on the phone.
struct AndroidWirelessView: View {
    private struct Result {
        var status: ConnectStatus
        /// Set when macOS blocks the shared adb server: restarting it and trying again.
        var restart: (() -> Void)? = nil
        /// Set when macOS denied PhoneDock the local network: Open Privacy Settings, then Try Again.
        var again: (() -> Void)? = nil
    }

    /// System Settings › Privacy & Security › Local Network.
    static func openLocalNetworkSettings() {
        guard !SelfTest.blocksForeground("open System Settings › Local Network"),
              let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork") else { return }
        NSWorkspace.shared.open(url)
    }

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var phones: [AndroidPhone]?
    @State private var scanning = false
    @State private var scanProblem: FriendlyError?
    @State private var codes: [String: String] = [:]
    @State private var results: [String: Result] = [:]
    @State private var working = false

    // QR
    @State private var showQR = false
    @State private var qr: (name: String, password: String)?
    @State private var qrPaired = false

    // Typed address
    @State private var showAddress = false
    @State private var pairAddress = ""
    @State private var pairCode = ""
    @State private var address = ""

    private var polling: Bool { !working }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.xl) {
            VStack(alignment: .leading, spacing: Theme.Space.xs) {
                Text("USB").font(Theme.Fonts.headline).foregroundStyle(Theme.Ink.primary)
                Text("Plug it in and tap Allow on the phone. It appears in the sidebar automatically.")
                    .font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: Theme.Space.l) {
                wifiProblem
                VStack(alignment: .leading, spacing: Theme.Space.xs) {
                    HStack {
                        Text("Wi-Fi").font(Theme.Fonts.headline).foregroundStyle(Theme.Ink.primary)
                        Spacer()
                        if scanning, phones?.isEmpty ?? true { ProgressView().controlSize(.small).testAnchor("Scanning phones") }
                    }
                    Text("On the phone: Settings › Developer options › Wireless debugging › Pair device with pairing code")
                        .font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .testAnchor("Pairing instructions")
                }
                list
                disclosure("Use a QR code instead", isOn: $showQR, anchor: "QR code") { qrBody }
                disclosure("Enter an address", isOn: $showAddress, anchor: "Enter an address") { addressBody }
            }
        }
        .task { await pollLoop() }
        .onChange(of: showQR) { _, on in
            if on { qr = qr ?? Self.newQR(); qrPaired = false }
        }
    }

    @ViewBuilder private var wifiProblem: some View {
        if model.wifiBlocked, FakeAndroidDiscovery.load() == nil {   // (a faked self-test run has no real service to blame)
            ProblemView(problem: model.wifiBlockedProblem, symbol: "wifi.exclamationmark",
                        retryTitle: model.restartingDaemon ? "Restarting…" : "Restart Service…",
                        retry: model.restartingDaemon ? nil : { model.restartDaemonFromApp() })
                .testAnchor("Restart Daemon from App")
        }
    }

    // MARK: Discovery

    private func pollLoop() async {
        while !Task.isCancelled {
            if polling { await refreshPhones() }
            try? await Task.sleep(for: .seconds(2))
        }
    }

    private func refreshPhones() async {
        scanning = true
        defer { scanning = false }
        if let fake = FakeAndroidDiscovery.load() {
            try? await Task.sleep(for: .milliseconds(400))
            phones = fake.phones; scanProblem = nil
            return
        }
        guard let c = model.client else { return }
        do {
            let list = try await c.get([AndroidPhone].self, "/v1/android/discover", timeout: 30)
            phones = list; scanProblem = nil
        } catch {
            if phones == nil { scanProblem = FriendlyError.from(error, title: "Couldn’t look for phones") }
        }
        if let qr, showQR, !qrPaired, !working, let p = phones?.first(where: { $0.serial == qr.name && $0.pairingPort != nil }) {
            qrPaired = true
            pair(code: qr.password, phone: p, key: "qr")
        }
    }

    // MARK: Rows

    @ViewBuilder private var list: some View {
        if let scanProblem {
            ProblemView(problem: scanProblem, retry: { Task { await refreshPhones() } })
        } else if let phones, !phones.isEmpty {
            VStack(spacing: 0) {
                ForEach(Array(phones.enumerated()), id: \.element.id) { i, p in
                    if i > 0 { Divider().padding(.leading, 36) }
                    row(p).testAnchor("android-phone-\(i)")
                }
            }
            .background(Theme.Surface.content, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous).strokeBorder(Theme.Line.separator, lineWidth: 1))
        } else {
            Text(phones == nil ? "Looking for phones…" : "No phones found yet. Turn on Wireless debugging on the phone, on the same Wi-Fi as this Mac.")
                .font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .testAnchor("No phones")
        }
    }

    private func sidebarDevice(_ p: AndroidPhone) -> Device? {
        model.devices.first { d in
            d.backend == "android-device" && d.state == "running" && (d.nativeId.map { $0 == p.serial || $0.hasPrefix("adb-\(p.serial)-") || (p.ip != nil && $0.hasPrefix("\(p.ip!):")) } ?? false)
        }
    }

    /// Paired or connected from this row just now (the next scan may not have caught up yet).
    private func succeeded(_ key: String) -> Bool {
        if case .ok? = results[key]?.status { return true }
        return false
    }

    private func subtitle(_ p: AndroidPhone) -> String {
        let state = p.connected || succeeded(p.serial) ? "Connected" : p.pairingPort != nil ? "Ready to pair" : "Wireless debugging is on"
        return [p.ip, state].compactMap { $0 }.joined(separator: " · ")
    }

    private func row(_ p: AndroidPhone) -> some View {
        let key = p.serial
        let code = Binding(get: { codes[key] ?? "" }, set: { codes[key] = String($0.filter(\.isNumber).prefix(6)) })
        // Once it worked, the row says so and offers Show: no code field or Pair left to contradict it.
        let connected = p.connected || succeeded(key)
        return VStack(alignment: .leading, spacing: Theme.Space.s) {
            HStack(spacing: Theme.Space.m) {
                Image(systemName: "smartphone").font(.system(size: 15)).foregroundStyle(Theme.Ink.secondary).frame(width: 20)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text(p.title).font(Theme.Fonts.body).foregroundStyle(Theme.Ink.primary).lineLimit(1)
                    Text(subtitle(p)).font(Theme.Fonts.meta).foregroundStyle(Theme.Ink.secondary).lineLimit(1)
                }
                Spacer(minLength: Theme.Space.s)
                if connected {
                    if let d = sidebarDevice(p) {
                        Button("Show") { model.selection = d.id; dismiss() }
                    }
                } else if p.pairingPort != nil {
                    TextField("Pairing code", text: code)
                        .textFieldStyle(.roundedBorder)
                        .font(Theme.Fonts.numeric)
                        .frame(width: 110)
                        .onSubmit { pair(code: code.wrappedValue, phone: p, key: key) }
                        .accessibilityLabel("Pairing code for \(p.title)")
                        .testAnchor("Pairing code \(key)")
                    Button("Pair") { pair(code: code.wrappedValue, phone: p, key: key) }
                        .disabled(code.wrappedValue.count != 6 || working)
                        .accessibilityLabel("Pair \(p.title)")
                        .testAnchor("Pair \(key)")
                } else {
                    Button("Connect") { connect(p, key: key) }
                        .disabled(working || p.connectPort == nil)
                        .accessibilityLabel("Connect \(p.title)")
                        .testAnchor("Connect \(key)")
                }
            }
            if let r = results[key] {
                resultView(r).padding(.leading, 20 + Theme.Space.m).testAnchor("android-status-\(key)")
            }
        }
        .padding(.horizontal, Theme.Space.m)
        .padding(.vertical, Theme.Space.s)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private func resultView(_ r: Result) -> some View {
        if case .failed(let p) = r.status {
            ProblemView(problem: p, symbol: r.restart != nil || r.again != nil ? "wifi.exclamationmark" : "exclamationmark.triangle.fill",
                        retryTitle: r.restart != nil ? "Restart adb and Try Again" : "Try Again", retry: r.restart ?? r.again,
                        otherTitle: r.again != nil ? "Open Privacy Settings" : nil,
                        other: r.again != nil ? { Self.openLocalNetworkSettings() } : nil)
        } else {
            ConnectStatusView(status: r.status)
        }
    }

    // MARK: Actions

    private func pair(code: String, phone p: AndroidPhone, key: String, restart: Bool = false) {
        guard code.count == 6, !working else { return }
        let name = p.title
        perform(key, working: "Pairing with \(name)…", failTitle: "Couldn’t pair with \(name)", host: p.ip ?? name,
                retry: { pair(code: code, phone: p, key: key, restart: true) }, restart: restart) { restart in
            var body: [String: Any] = ["code": code, "serial": p.serial]
            if restart { body["restartAdb"] = true }
            return try await send("/v1/pair", body, restart: restart)
        }
    }

    private func connect(_ p: AndroidPhone, key: String, restart: Bool = false) {
        guard !working else { return }
        let name = p.title
        perform(key, working: "Connecting to \(name)…", failTitle: "Couldn’t connect to \(name)", host: p.ip ?? name,
                retry: { connect(p, key: key, restart: true) }, restart: restart) { restart in
            var body: [String: Any] = ["serial": p.serial]
            if restart { body["restartAdb"] = true }
            return try await send("/v1/connect", body, restart: restart)
        }
    }

    private func send(_ path: String, _ body: [String: Any], restart: Bool) async throws -> Data {
        if let fake = FakeAndroidDiscovery.load() { return try await fake.respond(restart: restart) }
        guard let c = model.client else { throw APIError(status: 0, code: "no_daemon", message: "PhoneDock isn’t connected") }
        return try await c.send("POST", path, json: body, timeout: 120)
    }

    private func perform(_ key: String, working text: String, failTitle: String, host: String, retry: @escaping () -> Void, restart: Bool, okMessage: String? = nil,
                         request: @escaping (Bool) async throws -> Data) {
        working = true
        results[key] = Result(status: .working(restart ? "Restarting adb…" : text))
        Task {
            defer { working = false }
            do {
                let data = try await request(restart)
                let r = try? JSONDecoder().decode(ConnectResult.self, from: data)
                await model.refresh()
                results[key] = Result(status: .ok(r?.device == nil && okMessage != nil ? okMessage! : "Connected to \(r?.device?.name ?? host)"))
                if let d = r?.device {
                    try? await Task.sleep(for: .seconds(1))
                    model.selection = d.id
                    dismiss()
                }
            } catch {
                let (problem, blocked) = Self.problem(error, title: failTitle, host: host)
                let denied = (error as? APIError)?.code == "local_network_denied"
                let again = { perform(key, working: text, failTitle: failTitle, host: host, retry: retry, restart: false, okMessage: okMessage, request: request) }
                results[key] = Result(status: .failed(problem), restart: blocked && !restart ? retry : nil, again: denied ? again : nil)
                if key == "qr" { qrPaired = false }
            }
        }
    }

    /// Friendly text for the Wi-Fi failures the daemon explains; the second value is true when restarting adb is the fix.
    static func problem(_ error: Error, title: String, host: String) -> (FriendlyError, Bool) {
        var p = ConnectPhoneSheet.problem(error, title: title, host: host)
        guard let e = error as? APIError else { return (p, false) }
        switch e.code {
        case "adb_blocked_local_network":
            p.title = "Can’t reach \(host)"
            p.message = "macOS is stopping adb, the tool PhoneDock uses for Android, from reaching your network, although PhoneDock itself is allowed. Restarting adb fixes it. It briefly disconnects other tools that use adb, such as Android Studio."
            return (p, true)
        case "local_network_denied":
            p.title = "Can’t reach \(host)"
            p.message = (e.hints.first ?? "Allow PhoneDock in System Settings › Privacy & Security › Local Network") + ", then try again."
            return (p, false)
        case "no_pairing_service":
            p.title = "The pairing screen closed"
            p.message = "On the phone, open Wireless debugging › Pair device with pairing code and keep it open."
        case "pair_failed":
            p.message = "Check the six-digit code on the phone. It changes each time the pairing screen opens."
        case "ambiguous_phone":
            p.message = "More than one phone is ready. Use the row of the phone you want."
        default: break
        }
        return (p, false)
    }

    // MARK: Disclosures

    private func disclosure<Content: View>(_ title: String, isOn: Binding<Bool>, anchor: String, @ViewBuilder content: @escaping () -> Content) -> some View {
        DisclosureRow(title: title, isExpanded: isOn, anchor: anchor, content: content)
    }

    // MARK: QR

    static func newQR() -> (name: String, password: String) {
        let letters = Array("abcdefghjkmnpqrstuvwxyz")
        let name = "pd-" + String((0..<6).map { _ in letters.randomElement()! })
        let password = String((0..<6).map { _ in Character(String(Int.random(in: 0...9))) })
        return (name, password)
    }

    static func qrImage(_ text: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let out = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)) else { return nil }
        let rep = NSCIImageRep(ciImage: out)
        let img = NSImage(size: rep.size)
        img.addRepresentation(rep)
        return img
    }

    @ViewBuilder private var qrBody: some View {
        if let qr, let img = Self.qrImage("WIFI:T:ADB;S:\(qr.name);P:\(qr.password);;") {
            HStack(alignment: .top, spacing: Theme.Space.xl) {
                Image(nsImage: img)
                    .interpolation(.none)
                    .resizable()
                    .frame(width: 132, height: 132)
                    .padding(Theme.Space.m)
                    .background(Color.white, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous).strokeBorder(Theme.Line.separator, lineWidth: 1))
                    .accessibilityLabel("Pairing QR code")
                    .testAnchor("QR image")
                VStack(alignment: .leading, spacing: Theme.Space.s) {
                    Text("Scan it from Wireless debugging › Pair device with QR code, not the camera app.")
                        .font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("Some phones can’t scan it. Use the pairing code above instead.")
                        .font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let r = results["qr"] { resultView(r) }
                }
            }
        }
    }

    // MARK: Typed address

    private var addressBody: some View {
        VStack(alignment: .leading, spacing: Theme.Space.l) {
            VStack(alignment: .leading, spacing: Theme.Space.s) {
                Text("Pair (first time only)").font(Theme.Fonts.callout.weight(.medium)).foregroundStyle(Theme.Ink.primary)
                HStack(spacing: Theme.Space.s) {
                    TextField("IP address & port", text: $pairAddress).frame(width: 190)
                        .accessibilityLabel("Pairing address")
                    TextField("Pairing code", text: $pairCode).frame(width: 100)
                        .accessibilityLabel("Pairing code")
                    Button("Pair") { pairAddressed() }
                        .disabled(pairAddress.trimmingCharacters(in: .whitespaces).isEmpty || pairCode.trimmingCharacters(in: .whitespaces).isEmpty || working)
                }
                .textFieldStyle(.roundedBorder)
                if let r = results["pair-address"] { resultView(r) }
            }
            VStack(alignment: .leading, spacing: Theme.Space.s) {
                Text("Connect").font(Theme.Fonts.callout.weight(.medium)).foregroundStyle(Theme.Ink.primary)
                HStack(spacing: Theme.Space.s) {
                    TextField("IP address & port", text: $address).frame(width: 190)
                        .onSubmit { connectAddressed() }
                        .accessibilityLabel("Phone address")
                    Button("Connect") { connectAddressed() }
                        .disabled(address.trimmingCharacters(in: .whitespaces).isEmpty || working)
                }
                .textFieldStyle(.roundedBorder)
                if let r = results["connect-address"] { resultView(r) }
            }
        }
    }

    private func pairAddressed(restart: Bool = false) {
        let a = pairAddress.trimmingCharacters(in: .whitespaces), code = pairCode.trimmingCharacters(in: .whitespaces)
        guard !working else { return }
        let host = ConnectPhoneSheet.hostOnly(a)
        perform("pair-address", working: "Pairing with \(host)…", failTitle: "Couldn’t pair with \(host)", host: host,
                retry: { pairAddressed(restart: true) }, restart: restart, okMessage: "Paired with \(host). Now connect.") { restart in
            var body: [String: Any] = ["address": a, "code": code]
            if restart { body["restartAdb"] = true }
            let data = try await send("/v1/pair", body, restart: restart)
            await MainActor.run { if address.isEmpty { address = host + ":" } }
            return data
        }
    }

    private func connectAddressed(restart: Bool = false) {
        let a = address.trimmingCharacters(in: .whitespaces)
        guard !a.isEmpty, !working else { return }
        let host = ConnectPhoneSheet.hostOnly(a)
        perform("connect-address", working: "Connecting to \(host)…", failTitle: "Couldn’t connect to \(host)", host: host,
                retry: { connectAddressed(restart: true) }, restart: restart) { restart in
            var body: [String: Any] = ["address": a]
            if restart { body["restartAdb"] = true }
            return try await send("/v1/connect", body, restart: restart)
        }
    }
}
