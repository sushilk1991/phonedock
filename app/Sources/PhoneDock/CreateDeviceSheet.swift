import SwiftUI

enum PlatformChoice: String, CaseIterable, Identifiable {
    case android = "Android", ios = "iOS", other = "Other"
    var id: String { rawValue }
    func matches(_ p: String) -> Bool {
        switch self {
        case .android: return p == "android"
        case .ios: return p == "ios"
        case .other: return p == "linux" || p == "other"
        }
    }
    var symbol: String {
        switch self { case .android: return "smartphone"; case .ios: return "iphone"; case .other: return "terminal" }
    }
    /// What to install when no backend for this platform works.
    var installHint: String {
        switch self {
        case .android: return "Install Android Studio or the command-line tools, then reopen this window."
        case .ios: return "Install Xcode, then reopen this window."
        case .other: return "Install QEMU, then reopen this window."
        }
    }
}

/// New Device (§8.6): width 520, height fits the content. Hardware fields live under Advanced, which is absent for
/// backends that pick hardware themselves (iOS Simulator, cloud). Unavailable backends never appear.
struct CreateDeviceSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @AppStorage("create.platform") private var platformRaw = PlatformChoice.android.rawValue

    @State private var backendId: String?
    @State private var images: [OsImage] = []
    @State private var profiles: [HardwareProfile] = []
    @State private var imageId: String?
    @State private var profileId: String?
    @State private var name = ""
    @State private var nameEdited = false
    @State private var cpus = 4
    @State private var ramMB = 4096
    @State private var storageMB = 8192
    @State private var width = 1080
    @State private var height = 2400
    @State private var dpi = 420
    @State private var bootAfter = true
    @State private var autoStart = false
    @State private var showAdvanced = false
    @State private var showOlder = false
    @State private var loadingLists = false
    /// The backend whose models and versions have arrived (nil until the first load ends).
    @State private var listsLoadedFor: String?
    @State private var downloadJob: Job?
    @State private var problem: FriendlyError?
    @FocusState private var nameFocused: Bool

    private var platform: PlatformChoice {
        get { PlatformChoice(rawValue: platformRaw) ?? .android }
    }
    private var platformBinding: Binding<PlatformChoice> {
        Binding(get: { platform }, set: { platformRaw = $0.rawValue })
    }

    /// Platforms offered: Android and iOS always (they explain themselves when missing); Other only if it works.
    private var platforms: [PlatformChoice] {
        PlatformChoice.allCases.filter { p in
            p != .other || model.backends.contains { p.matches($0.platform) && $0.kind != "physical" && $0.isAvailable }
        }
    }
    private var candidates: [BackendInfo] { model.backends.filter { platform.matches($0.platform) && $0.kind != "physical" } }
    private var backends: [BackendInfo] { candidates.filter(\.isAvailable) }
    private var backend: BackendInfo? { backends.first { $0.id == backendId } }
    private var image: OsImage? { images.first { $0.id == imageId } }
    /// Models the chosen version can run (an iOS runtime lists its device types; others run everything).
    private var visibleProfiles: [HardwareProfile] {
        guard let allowed = image?.profiles, !allowed.isEmpty else { return profiles }
        let shown = profiles.filter { allowed.contains($0.id) }
        return shown.isEmpty ? profiles : shown
    }
    private var ignoresHardware: Bool { backend?.id == "ios-simulator" || backend?.kind == "cloud" }
    private var hasAdvanced: Bool { backend != nil && (!ignoresHardware || backends.count > 1) }
    private var creating: Bool { false }
    private var downloading: Bool { downloadJob.map { !$0.isFinished } ?? false }
    private var trimmedName: String { name.trimmingCharacters(in: .whitespaces) }
    private var canCreate: Bool {
        !creating && backend != nil && !trimmedName.isEmpty && (images.isEmpty || (image?.installed == true && image?.isUsable == true))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("New Device")
                .font(Theme.Fonts.title)
                .foregroundStyle(Theme.Ink.primary)
                .padding(.bottom, Theme.Space.xl)
            Form {
                Picker(selection: platformBinding) {
                    ForEach(platforms) { p in Text(p.rawValue).tag(p) }
                } label: {
                    // The label column is as wide as its widest label. Reserve Advanced's widest ("CPU cores") from
                    // the start, so opening Advanced doesn't shift every field to the right.
                    ZStack(alignment: .trailing) {
                        Text("CPU cores").hidden().accessibilityHidden(true)
                        Text("Platform")
                    }
                }
                .pdSegmented()
                .fixedSize()
                .testAnchor("Platform")
                if !model.backends.isEmpty && backend == nil {
                    unavailable
                } else {
                    // While the lists load, the same rows stand in (disabled, "Loading…"), so the sheet keeps its
                    // size and nothing jumps when they arrive.
                    fields
                }
            }
            .formStyle(.columns)
            .disabled(creating)
            if let problem {
                ProblemView(problem: problem)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, Theme.Space.l)
                    .testAnchor("create-problem")
            }
            footer.padding(.top, Theme.Space.xl)
        }
        .padding(Theme.Space.xxl)
        .frame(width: 520)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxHeight: 640)
        .task { if model.backends.isEmpty { await model.loadBackends() }; pickBackend() }
        .onChange(of: platformRaw) {
            problem = nil
            profiles = []; images = []; profileId = nil; imageId = nil   // the old platform's models must not name the new device
            pickBackend()
            suggestName()   // the name follows the platform at once (unless it was typed)
        }
        .onChange(of: model.backends) { pickBackend() }
        .onChange(of: backendId) { Task { await loadLists() } }
        // Name is the field people change: focus it once it can be edited.
        .onChange(of: loading, initial: true) { _, busy in
            if !busy { Task { try? await Task.sleep(for: .milliseconds(50)); nameFocused = true } }
        }
        .onChange(of: profileId) { applyProfile() }
        .onChange(of: imageId) {
            // The model list follows the version: keep the model if the version runs it, else pick one it does.
            if !visibleProfiles.contains(where: { $0.id == profileId }) { profileId = Self.defaultProfile(visibleProfiles, platform: platform)?.id }
            suggestName()
        }
    }

    // MARK: Sections

    @ViewBuilder private var unavailable: some View {
        let b = candidates.first
        let reason = b?.availability?.reason
        let hints = b?.availability?.hints ?? []
        LabeledContent("") {
            ProblemView(problem: FriendlyError(
                title: "\(b?.displayName ?? platform.rawValue) isn’t installed",
                message: platform.installHint,
                details: ([reason].compactMap { $0 } + hints.map { "• " + $0 }).joined(separator: "\n").nilIfEmpty))
            .frame(width: 360, alignment: .leading)
        }
        .testAnchor("create-unavailable")
    }

    /// Model, Version, Name and Backend share one width.
    private static let fieldWidth: CGFloat = 320

    /// The service hasn't said which backends work yet, or the chosen one's models and versions are on their way.
    private var loading: Bool {
        model.backends.isEmpty || (backend != nil && listsLoadedFor != backendId)
    }

    @ViewBuilder private var fields: some View {
        if loading || !profiles.isEmpty {
            Picker("Model", selection: $profileId) {
                if loading { Text("Loading…").tag(String?.none) }
                ForEach(visibleProfiles) { p in Text(p.name).tag(Optional(p.id)) }
            }
            .testAnchor("Model")
            .modifier(FormField(label: "Model", width: Self.fieldWidth))
            .disabled(loading)
        }
        versionRow
        TextField("Name", text: Binding(get: { name }, set: { if $0 != name { name = $0; nameEdited = true } }),
                  prompt: Text(profiles.first { $0.id == profileId }?.name ?? "Name"))
            .focused($nameFocused)
            .testAnchor("Device name")
            .modifier(FormField(label: "Name", width: Self.fieldWidth))
            .disabled(loading)
        Toggle("Start after creating", isOn: $bootAfter)
        if hasAdvanced || (model.backends.isEmpty && platform != .ios) { advanced.disabled(loading) }
    }

    @ViewBuilder private var versionRow: some View {
        if loading || (loadingLists && images.isEmpty) {
            Picker("Version", selection: .constant(String?.none)) { Text("Loading…").tag(String?.none) }
                .modifier(FormField(label: "Version", width: Self.fieldWidth))
                .disabled(true)
            if platform == .android {
                Toggle("Show all system images", isOn: .constant(false)).toggleStyle(.checkbox).font(Theme.Fonts.callout)
                    .disabled(true)
            }
        } else if !images.isEmpty {
            Picker("Version", selection: $imageId) {
                let shown = visibleImages
                let installed = shown.filter { $0.installed && $0.isUsable }
                let others = shown.filter { !$0.installed }
                let broken = shown.filter { $0.installed && !$0.isUsable }
                if !installed.isEmpty {
                    Section("Installed") { ForEach(installed) { img in Text(Self.title(img)).tag(Optional(img.id)) } }
                }
                if !broken.isEmpty {
                    Section("Not Working") {
                        ForEach(broken) { img in Text(Self.title(img) + " — needs reinstalling").tag(Optional(img.id)).disabled(true) }
                    }
                }
                if !others.isEmpty {
                    Section("Download") {
                        ForEach(others) { img in Text(Self.title(img) + " — " + Self.downloadSize(img)).tag(Optional(img.id)) }
                    }
                }
            }
            .testAnchor("Version")
            .modifier(FormField(label: "Version", width: Self.fieldWidth))
            if let j = downloadJob, !j.isFinished {
                LabeledContent("") {
                    VStack(alignment: .leading, spacing: Theme.Space.xs) {
                        if let f = j.fraction {
                            ProgressView(value: f).frame(width: 240)
                            Text("Downloading… \(Int(f * 100))%").font(Theme.Fonts.callout.monospacedDigit()).foregroundStyle(Theme.Ink.secondary)
                        } else {
                            ProgressView().progressViewStyle(.linear).frame(width: 240)
                            Text("Downloading…").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                        }
                    }
                }
            } else if let img = image, !img.installed {
                LabeledContent("") {
                    // The sentence wraps and Download sits under it, inside the form's width whatever the name.
                    VStack(alignment: .leading, spacing: Theme.Space.s) {
                        Text("\(Self.shortName(img)) needs \(img.sizeMB.map { Self.withArticle(Self.size($0)) } ?? "a") download.")
                            .font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        Button { download(img) } label: { Label("Download", systemImage: "arrow.down.circle") }
                            .testAnchor("Download")
                    }
                    .frame(width: Self.fieldWidth, alignment: .leading)
                }
            }
            if showOlder || visibleImages.count < images.count {
                Toggle("Show all system images", isOn: $showOlder).toggleStyle(.checkbox).font(Theme.Fonts.callout)
                    .help("Older versions, previews, and Wear OS, TV, Automotive, test (ATD), tablet and 16 KB page size images")
            }
        }
    }

    private var advanced: some View {
        Group {
            LabeledContent("") {
                Button {
                    Theme.Motion.expand { showAdvanced.toggle() }
                } label: {
                    HStack(spacing: Theme.Space.xs) {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10, weight: .semibold))
                            .rotationEffect(.degrees(showAdvanced ? 90 : 0))
                            .foregroundStyle(Theme.Ink.secondary)
                        Text("Advanced").foregroundStyle(Theme.Ink.primary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(showAdvanced ? "Hide Advanced" : "Show Advanced")
                .testAnchor("Advanced")
            }
            .padding(.top, Theme.Space.s)
            if showAdvanced {
                if backends.count > 1 {
                    Picker("Backend", selection: $backendId) {
                        ForEach(backends) { b in Text(b.displayName).tag(Optional(b.id)) }
                    }
                    .modifier(FormField(label: "Backend", width: Self.fieldWidth))
                }
                if !ignoresHardware {
                    stepper("CPU cores", value: $cpus, in: 1...16, step: 1) { "\($0)" }
                    stepper("Memory", value: $ramMB, in: 1024...32768, step: 1024) { InfoTab.gb($0) }
                    stepper("Storage", value: $storageMB, in: 2048...262144, step: 2048) { InfoTab.gb($0) }
                    LabeledContent("Screen") {
                        HStack(spacing: Theme.Space.xs) {
                            TextField("Width", value: $width, format: .number.grouping(.never)).frame(width: 56)
                            Text("×").foregroundStyle(Theme.Ink.secondary)
                            TextField("Height", value: $height, format: .number.grouping(.never)).frame(width: 56)
                            Text("at").foregroundStyle(Theme.Ink.secondary)
                            TextField("DPI", value: $dpi, format: .number.grouping(.never)).frame(width: 44)
                            Text("dpi").foregroundStyle(Theme.Ink.secondary)
                        }
                        .labelsHidden()
                        .textFieldStyle(.roundedBorder)
                    }
                    Toggle("Start automatically when PhoneDock starts", isOn: $autoStart)
                }
            }
        }
    }

    private func stepper(_ title: String, value: Binding<Int>, in range: ClosedRange<Int>, step: Int, format: @escaping (Int) -> String) -> some View {
        LabeledContent(title) {
            HStack(spacing: Theme.Space.s) {
                Text(format(value.wrappedValue)).monospacedDigit().frame(minWidth: 44, alignment: .trailing)
                Stepper(title, value: value, in: range, step: step).labelsHidden()
            }
        }
    }

    private var footer: some View {
        HStack(spacing: Theme.Space.m) {
            if loading {
                ProgressView().controlSize(.small)
                Text(model.backends.isEmpty ? "Checking what this Mac can run…" : "Loading models and versions…")
                    .font(Theme.Fonts.callout)
                    .foregroundStyle(Theme.Ink.secondary)
                    .lineLimit(1)
                    .testAnchor("create-loading")
            } else if backend != nil, trimmedName.isEmpty {
                // (A version that needs downloading says so on its own row.)
                Text("Enter a name to create the device.").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary).lineLimit(1)
            }
            Spacer(minLength: Theme.Space.m)
            Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).testAnchor("Cancel Create")
            Button("Create") { create() }
                .keyboardShortcut(.defaultAction)
                .disabled(!canCreate)
                .help(createBlocked ?? "")
                .testAnchor("Create")
        }
    }

    /// Why Create is off, in words (also its tooltip). Nil when it's on.
    private var createBlocked: String? {
        if canCreate || creating { return nil }
        if loading { return "Loading models and versions…" }
        if backend == nil { return "Install the tools above first." }
        if trimmedName.isEmpty { return "Enter a name." }
        if let img = image, img.installed, !img.isUsable { return "\(Self.shortName(img)) isn’t working on this Mac. Choose another version." }
        if let img = image, !img.installed { return downloading ? "Downloading \(Self.shortName(img))…" : "Download \(Self.shortName(img)) first." }
        return nil
    }

    // MARK: Image naming

    /// Phone images most people want, one per version and kind; "Show all system images" lists everything the SDK
    /// offers. Installed images and the chosen one always show.
    private var visibleImages: [OsImage] {
        if showOlder { return images }
        let wanted = images.filter { Self.isEveryday($0) || $0.installed || $0.id == imageId }
        // "android-36" and "android-36-ext18" read the same: keep one (installed, else the base release).
        var seen: [String: Int] = [:], out: [OsImage] = []
        for img in wanted {
            let t = Self.title(img)
            if let i = seen[t] {
                let kept = out[i]
                let better = (img.installed && !kept.installed) || (img.installed == kept.installed && kept.id.contains("-ext") && !img.id.contains("-ext"))
                if better { out[i] = img }
            } else { seen[t] = out.count; out.append(img) }
        }
        return out
    }

    /// An Android phone image of a stable release from Android 9 on, with Google APIs or Google Play. The SDK also
    /// offers Wear OS, TV, Automotive, XR, desktop, ATD (no UI apps), tablet, 16 KB page size, beta and canary images:
    /// those wait behind "Show all system images". Other platforms' images all count.
    static func isEveryday(_ img: OsImage) -> Bool {
        guard img.platform == "android" || img.backend == "android-emulator" else { return true }
        let parts = img.id.split(separator: ";")
        guard parts.count >= 3 else { return !isOld(img) }
        guard parts[2] == "google_apis" || parts[2] == "google_apis_playstore" else { return false }
        guard let v = img.version, let n = Double(v) else { return false }   // "37.2-beta3", "canary-…"
        return n >= 28
    }

    /// "Android 16 (API 36) · Google APIs · arm64" → "Android 16 (API 36) · Google APIs";
    /// "iOS 26.5 (23F77) · Simulator" → "iOS 26.5 (23F77)";
    /// `Alpine Linux 3.24 "virt" · aarch64 · live ISO (console)` → "Alpine Linux 3.24 “virt” · live ISO (console)".
    static func title(_ img: OsImage) -> String {
        var s = img.name
        for suffix in [" · arm64", " · aarch64", " · Simulator", " (download)"] where s.hasSuffix(suffix) { s = String(s.dropLast(suffix.count)) }
        // Every image here is for this Mac's architecture: the arch in the middle of a name is noise too.
        for arch in [" · arm64 ·", " · aarch64 ·"] { s = s.replacingOccurrences(of: arch, with: " ·") }
        // Straight quotes from the service's names read as code: typographic ones, as in the rest of the app.
        while let open = s.firstIndex(of: "\""), let close = s[s.index(after: open)...].firstIndex(of: "\"") {
            s.replaceSubrange(close...close, with: "”")
            s.replaceSubrange(open...open, with: "“")
        }
        return s
    }

    /// "Android 15" / "iOS 27.0" for the download sentence.
    static func shortName(_ img: OsImage) -> String {
        let t = title(img)
        // Cut at whichever comes first: "Android 16 (API 36) · …" → "Android 16"; "Alpine Linux 3.24 “virt” · …".
        let cuts = [t.range(of: " ("), t.range(of: " · ")].compactMap { $0?.lowerBound }
        if let cut = cuts.min() { return String(t[..<cut]) }
        return "This version"
    }

    static func size(_ mb: Double) -> String { mb >= 1024 ? String(format: "%.1f GB", mb / 1024) : String(format: "%.0f MB", mb) }
    /// "a 1.4 GB", but "an 89 MB", "an 8.1 GB", "an 11 MB", "an 18 MB": by how the number sounds.
    static func withArticle(_ s: String) -> String {
        let digits = s.prefix { $0.isNumber }
        let an = digits.first == "8" || digits == "11" || digits == "18"
        return (an ? "an " : "a ") + s
    }
    static func downloadSize(_ img: OsImage) -> String { img.sizeMB.map { "\(size($0)) download" } ?? "download" }

    /// Android images below API 28 are hidden unless asked for.
    static func isOld(_ img: OsImage) -> Bool {
        guard img.platform == "android" || img.backend == "android-emulator", let v = img.version, let n = Double(v) else { return false }
        return n < 28
    }

    /// Version comparison: >0 if a should sort before b. Stable versions first (newest first), then
    /// pre-releases like "37.2-beta3" (newest first), then non-numeric ones like "canary-2026…", then missing.
    static func compareVersions(_ a: String?, _ b: String?) -> Int {
        func key(_ s: String?) -> (rank: Int, parts: [Int]) {
            guard let s, let first = s.first, first.isNumber else { return (s == nil || s!.isEmpty ? 3 : 2, []) }
            let numeric = s.prefix { $0.isNumber || $0 == "." }
            let parts = numeric.split(separator: ".").compactMap { Int($0) }
            return (numeric.count == s.count ? 0 : 1, parts)
        }
        let x = key(a), y = key(b)
        if x.rank != y.rank { return x.rank < y.rank ? 1 : -1 }
        for i in 0..<max(x.parts.count, y.parts.count) {
            let l = i < x.parts.count ? x.parts[i] : 0, r = i < y.parts.count ? y.parts[i] : 0
            if l != r { return l > r ? 1 : -1 }
        }
        return 0
    }

    // MARK: Loading

    private func pickBackend() {
        if !platforms.contains(platform) { platformRaw = PlatformChoice.android.rawValue }
        if let b = backendId, backends.contains(where: { $0.id == b }) { return }
        backendId = backends.first?.id
        if backendId == nil { images = []; profiles = []; imageId = nil; profileId = nil }
    }

    private func loadLists() async {
        images = []; profiles = []; imageId = nil; profileId = nil; downloadJob = nil
        guard let c = model.client, let b = backendId else { return }
        loadingLists = true; defer { loadingLists = false }
        let enc = DaemonClient.enc(b)
        let all = (try? await c.get([OsImage].self, "/v1/backends/\(enc)/images")) ?? []
        guard b == backendId else { return }
        // Installed first, then newest version first (API 36 → 21, iOS 27 → 26); backend order breaks ties.
        images = all.enumerated().sorted { a, b in
            let aw = a.element.installed && a.element.isUsable, bw = b.element.installed && b.element.isUsable
            if aw != bw { return aw }
            if a.element.installed != b.element.installed { return a.element.installed }
            let c = Self.compareVersions(a.element.version, b.element.version)
            return c != 0 ? c > 0 : a.offset < b.offset
        }.map(\.element)
        let profs = (try? await c.get([HardwareProfile].self, "/v1/backends/\(enc)/profiles")) ?? []
        guard b == backendId else { return }
        profiles = profs
        // The newest version that works; one that's installed but broken is never the default.
        imageId = images.first(where: { $0.installed && $0.isUsable })?.id ?? images.first(where: \.installed)?.id
            ?? images.first(where: Self.isEveryday)?.id ?? images.first?.id   // never a preview or a TV image by default
        profileId = Self.defaultProfile(visibleProfiles, platform: platform)?.id
        applyProfile()
        listsLoadedFor = b
    }

    /// iPhones: the newest "Pro" (the service's own default); everything else: the first in the list.
    static func defaultProfile(_ list: [HardwareProfile], platform: PlatformChoice) -> HardwareProfile? {
        if platform == .ios {
            // The newest "iPhone NN Pro" (the list isn't in release order).
            func gen(_ p: HardwareProfile) -> Int { Int(p.name.filter(\.isNumber)) ?? 0 }
            let pros = list.filter { $0.name.hasPrefix("iPhone") && $0.name.hasSuffix(" Pro") }
            if let pro = pros.max(by: { gen($0) < gen($1) }) { return pro }
        }
        return list.first
    }

    private func applyProfile() {
        if let p = profiles.first(where: { $0.id == profileId }) {
            if let w = p.width { width = w }
            if let h = p.height { height = h }
            if let d = p.dpi { dpi = d }
            if let r = p.ramMB { ramMB = r }
        }
        suggestName()
    }

    /// "Pixel-9" (Android and QEMU names can't contain spaces), "iPhone 18 Pro" on iOS; unique among devices.
    private func suggestName() {
        guard !nameEdited else { return }
        let base = visibleProfiles.first(where: { $0.id == profileId })?.name
            ?? (platform == .ios ? "iPhone" : platform == .android ? "Pixel" : "VM")
        let spaces = platform == .ios
        let slug = spaces ? base : base.replacingOccurrences(of: " ", with: "-").replacingOccurrences(of: "×", with: "x").filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" || $0 == "." }
        var candidate = slug, n = 2
        while model.devices.contains(where: { $0.name == candidate }) { candidate = "\(slug)\(spaces ? " " : "-")\(n)"; n += 1 }
        name = candidate
    }

    // MARK: Actions

    private func download(_ img: OsImage) {
        guard let c = model.client, let b = backendId else { return }
        problem = nil
        Task {
            do {
                let job = try await c.sendJob("POST", "/v1/backends/\(DaemonClient.enc(b))/images/install", json: ["image": img.id])
                downloadJob = job
                var cur = job
                while !cur.isFinished {
                    try? await Task.sleep(for: .seconds(1))
                    if let j = try? await c.get(Job.self, "/v1/jobs/\(DaemonClient.enc(job.id))") { cur = j; downloadJob = j }
                }
                if cur.isFailed {
                    problem = FriendlyError.from(job: cur, title: "Couldn’t download \(Self.shortName(img))",
                                                 fallback: "Check your internet connection and try again.")
                }
                let keep = imageId
                images = (try? await c.get([OsImage].self, "/v1/backends/\(DaemonClient.enc(b))/images")) ?? images
                imageId = keep ?? img.id
                downloadJob = nil
            } catch {
                downloadJob = nil
                problem = FriendlyError.from(error, title: "Couldn’t download \(Self.shortName(img))")
            }
        }
    }

    private func create() {
        guard canCreate, let c = model.client, let b = backendId else { return }
        let n = trimmedName
        var spec: [String: Any] = ["backend": b, "name": n, "boot": bootAfter]
        if let i = imageId { spec["image"] = i }
        if let p = profileId { spec["profile"] = p }
        if !ignoresHardware {
            spec["autoStart"] = autoStart
            spec["cpus"] = cpus; spec["ramMB"] = ramMB; spec["storageMB"] = storageMB
            spec["width"] = width; spec["height"] = height; spec["dpi"] = dpi
        }
        // Not modal: the sheet closes now; the sidebar shows the new device with its stage while it's made and started.
        _ = c
        model.createDevice(spec: spec, name: n, platform: platform.rawValue.lowercased())
        dismiss()
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

/// A form row whose control has an exact width. (`.frame` on a Picker in a `.columns` form sizes label and control
/// together, so a longer label made a narrower control.)
private struct FormField: ViewModifier {
    let label: String
    let width: CGFloat
    func body(content: Content) -> some View {
        LabeledContent(label) { content.labelsHidden().frame(width: width) }
    }
}
