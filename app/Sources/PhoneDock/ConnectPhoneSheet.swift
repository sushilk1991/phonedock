import SwiftUI
import AppKit

/// Inline result of a connect step: working, succeeded, or a problem in the error pattern.
enum ConnectStatus: Equatable {
    case working(String)
    case ok(String)
    case failed(FriendlyError)
}

struct ConnectStatusView: View {
    let status: ConnectStatus
    var body: some View {
        switch status {
        case .working(let t):
            HStack(spacing: Theme.Space.s) {
                ProgressView().controlSize(.small)
                Text(t).font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
            }
        case .ok(let t):
            Label {
                Text(t).font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.primary)
            } icon: {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.Status.running)
            }
        case .failed(let p):
            ProblemView(problem: p)
        }
    }
}

/// True when Wi-Fi phones can't be reached because the attached service wasn't started by PhoneDock.app, so macOS
/// gives it no Local Network permission. Simulators, USB and the native iPhone tunnel are unaffected.
extension AppModel {
    var wifiBlocked: Bool {
        guard connection.isConnected, case .other = daemonOrigin else { return false }
        return true
    }

    var wifiBlockedProblem: FriendlyError {
        var details = "The PhoneDock service"
        if let pid = daemonPid { details += " (pid \(pid))" }
        if case .other(let path?) = daemonOrigin { details += " belongs to \(path)" }
        else { details += " was started from a terminal, or by an app that has quit" }
        details += ". macOS grants Local Network access to the app that started it, and only while that app runs."
        return FriendlyError(title: "Wi-Fi phones are blocked",
                             message: "PhoneDock’s background service was started outside the app, so macOS blocks it from your network.",
                             details: details)
    }
}

/// Reusable warning for Settings › Advanced (and anywhere Wi-Fi matters). Renders nothing unless Wi-Fi is blocked.
/// Restart Service asks for confirmation first and only ever runs on click.
struct LocalNetworkWarning: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if model.wifiBlocked {
            ProblemView(problem: model.wifiBlockedProblem, symbol: "wifi.exclamationmark",
                        retryTitle: model.restartingDaemon ? "Restarting…" : "Restart Service…",
                        retry: model.restartingDaemon ? nil : { model.restartDaemonFromApp() })
                .testAnchor("Restart Daemon from App")
        }
    }
}

/// Settings › Advanced › Wi-Fi phones › Check: opens a TCP connection from a process this app started, to tell a
/// missing Local Network permission apart from a wrong address.
// MARK: - Connect a Phone

struct ConnectPhoneSheet: View {
    enum Kind: String, CaseIterable, Identifiable {
        case iphone = "iPhone", android = "Android"
        var id: String { rawValue }
    }

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @AppStorage("connect.kind") private var kindRaw = Kind.iphone.rawValue

    // iPhone: nearby list (native, iOS 27+)
    @State private var discovered: [DiscoveredPhone]?
    @State private var discovering = false
    @State private var discoverProblem: FriendlyError?

    // iPhone: older iOS via WebDriverAgent
    @State private var showOlder = false
    @State private var wdaHost = ""
    @State private var wdaName = ""
    @State private var wdaUdid: String?
    @State private var wdaStatus: ConnectStatus?

    @State private var working = false

    private var kind: Kind { Kind(rawValue: kindRaw) ?? .iphone }
    private var kindBinding: Binding<Kind> { Binding(get: { kind }, set: { kindRaw = $0.rawValue }) }

    /// Wi-Fi matters for Android wireless debugging and for WebDriverAgent; the native iPhone path doesn't need it,
    /// so the problem appears only inside those two sections.
    @ViewBuilder private var wifiProblem: some View {
        if model.wifiBlocked {
            ProblemView(problem: model.wifiBlockedProblem, symbol: "wifi.exclamationmark",
                        retryTitle: model.restartingDaemon ? "Restarting…" : "Restart Service…",
                        retry: model.restartingDaemon ? nil : { model.restartDaemonFromApp() })
                .testAnchor("Restart Daemon from App")
        }
    }

