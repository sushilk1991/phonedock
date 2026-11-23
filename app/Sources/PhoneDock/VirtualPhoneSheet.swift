import SwiftUI

/// New Virtual Phone: Add Device's second step for a virtual phone, an Android emulator that presents as a real
/// handset (`options.disguise`, docs/VIRTUAL-PHONES.md). Width 520, height fits the content, laid out as New Simulator
/// or Emulator is. The phones and carriers come from the service (`GET /v1/disguise`), never from a list in the app.
///
/// It needs the Android emulator and the Google Play system image the chosen phone runs on; the form says which is
/// missing and downloads the image in place, so Create never fails with "no system image". The copy stays as honest as
/// the docs: Wi-Fi only, and apps that check hardware-backed security can still tell.
struct VirtualPhoneSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    /// Back to Add Device's chooser (‹ before the title); nil hides it.
    var onBack: (() -> Void)?

    init(onBack: (() -> Void)? = nil) { self.onBack = onBack }

    @State private var catalog: DisguiseCatalog?
    @State private var catalogProblem: FriendlyError?
    @State private var images: [OsImage] = []
    @State private var imagesLoaded = false
    /// The image list didn't load (timeout, service trouble): never read as "this SDK doesn't offer it".
    @State private var imagesProblem: FriendlyError?
    @State private var profileId: String?
    @State private var carrierId: String?
    @State private var name = ""
    @State private var nameEdited = false
    @State private var bootAfter = true
    @State private var showAdvanced = false
    @State private var downloadJob: Job?
    /// Follows `downloadJob`; cancelled when the sheet closes so it never polls a form nobody sees.
    @State private var downloadTask: Task<Void, Never>?
    @State private var problem: FriendlyError?
    @FocusState private var nameFocused: Bool

    private static let backendId = "android-emulator"
    private static let fieldWidth: CGFloat = 320

    private var backend: BackendInfo? { model.backends.first { $0.id == Self.backendId } }
    private var androidReady: Bool { backend?.isAvailable == true }
    private var profile: DisguiseCatalog.Profile? { catalog?.profiles.first { $0.id == profileId } }
    private var image: OsImage? { profile.flatMap { p in images.first { $0.id == p.image } } }
    private var imageReady: Bool { image.map { $0.installed && $0.isUsable } ?? false }
    private var downloading: Bool { downloadJob.map { !$0.isFinished } ?? false }
    /// The service hasn't said what this Mac runs yet, or the phones and system images are on their way.
    private var loading: Bool {
        model.backends.isEmpty || (androidReady && catalogProblem == nil && (catalog == nil || !imagesLoaded))
    }
    private var trimmedName: String { name.trimmingCharacters(in: .whitespaces) }
    /// Create hands the request to the service, so it needs one: never enabled while disconnected.
    private var connected: Bool { model.connection.isConnected && model.client != nil }
    private var canCreate: Bool {
        connected && !loading && androidReady && profile != nil && imageReady && !downloading && !trimmedName.isEmpty
    }
    private var systemName: String { "Android \(profile?.androidRelease ?? "") with Google Play" }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Back waits for a download, as in New Simulator or Emulator: its progress lives in this form's state.
            SheetTitle(title: DeviceWords.newVirtualPhone, onBack: onBack, backDisabled: downloading)
            Text("An Android phone with Google Play that apps see as the model you pick. It runs on this Mac.")
                .font(Theme.Fonts.callout)
                .foregroundStyle(Theme.Ink.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, Theme.Space.xs)
            Form {
                if !model.backends.isEmpty && !androidReady {
                    unavailable
                } else if let catalogProblem {
                    LabeledContent("") {
                        ProblemView(problem: catalogProblem,
                                    retryTitle: model.restartingDaemon ? "Restarting…" : "Restart Service…",
                                    retry: model.restartingDaemon ? nil : { model.restartDaemonFromApp() })
                            .frame(width: 360, alignment: .leading)
                    }
                    .testAnchor("vphone-unsupported")
                } else {
                    fields
                }
            }
            .formStyle(.columns)
            .padding(.top, Theme.Space.xl)
            if let problem {
                ProblemView(problem: problem)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, Theme.Space.l)
                    .testAnchor("vphone-problem")
            }
            notes.padding(.top, Theme.Space.l)
            footer.padding(.top, Theme.Space.xl)
        }
        .padding(Theme.Space.xxl)
        .frame(width: 520)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxHeight: 640)
        .task {
            if model.backends.isEmpty { await model.loadBackends() }
            await load()
        }
        .onChange(of: model.backends) { if needsLoad { Task { await load() } } }
        // After Restart Service (or any reconnect) the backends may be unchanged, so the connection is the cue to retry.
        .onChange(of: model.connection) { if model.connection.isConnected, needsLoad { Task { await load() } } }
        .onDisappear { downloadTask?.cancel() }
        .onChange(of: profileId) { suggestName() }
        // Name is the field people change: focus it once it can be edited.
        .onChange(of: loading, initial: true) { _, busy in
            if !busy { Task { try? await Task.sleep(for: .milliseconds(50)); nameFocused = true } }
        }
        .testAnchor("vphone-sheet")
    }

    // MARK: Sections

    @ViewBuilder private var unavailable: some View {
        LabeledContent("") {
            ProblemView(problem: FriendlyError(
                title: "\(backend?.displayName ?? "Android emulator") isn’t installed",
                message: "Virtual phones run on the Android emulator. " + PlatformChoice.android.installHint,
                details: ([backend?.availability?.reason].compactMap { $0 } + (backend?.availability?.hints ?? []).map { "• " + $0 })
                    .joined(separator: "\n").nilIfEmptyString))
            .frame(width: 360, alignment: .leading)
        }
        .testAnchor("vphone-unavailable")
    }

    @ViewBuilder private var fields: some View {
        LabeledContent {
            Picker("Phone", selection: $profileId) {
                if catalog == nil { Text("Loading…").tag(String?.none) }
                ForEach(catalog?.profiles ?? []) { p in Text(p.name).tag(Optional(p.id)) }
            }
            .labelsHidden()
            .frame(width: Self.fieldWidth, alignment: .leading)
            .testAnchor("Phone")
            .disabled(loading)
        } label: {
            // The label column is as wide as its widest label: reserve Advanced's "Carrier" so opening it moves nothing.
            ZStack(alignment: .trailing) {
                Text("Carrier").hidden().accessibilityHidden(true)
                Text("Phone")
            }
        }
        systemRow
        TextField("Name", text: Binding(get: { name }, set: { if $0 != name { name = $0; nameEdited = true } }),
                  prompt: Text("Name"))
            .focused($nameFocused)
            .testAnchor("Virtual phone name")
            .modifier(FormField(label: "Name", width: Self.fieldWidth))
            .disabled(loading)
        Toggle("Start after creating", isOn: $bootAfter).testAnchor("Start virtual phone after creating")
        advanced.disabled(loading)
    }

    /// The Google Play system image the phone runs on: ready, downloading, or a Download button with its size.
    @ViewBuilder private var systemRow: some View {
        LabeledContent("System") {
            HStack(spacing: Theme.Space.s) {
                if loading {
                    Text("Loading…").foregroundStyle(Theme.Ink.secondary)
                } else if let imagesProblem, !downloading {
                    Text("Couldn’t check \(systemName).").foregroundStyle(Theme.Ink.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .help(imagesProblem.message ?? "")
                    Button("Try Again") { Task { await loadImages() } }
                        .testAnchor("Retry system image")
                } else if imageReady {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.Status.running).accessibilityHidden(true)
                    Text(systemName).foregroundStyle(Theme.Ink.primary)
                        .accessibilityLabel("\(systemName), ready")
                } else if let j = downloadJob, !j.isFinished {
                    VStack(alignment: .leading, spacing: Theme.Space.xs) {
                        if let f = j.fraction {
                            ProgressView(value: f).frame(width: 240)
                            Text("Downloading \(systemName)… \(Int(f * 100))%")
                                .font(Theme.Fonts.callout.monospacedDigit()).foregroundStyle(Theme.Ink.secondary)
                        } else {
                            ProgressView().progressViewStyle(.linear).frame(width: 240)
                            Text("Downloading \(systemName)…").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                        }
                    }
                } else if let img = image, !img.installed {
                    Text(systemName).foregroundStyle(Theme.Ink.primary).fixedSize()
                    Button("Download") { download(img) }
                        .help("Download \(systemName) (\(CreateDeviceSheet.downloadSize(img)))")
                        .testAnchor("Download system image")
                    // The size only when the SDK says it (its list often doesn't); never a second "Download".
                    if let mb = img.sizeMB {
                        Text(CreateDeviceSheet.size(mb)).font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                    }
                } else if let img = image, !img.isUsable {
                    Text("\(systemName) isn’t working on this Mac. Reinstall it in Android Studio.")
                        .font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    Text("This Android SDK doesn’t offer \(systemName).")
                        .font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(width: Self.fieldWidth, alignment: .leading)
        }
        .testAnchor("vphone-system")
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
                // The SIM the phone claims (its IMSI, ICCID and number). Wi-Fi only for now, so it's identity, not service.
                Picker("Carrier", selection: $carrierId) {
                    ForEach(catalog?.carriers ?? []) { c in Text("\(c.name) (\(c.country))").tag(Optional(c.id)) }
                }
                .testAnchor("Carrier")
                .modifier(FormField(label: "Carrier", width: Self.fieldWidth))
            }
        }
    }

    /// What people should know before they rely on one, in the docs' own terms.
    private var notes: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            Label {
                Text("Wi-Fi only for now, and the first one takes a few minutes to set up. Apps that check for hardware-backed security can still tell it’s virtual.")
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "info.circle")
            }
            .font(Theme.Fonts.callout)
            .foregroundStyle(Theme.Ink.secondary)
            if let doc = DaemonLocator.virtualPhonesDoc {
                Link(destination: doc) { Label("About Virtual Phones", systemImage: "book") }
                    .font(Theme.Fonts.callout)
                    .foregroundStyle(Theme.Accent.text)
                    .help("What a virtual phone presents as, and its limits")
            }
        }
    }

    private var footer: some View {
        HStack(spacing: Theme.Space.m) {
            if !connected && !model.backends.isEmpty {
                Text("Not connected to PhoneDock’s service.").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary).lineLimit(1)
            } else if loading {
                ProgressView().controlSize(.small)
                Text(model.backends.isEmpty ? "Checking what this Mac can run…" : "Loading phones and system images…")
                    .font(Theme.Fonts.callout)
                    .foregroundStyle(Theme.Ink.secondary)
                    .lineLimit(1)
            } else if androidReady, catalog != nil, !imageReady, !downloading, image?.installed == false {
                Text("Download the system first.").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary).lineLimit(1)
            } else if androidReady, catalog != nil, trimmedName.isEmpty {
                Text("Enter a name to create the phone.").font(Theme.Fonts.callout).foregroundStyle(Theme.Ink.secondary).lineLimit(1)
            }
            Spacer(minLength: Theme.Space.m)
            Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).testAnchor("Cancel Virtual Phone")
            Button("Create") { create() }
                .keyboardShortcut(.defaultAction)
                .disabled(!canCreate)
                .testAnchor("Create Virtual Phone")
        }
    }

    // MARK: Loading

    private var needsLoad: Bool { catalog == nil || catalogProblem != nil || !imagesLoaded || imagesProblem != nil }

    private func load() async {
        guard androidReady, let c = model.client else { return }
        if catalog == nil {
            do {
                let cat = try await c.get(DisguiseCatalog.self, "/v1/disguise")
                catalog = cat
                catalogProblem = nil
                if profileId == nil { profileId = cat.defaultProfile }
                if carrierId == nil { carrierId = cat.defaultCarrier }
            } catch let e as APIError where e.status == 404 {
                // A service older than this app (0.3.x or a CLI-started one) makes virtual phones but can't list them.
                catalogProblem = FriendlyError(title: "This PhoneDock service is older than the app",
                                               message: "Restart it to use the one that came with this app.",
                                               details: e.rawDetails)
                return
            } catch {
                catalogProblem = FriendlyError.from(error, title: "Couldn’t load the phones")
                return
            }
        }
        await loadImages()
    }

    private func loadImages() async {
        guard let c = model.client else { return }
        do {
            images = try await c.get([OsImage].self, "/v1/backends/\(DaemonClient.enc(Self.backendId))/images")
            imagesProblem = nil
        } catch {
            imagesProblem = FriendlyError.from(error, title: "Couldn’t check \(systemName)")
        }
        imagesLoaded = true
        suggestName()
    }

    /// "Pixel-8", "Galaxy-S24", "OnePlus-12": the phone's everyday name (Android names can't contain spaces), unique
    /// among devices, until it's typed.
    private func suggestName() {
        guard !nameEdited, let p = profile else { return }
        var base = p.name
        for maker in ["Google ", "Samsung "] where base.hasPrefix(maker) { base.removeFirst(maker.count) }
        let slug = base.replacingOccurrences(of: " ", with: "-").filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" || $0 == "." }
        var candidate = slug, n = 2
        while model.devices.contains(where: { $0.name == candidate }) { candidate = "\(slug)-\(n)"; n += 1 }
        name = candidate
    }

    // MARK: Actions

    private func download(_ img: OsImage) {
        guard let c = model.client else { return }
        problem = nil
        downloadTask?.cancel()
        downloadTask = Task {
            do {
                let job = try await c.sendJob("POST", "/v1/backends/\(DaemonClient.enc(Self.backendId))/images/install", json: ["image": img.id])
                downloadJob = job
                let done = try await c.follow(job) { downloadJob = $0 }
                if done.isFailed {
                    problem = FriendlyError.from(job: done, title: "Couldn’t download \(systemName)",
                                                 fallback: "Check your internet connection and try again.")
                }
            } catch is CancellationError {
                return
            } catch {
                problem = FriendlyError.from(error, title: "Couldn’t download \(systemName)")
            }
            // Reload even after a failure: a download whose job was lost may still have finished.
            await loadImages()
            downloadJob = nil
        }
    }

    private func create() {
        // canCreate includes a live client, so createDevice accepts it (its own guard) before the sheet closes.
        guard canCreate, let p = profile else { return }
        let n = trimmedName
        var disguise: [String: Any] = ["profile": p.id]
        if let carrierId { disguise["carrier"] = carrierId }
        let spec: [String: Any] = ["backend": Self.backendId, "name": n, "boot": bootAfter, "image": p.image,
                                   "options": ["disguise": disguise]]
        // Not modal, as with any device: the sheet closes now and the sidebar shows it under Virtual Phones while the
        // service prepares it (minutes the first time: it patches the system image once) and starts it.
        model.createDevice(spec: spec, name: n, platform: "android", virtualPhone: true)
        dismiss()
    }
}

private extension String {
    var nilIfEmptyString: String? { isEmpty ? nil : self }
}