    /// Nearby iPhones worth showing: Bonjour also reports unnamed services (MAC/IPv6 strings, UUIDs) — hide those,
    /// and list each phone once.
    private var nearbyPhones: [DiscoveredPhone] {
        var seen = Set<String>()
        // Self-test screenshots that hide real phones hide them here too (every phone found nearby is a real one).
        if AppModel.selfTestHidden.contains(where: { "ios-device:".hasPrefix($0) || $0.hasPrefix("ios-device") }) { return [] }
        return (discovered ?? []).filter { p in
            guard !Self.looksLikeIdentifier(p.name) else { return false }
            return seen.insert(p.deviceId ?? p.udid ?? p.name).inserted
        }
    }

    static func looksLikeIdentifier(_ name: String) -> Bool {
        let n = name.trimmingCharacters(in: .whitespaces)
        if n.isEmpty || UUID(uuidString: n) != nil || n.contains("@") || n.contains("supportsRP") { return true }
        let hexish = CharacterSet(charactersIn: "0123456789abcdefABCDEF:-.")
        return n.count >= 12 && n.unicodeScalars.allSatisfy { hexish.contains($0) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text("Connect a Phone").font(Theme.Fonts.title).foregroundStyle(Theme.Ink.primary)
                Spacer()
                Picker("Phone", selection: kindBinding) {
                    ForEach(Kind.allCases) { k in Text(k.rawValue).tag(k) }
                }
                .pdSegmented()
                .labelsHidden()
                .fixedSize()
                .testAnchor("Phone kind")
            }
            .padding(.bottom, Theme.Space.l)
            Group {
                switch kind {
                case .iphone: iphone
                case .android: AndroidWirelessView()
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            HStack {
                if let doc = DaemonLocator.iphoneWifiDoc, kind == .iphone {
                    Link(destination: doc) { Label("Setup Guide", systemImage: "book") }
                        .font(Theme.Fonts.callout)
                        .foregroundStyle(Theme.Accent.text)
                        .help("How to set up a real iPhone")
                }
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction).testAnchor("Close Connect Sheet")
            }
            .padding(.top, Theme.Space.l)
        }
        .padding(Theme.Space.xxl)
        .frame(width: 520)
        .environment(\.pdProblemFullWidth, true)   // every card spans the column: one right edge
        .fixedSize(horizontal: false, vertical: true)   // height fits the content
        .task { if discovered == nil { discover() } }
    }

    // MARK: iPhone

    private var iphone: some View {
        VStack(alignment: .leading, spacing: Theme.Space.l) {
            HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s) {
                Text("iPhones on iOS 27 or later connect directly, over USB or Wi-Fi.")
                    .font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                BetaBadge()
            }
            VStack(alignment: .leading, spacing: Theme.Space.s) {
                step(1, "Turn on Developer Mode", "Settings › Privacy & Security › Developer Mode")
                step(2, "Pair it with this Mac once", "Plug it in and tap Trust, or pair it in Xcode › Devices and Simulators.")
                step(3, "Allow control", "Settings › Developer › Enable UI Automation")
            }
            nearby
            olderIphone
        }
    }

    private func step(_ n: Int, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Space.m) {
            Text("\(n)")
                .font(Theme.Fonts.caption.weight(.semibold).monospacedDigit())
                .foregroundStyle(Theme.Ink.secondary)
                .frame(width: 16, height: 16)
                .background(Theme.Line.card, in: Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(Theme.Fonts.body).foregroundStyle(Theme.Ink.primary)
                Text(detail).font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var nearby: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            HStack {
                Text("Nearby iPhones").font(Theme.Fonts.headline).foregroundStyle(Theme.Ink.primary)
                Spacer()
                if discovering {
                    ProgressView().controlSize(.small)
                } else {
                    Button { discover() } label: { Label("Scan Again", systemImage: "arrow.clockwise") }
                        .buttonStyle(.borderless)
                        .labelStyle(.iconOnly)
                        .help("Scan Again")
                        .testAnchor("Discover")
                }
            }
            if let p = discoverProblem {
                ProblemView(problem: p, retry: { discover() })
            } else if discovering && nearbyPhones.isEmpty {
                Text("Looking for iPhones…").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary).testAnchor("Scanning")
            } else if !nearbyPhones.isEmpty {
                phoneList(nearbyPhones)
            } else if discovered != nil {
                Text("No iPhones found. Pair one with this Mac, then scan again.")
                    .font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
            }
        }
    }

    private func phoneList(_ list: [DiscoveredPhone]) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(list.enumerated()), id: \.element.id) { i, p in
                if i > 0 { Divider().padding(.leading, 36) }
                let inSidebar = p.deviceId.flatMap { id in model.devices.first { $0.id == id } }
                HStack(spacing: Theme.Space.m) {
                    Image(systemName: "iphone").font(.system(size: 15)).foregroundStyle(Theme.Ink.secondary).frame(width: 20)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(p.name).font(Theme.Fonts.body).foregroundStyle(Theme.Ink.primary).lineLimit(1)
                        Text(inSidebar != nil ? "Paired · in the sidebar" : p.source == "devicectl" ? "Paired" : "Not paired yet")
                            .font(Theme.Fonts.meta).foregroundStyle(Theme.Ink.secondary).lineLimit(1)
                    }
                    Spacer(minLength: Theme.Space.s)
                    if let d = inSidebar {
                        Button("Show") { model.selection = d.id; dismiss() }
                            .controlSize(.small)
                            .help("Select \(d.name) in the sidebar")
                    }
                }
                .padding(.horizontal, Theme.Space.m)
                .padding(.vertical, Theme.Space.s)
                .help(inSidebar == nil && p.source != "devicectl" ? "Pair it once over USB or in Xcode › Devices and Simulators." : "")
                .accessibilityElement(children: .combine)
                .testAnchor("discovered-\(i)")
            }
        }
        .background(Theme.Surface.content, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous).strokeBorder(Theme.Line.separator, lineWidth: 1))
    }

    private var olderIphone: some View {
        DisclosureRow(title: "Older iPhone?", detail: "iOS 26 or earlier", isExpanded: $showOlder, anchor: "Older iPhone") {
            VStack(alignment: .leading, spacing: Theme.Space.s) {
                wifiProblem
                Text("Older iPhones need WebDriverAgent running on the phone. Set it up once over USB.")
                    .font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: Theme.Space.s) {
                    TextField("IP address or WebDriverAgent URL", text: $wdaHost)
                        .onSubmit(connectWda)
                        .accessibilityLabel("iPhone address")
                        .testAnchor("iPhone address")
                    TextField("Name (optional)", text: $wdaName).frame(width: 130)
                        .accessibilityLabel("iPhone name")
                        .testAnchor("iPhone name")
                    let fillable = nearbyPhones.filter { $0.host != nil }
                    if !fillable.isEmpty {
                        Menu {
                            ForEach(fillable) { p in Button(p.name) { fill(p) } }
                        } label: { Image(systemName: "iphone.radiowaves.left.and.right") }
                            .menuStyle(.borderlessButton)
                            .menuIndicator(.hidden)
                            .fixedSize()
                            .help("Fill in from a nearby iPhone")
                            .accessibilityLabel("Fill In From Nearby iPhone")
                    }
                    Button("Connect", action: connectWda)
                        .disabled(wdaHost.trimmingCharacters(in: .whitespaces).isEmpty || working)
                        .accessibilityLabel("Connect iPhone")
                        .testAnchor("Connect iPhone")
                }
                .textFieldStyle(.roundedBorder)
                if let wdaStatus { ConnectStatusView(status: wdaStatus).testAnchor("ios-status") }
            }
        }
    }

    private func fill(_ p: DiscoveredPhone) {
        if let h = p.host { wdaHost = Self.stripLocalSuffix(h) }
        if wdaName.isEmpty { wdaName = p.name }
        wdaUdid = p.udid
        wdaStatus = nil
    }

    /// Bonjour hosts look like "Johns-iPhone.local." — keep them usable as an address.
    static func stripLocalSuffix(_ h: String) -> String { h.hasSuffix(".") ? String(h.dropLast()) : h }

    /// "http://192.168.1.20:8100" → "192.168.1.20"; "192.168.1.20:5555" → "192.168.1.20".
    static func hostOnly(_ s: String) -> String {
        var t = s.trimmingCharacters(in: .whitespaces)
        if let r = t.range(of: "://") { t = String(t[r.upperBound...]) }
        if let slash = t.firstIndex(of: "/") { t = String(t[..<slash]) }
        if t.filter({ $0 == ":" }).count == 1, let colon = t.lastIndex(of: ":") { t = String(t[..<colon]) }
        return t
    }

    private func discover() {
        guard let c = model.client else {
            discoverProblem = FriendlyError(title: "PhoneDock isn’t connected", message: "It reconnects automatically.")
            return
        }
        discovering = true; discoverProblem = nil
        Task {
            defer { discovering = false }
            do { discovered = try await c.get([DiscoveredPhone].self, "/v1/ios/discover", timeout: 30) }
            catch { discovered = nil; discoverProblem = FriendlyError.from(error, title: "Couldn’t look for iPhones") }
        }
    }

    private func connectWda() {
        let target = wdaHost.trimmingCharacters(in: .whitespaces)
        guard !target.isEmpty, !working else { return }
        guard let c = model.client else {
            wdaStatus = .failed(FriendlyError(title: "PhoneDock isn’t connected", message: "It reconnects automatically."))
            return
        }
        var body: [String: Any] = ["platform": "ios"]
        if target.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil { body["wdaUrl"] = target } else { body["address"] = target }
        let name = wdaName.trimmingCharacters(in: .whitespaces)
        if !name.isEmpty { body["name"] = name }
        if let u = wdaUdid { body["udid"] = u }
        let host = Self.hostOnly(target)
        working = true
        wdaStatus = .working("Connecting to \(host)…")
        Task {
            defer { working = false }
            do {
                let data = try await c.send("POST", "/v1/connect", json: body, timeout: 60)
                let r = try? JSONDecoder().decode(ConnectResult.self, from: data)
                await model.refresh()
                wdaStatus = .ok("Connected to \(r?.device?.name ?? (name.isEmpty ? host : name))")
                if let d = r?.device {
                    try? await Task.sleep(for: .seconds(1))
                    model.selection = d.id
                    dismiss()
                }
            } catch {
                wdaStatus = .failed(Self.problem(error, title: "Couldn’t connect to \(host)", host: host))
            }
        }
    }

    /// Error pattern with the connect-specific codes; raw text stays under Details.
    static func problem(_ error: Error, title: String, host: String) -> FriendlyError {
        var p = FriendlyError.from(error, title: title)
        guard let e = error as? APIError else { return p }
        switch e.code {
        case "wda_unreachable":
            p.title = "Can’t reach WebDriverAgent on \(host)"
            p.message = "Make sure it’s running on the iPhone and both are on the same Wi-Fi."
        case "local_network_denied":
            p.title = "Can’t reach \(host)"
            p.message = "Allow PhoneDock in System Settings › Privacy & Security › Local Network, and check the phone is on the same Wi-Fi."
        case "ddi_missing":
            p.title = "This iPhone needs developer setup"
            p.message = "Connect it and open Xcode › Devices and Simulators once."
        default:
            if e.message.contains("EHOSTUNREACH") {
                p.title = "Can’t reach \(host)"
                p.message = "Allow PhoneDock in System Settings › Privacy & Security › Local Network, and check the phone is on the same Wi-Fi."
            }
        }
        return p
    }
}

/// "Beta" label for real iPhones (DECISIONS #8).
struct BetaBadge: View {
    var label = "Beta"
    var body: some View {
        Text(label)
            .font(Theme.Fonts.caption.weight(.semibold))
            .foregroundStyle(Theme.Accent.text)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.badge, style: .continuous).strokeBorder(Theme.Accent.text.opacity(0.6), lineWidth: 1))
            .accessibilityLabel(label)
    }
}
