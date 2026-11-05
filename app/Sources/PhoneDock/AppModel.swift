import os.signpost
import Foundation
import SwiftUI
import Observation

enum ConnectionState: Equatable {
    case connecting(String)
    case connected(version: String?)
    case failed(String)

    var label: String {
        switch self {
        case .connecting(let s): return s
        case .connected(let v): return v.map { "Connected · v\($0)" } ?? "Connected"
        case .failed(let s): return s
        }
    }
    var color: Color {
        switch self {
        case .connecting: return .orange
        case .connected: return .green
        case .failed: return .red
        }
    }
    var isConnected: Bool { if case .connected = self { return true }; return false }
}

@MainActor
@Observable
final class AppModel {
    var connection: ConnectionState = .connecting("Looking for daemon…")
    var client: DaemonClient?
    var devices: [Device] = []
    var backends: [BackendInfo] = []
    var selection: String? { didSet { if let selection { UserDefaults.standard.set(selection, forKey: "lastSelection") } } }
    private var restoredSelection = false
    var jobs: [String: Job] = [:]           // tracked jobs by id
    var deviceJobs: [String: String] = [:]  // deviceId -> active job id (boot etc.)
    /// deviceId → a long operation that takes the device out of use for a while ("Saving snapshot…"). An iOS snapshot
    /// or clone shuts the simulator down and starts it again, so while this is set the device shows it instead of
    /// "Off", and Start, Shut Down and Delete are off (`DeviceActions.isBusy`).
    var busy: [String: String] = [:]
    /// deviceId → a quick action just clicked ("Taking over…", "Shutting down…", "Starting…"): shown at once, until the
    /// service has answered and the list is fresh. Unlike `busy` it isn't a long operation (no snapshot section text).
    var pending: [String: String] = [:]
    /// Rotations in flight: device id → the orientation asked for.
    var rotating: [String: String] = [:]
    /// A blocking failure, shown as the one alert (create, delete, connect, restart). Everything else uses `toast`.
    var problem: FriendlyError?
    /// A one-off message at the bottom of the window (action failures, confirmations).
    var toast: Toast?
    var liveUpdates = false
    /// Who is responsible for the attached daemon (Local Network permission follows the responsible process).
    var daemonOrigin: DaemonLocator.Origin = .unknown
    var daemonPid: Int?
    var restartingDaemon = false

    var showCreate = false
    var showConnect = false
    var showAgentSetup = false
    /// View menu: the sidebar and inspector, so the menu items can say Show or Hide.
    var sidebarVisible = true
    var inspectorVisible = true

    /// Devices whose screen is black because the phone is asleep (seen by the stage's frame loop).
    var asleep: Set<String> = []
    /// Ask the window to show this inspector tab (the crash toast's View). The root view clears it.
    var requestedInspectorTab: InspectorTab?
    /// Devices being created: they show in the sidebar with stage text until the service lists them.
    var creating: [PendingDevice] = []
    private var crashBaseline: [String: Set<String>] = [:]
    private var lastCrashCheck = Date.distantPast

    /// Pending handoffs by handoff id (from device lists and the SSE `handoff` event).
    var handoffs: [String: Handoff] = [:]
    private var resolvedHandoffs: Set<String> = []
    /// Handoffs answered from this app (the card, the Device menu or a notification): when one leaves the pending list
    /// the stage expects it, rather than saying it was "answered elsewhere".
    private(set) var answeredHere: Set<String> = []
    private var notifiedHandoffs: Set<String> = []

    /// Screen recordings in progress, by device id.
    var recordings: [String: RecordingState] = [:]
    /// Devices whose backend answered 501 to a recording request.
    var recordingUnsupported: Set<String> = []
    /// The last finished recording per device (for "Show Last Recording in Finder"). Kept across launches: the
    /// paths are remembered, and a file that's gone since is forgotten.
    var savedRecordings: [String: RecordingResult] = AppModel.rememberedRecordings() {
        didSet { AppModel.rememberRecordings(savedRecordings) }
    }
    private static let lastRecordingsKey = "recordings.last"
    private static func rememberedRecordings() -> [String: RecordingResult] {
        let paths = UserDefaults.standard.dictionary(forKey: lastRecordingsKey) as? [String: String] ?? [:]
        return paths.filter { FileManager.default.fileExists(atPath: $0.value) }.mapValues { RecordingResult(path: $0) }
    }
    private static func rememberRecordings(_ r: [String: RecordingResult]) {
        UserDefaults.standard.set(r.mapValues(\.path), forKey: lastRecordingsKey)
    }
    /// Recordings this app started (deviceId → start time). When they finish, the file moves from the service's
    /// folder to `SavedMedia.folder`, next to screenshots. Agents' recordings stay where the agent was told they are.
    private var appRecordings: [String: Date] = [:]
    /// Service paths already handled (the stop response and the SSE event both report the same file).
    private var finishedRecordingPaths: Set<String> = []

    private var eventsTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?
    private var started = false

    var selectedDevice: Device? { devices.first { $0.id == selection } }

    func start() {
        guard !started else { return }
        started = true
        switch ProcessInfo.processInfo.environment["PHONEDOCK_APP_SHEET"] {   // debug/screenshot hook
        case "create": Task { try? await Task.sleep(for: .seconds(3)); showCreate = true }
        case "connect": showConnect = true
        case "agent": showAgentSetup = true
        default: break
        }
        HandoffNotifier.shared.onOpen = { [weak self] deviceId in
            if !SelfTest.blocksForeground("activate from a notification") { NSApp.activate(ignoringOtherApps: true) }
            if let self, self.devices.contains(where: { $0.id == deviceId }) { self.selection = deviceId }
        }
        HandoffNotifier.shared.onAction = { [weak self] action, deviceId, handoffId in
            self?.answerFromNotification(action, deviceId: deviceId, handoffId: handoffId)
        }
        HandoffNotifier.shared.isShowing = { [weak self] deviceId in
            NSApp.isActive && self?.selection == deviceId
        }
        Task { await connect() }
    }

    func connect() async {
        connection = .connecting("Looking for daemon…")
        await replaceOutdatedDaemon()
        if await tryAttach() { return }
        connection = .connecting("Starting daemon…")
        do { try DaemonLocator.launch() } catch {
            connection = .failed("Daemon not running — \(error.localizedDescription)")
            scheduleRetry()
            return
        }
        for _ in 0..<40 {
            try? await Task.sleep(for: .milliseconds(500))
            if await tryAttach() { return }
        }
        connection = .failed("Daemon not running")
        scheduleRetry()
    }

    private func scheduleRetry() {
        Task {
            try? await Task.sleep(for: .seconds(5))
            if !connection.isConnected, await tryAttach() { return }
            if !connection.isConnected { scheduleRetry() }
        }
    }

    /// After an update Sparkle relaunches the app, but the daemon the old version started keeps running the old
    /// code. Stop it so `connect` launches this version's; if it won't stop, attach to it as before.
    private func replaceOutdatedDaemon() async {
        guard let f = DaemonLocator.readDaemonFile(), let pid = f.pid,
              DaemonLocator.isOutdatedBundledDaemon(pid: pid, version: f.version) else { return }
        connection = .connecting("Restarting daemon for PhoneDock \(UpdateController.shared.currentVersion)…")
        if !(await DaemonLocator.stop(pid: pid)) { NSLog("PhoneDock: outdated daemon (pid \(pid), \(f.version ?? "?")) didn't stop") }
    }

    private func tryAttach() async -> Bool {
        guard let f = DaemonLocator.readDaemonFile(), let h = await DaemonLocator.health(port: f.port) else { return false }
        client = DaemonClient(base: URL(string: "http://127.0.0.1:\(f.port)")!, token: f.token)
        connection = .connected(version: h.version ?? f.version)
        daemonPid = h.pid ?? f.pid
        daemonOrigin = daemonPid.map(DaemonLocator.origin(ofDaemon:)) ?? .unknown
        await refresh()
        startEvents()
        startPolling()
        return true
    }

    func refresh() async {
        guard let c = client else { return }
        let signpostID = OSSignpostID(log: perfLog)
        os_signpost(.begin, log: perfLog, name: "Refresh", signpostID: signpostID)
        defer { os_signpost(.end, log: perfLog, name: "Refresh", signpostID: signpostID) }
        let knownHandoffs = Set(handoffs.keys)
        do {
            let list = try await c.get([Device].self, "/v1/devices", timeout: 30)
            applyDevices(list)
            mergeHandoffs(from: list, knownBefore: knownHandoffs)
        } catch {
            if await DaemonLocator.health(port: c.base.port ?? 0) == nil {
                connection = .failed("Daemon stopped responding")
                client = nil
                eventsTask?.cancel(); pollTask?.cancel()
                Task { await connect() }
            }   // background polling never alerts; the connection pill shows trouble
        }
        if backends.isEmpty { await loadBackends() }
    }

    /// Only on an explicit user click: stops the attached daemon and launches it again as a child of this app, so it
    /// inherits the app's Local Network permission. Never called automatically.
    func restartDaemonFromApp() {
        guard !restartingDaemon, !SelfTest.blocksForeground("Restart Service confirmation") else { return }
        let a = NSAlert()
        a.messageText = "Restart PhoneDock’s background service?"
        a.informativeText = "Wi-Fi phones need the service to run from this app. Agents lose control of their devices "
            + "and recordings stop; the devices keep running."
        a.alertStyle = .warning
        a.addButton(withTitle: "Restart Service")
        a.addButton(withTitle: "Cancel")
        guard a.runModal() == .alertFirstButtonReturn else { return }
        restartingDaemon = true
        Task {
            defer { restartingDaemon = false }
            let pid = daemonPid
            eventsTask?.cancel(); pollTask?.cancel()
            client = nil; liveUpdates = false
            connection = .connecting("Stopping daemon…")
            if let pid, !(await DaemonLocator.stop(pid: pid)) {
                connection = .failed("Couldn’t stop the daemon (pid \(pid))")
                problem = FriendlyError(title: "Couldn’t restart PhoneDock’s service", message: "Quit other copies of PhoneDock, then try again.", details: "Daemon pid \(pid) didn’t stop. Run `phonedock daemon stop`, then click Retry.")
                scheduleRetry()
                return
            }
            connection = .connecting("Starting daemon…")
            do { try DaemonLocator.launch() } catch {
                connection = .failed("Daemon not running — \(error.localizedDescription)")
                scheduleRetry()
                return
            }
            for _ in 0..<40 {
                try? await Task.sleep(for: .milliseconds(500))
                if await tryAttach() { return }
            }
            connection = .failed("Daemon not running")
            scheduleRetry()
        }
    }

    /// Refreshes `backends`; false when the service didn't answer (the last list is kept).
    @discardableResult
    func loadBackends() async -> Bool {
        guard let c = client else { return false }
        guard let b = try? await c.get([BackendInfo].self, "/v1/backends", timeout: 30) else { return false }
        backends = b
        return true
    }

    /// Self-test only: device-id prefixes to leave out of the window (`PHONEDOCK_APP_SELFTEST_HIDE=ios-device:`), so
    /// screenshots for docs never show a personal phone. `name:<prefix>` matches device names instead (simulator ids
    /// are UDIDs).
    static let selfTestHidden: [String] = SelfTest.enabled
        ? (ProcessInfo.processInfo.environment["PHONEDOCK_APP_SELFTEST_HIDE"] ?? "").split(separator: ",").map(String.init) : []

    private static func selfTestHides(_ d: Device) -> Bool {
        selfTestHidden.contains { p in p.hasPrefix("name:") ? d.name.hasPrefix(p.dropFirst(5)) : d.id.hasPrefix(p) }
    }

    /// Self-test only: display names for media captures (`PHONEDOCK_APP_SELFTEST_RENAME=pdtest-media-ios=iPhone 17 Pro,…`).
    /// A service run with PHONEDOCK_DEVICE_FILTER refuses `phonedock update --name` to a name without its prefix, so
    /// launch footage relabels its test devices here instead. Only the window's labels change; ids are untouched.
    static let selfTestRename: [String: String] = SelfTest.enabled
        ? Dictionary((ProcessInfo.processInfo.environment["PHONEDOCK_APP_SELFTEST_RENAME"] ?? "").split(separator: ",").compactMap { pair in
            let kv = pair.split(separator: "=", maxSplits: 1).map(String.init)
            return kv.count == 2 ? (kv[0], kv[1]) : nil
        }, uniquingKeysWith: { a, _ in a }) : [:]

    private static func relabel(_ d: Device) -> Device {
        guard let n = selfTestRename[d.name] else { return d }
        var r = d; r.name = n; return r
    }

    private func applyDevices(_ list: [Device]) {
        var list = Self.selfTestHidden.isEmpty ? list : list.filter { !Self.selfTestHides($0) }
        if !Self.selfTestRename.isEmpty { list = list.map(Self.relabel) }
        let sorted = list.sorted { ($0.kind, $0.name.lowercased()) < ($1.kind, $1.name.lowercased()) }
        if sorted != devices { devices = sorted }
        // Restore the last selection (or PHONEDOCK_SELECT=<name|id>) once; never auto-pick a device, so the app
        // doesn't start streaming someone's phone just because it launched.
        if !restoredSelection, !devices.isEmpty {
            restoredSelection = true
            let want = ProcessInfo.processInfo.environment["PHONEDOCK_SELECT"] ?? UserDefaults.standard.string(forKey: "lastSelection")
            if let want, let d = devices.first(where: { $0.id == want || $0.name == want }) { selection = d.id }
        }
        if let s = selection, !devices.contains(where: { $0.id == s }) { selection = nil }
        clearLeaseToastIfControlChanged()
    }

    /// "Claude Code is using this device" is only true while it is. Once you hold it or nobody does, the toast goes.
    private func clearLeaseToastIfControlChanged() {
        guard let id = toast?.clearsOnControlChange, let d = devices.first(where: { $0.id == id }) else { return }
        if d.leasedByHuman || d.lease == nil { toast = nil }
    }

    private func upsert(_ d: Device) {
        let d = Self.selfTestRename.isEmpty ? d : Self.relabel(d)
        if let i = devices.firstIndex(where: { $0.id == d.id }) { if devices[i] != d { devices[i] = d; clearLeaseToastIfControlChanged() } }
        else { applyDevices(devices + [d]) }
    }

    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                let live = self?.liveUpdates ?? false
                try? await Task.sleep(for: .seconds(live ? 10 : 2))
                guard !Task.isCancelled, let self, self.client != nil else { return }
                await self.refresh()
                await self.checkCrashes()
            }
        }
    }

    /// An app crashed on the device you're looking at: say so, with View. The first look only records what's there.
    private func checkCrashes() async {
        guard let c = client, let d = selectedDevice, d.isRunning, d.can("crashes"),
              Date().timeIntervalSince(lastCrashCheck) > 6 else { return }
        lastCrashCheck = Date()
        guard let list = try? await c.get([CrashReport].self, c.dev(d.id, "/crashes"), query: ["limit": "10"], timeout: 20) else { return }
        let ids = Set(list.map(\.id))
        defer { crashBaseline[d.id] = (crashBaseline[d.id] ?? []).union(ids) }
        guard let known = crashBaseline[d.id] else { return }
        guard let fresh = list.first(where: { !known.contains($0.id) }) else { return }
        let more = ids.subtracting(known).count - 1
        let what = fresh.kind == "anr" ? "isn’t responding" : fresh.kind == "jetsam" ? "ran out of memory" : "crashed"
        toast = Toast(kind: .error, title: "\(fresh.title) \(what)",
                      message: (more > 0 ? "\(more) more since you looked. " : "") + "On \(d.name).",
                      actionTitle: "View", action: { [weak self] in
                          self?.selection = d.id
                          self?.requestedInspectorTab = .crashes
                      }, duration: 12)
    }

    private func startEvents() {
        eventsTask?.cancel()
        guard let c = client else { return }
        eventsTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    var req = try c.request("GET", "/v1/events", timeout: 3600)
                    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    let (bytes, resp) = try await DaemonClient.session.bytes(for: req)
                    guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw APIError(status: 0, code: "sse", message: "no events") }
                    self?.liveUpdates = true
                    var event = "message"; var data = ""
                    for try await line in bytes.lines {
                        if line.hasPrefix("event:") { event = line.dropFirst(6).trimmingCharacters(in: .whitespaces) }
                        else if line.hasPrefix("data:") { data += line.dropFirst(5).trimmingCharacters(in: .whitespaces) }
                        else if line.isEmpty || line.hasPrefix(":") {
                            if !data.isEmpty { self?.handleEvent(event, data) }
                            event = "message"; data = ""
                        }
                        // URLSession's `lines` drops empty lines, so dispatch eagerly once data is present.
                        if !data.isEmpty && line.hasPrefix("data:") { self?.handleEvent(event, data); event = "message"; data = "" }
                    }
                } catch {}
                self?.liveUpdates = false
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    private func handleEvent(_ event: String, _ data: String) {
        let signpostID = OSSignpostID(log: perfLog)
        os_signpost(.begin, log: perfLog, name: "SSE handling", signpostID: signpostID)
        defer { os_signpost(.end, log: perfLog, name: "SSE handling", signpostID: signpostID) }
        let d = Data(data.utf8)
        switch event {
        case "device":
            if let dev = try? JSONDecoder().decode(Device.self, from: d) { upsert(dev) }
            else if let obj = try? JSONDecoder().decode(JSONValue.self, from: d), let dev = obj["device"],
                    let dd = try? JSONEncoder().encode(dev), let dev2 = try? JSONDecoder().decode(Device.self, from: dd) { upsert(dev2) }
            else { Task { await refresh() } }
        case "job":
            if let j = try? JSONDecoder().decode(Job.self, from: d), jobs[j.id] != nil { jobs[j.id] = j }
        case "lease":
            Task { await refresh() }
        case "action":
            NotificationCenter.default.post(name: .phoneDockAction, object: nil)
        case "recording":
            if let obj = try? JSONDecoder().decode(JSONValue.self, from: d), let id = obj["deviceId"]?.stringValue {
                applyRecordingEvent(id, obj)
            }
        case "handoff":
            if let h = try? JSONDecoder().decode(Handoff.self, from: d) { applyHandoff(h) }
            else if let obj = try? JSONDecoder().decode(JSONValue.self, from: d), let inner = obj["handoff"],
                    let dd = try? JSONEncoder().encode(inner), let h = try? JSONDecoder().decode(Handoff.self, from: dd) { applyHandoff(h) }
            else { Task { await refresh() } }
        default: break
        }
    }

    // MARK: Handoffs

    /// The newest pending handoff for a device, if any.
    func pendingHandoff(for deviceId: String) -> Handoff? {
        handoffs.values.filter { $0.deviceId == deviceId }.max { ($0.createdAt ?? "") < ($1.createdAt ?? "") }
    }

    /// Device lists carry the pending handoff. Handoffs we knew before the request started but that are gone now were
    /// resolved elsewhere; ones that arrived over SSE while the request was in flight are kept.
    private func mergeHandoffs(from list: [Device], knownBefore: Set<String>) {
        var seen = Set<String>()
        for d in list { if let h = d.handoff, h.isPending { seen.insert(h.id); applyHandoff(h) } }
        for id in knownBefore where !seen.contains(id) {
            handoffs.removeValue(forKey: id)
            HandoffNotifier.shared.withdraw(id)
        }
        updateHandoffBadge()
    }

    /// The Dock badge counts what the sidebar shows: waiting requests on listed devices.
    private func updateHandoffBadge() {
        let listed = Set(devices.map(\.id))
        HandoffNotifier.shared.setBadge(handoffs.values.filter { listed.contains($0.deviceId) }.count)
    }

    /// A notification button: Take Over selects the device and takes it; Done and Can't Do It answer right away.
    private func answerFromNotification(_ action: HandoffNotifier.Action, deviceId: String, handoffId: String) {
        guard let d = devices.first(where: { $0.id == deviceId }) else { return }
        switch action {
        case .takeOver:
            if d.leasedByAgent || d.lease == nil { takeOver(d) }
        case .done, .cantDo:
            let h = handoffs[handoffId] ?? Handoff(id: handoffId, deviceId: deviceId, reason: "", state: "pending")
            Task { await resolveHandoff(h, done: action == .done) }
        }
    }

    func applyHandoff(_ h: Handoff) {
        if h.isPending && !resolvedHandoffs.contains(h.id) {
            if handoffs[h.id] != h { handoffs[h.id] = h }
            if !notifiedHandoffs.contains(h.id) {
                notifiedHandoffs.insert(h.id)
                let name = devices.first { $0.id == h.deviceId }?.name ?? h.deviceId
                HandoffNotifier.shared.notify(h, deviceName: name)
            }
        } else {
            if !h.isPending { resolvedHandoffs.insert(h.id) }
            handoffs.removeValue(forKey: h.id)
            HandoffNotifier.shared.withdraw(h.id)
        }
        updateHandoffBadge()
    }

    /// Resolves a handoff (`done` or `cancelled`), then gives the device back to the agent if the human holds it.
    @discardableResult
    func resolveHandoff(_ h: Handoff, done: Bool, note: String? = nil) async -> Bool {
        guard let c = client else { toast = Toast(title: "PhoneDock isn’t connected", message: "It reconnects automatically."); return false }
        var body: [String: Any] = ["state": done ? "done" : "cancelled"]
        if let n = note?.trimmingCharacters(in: .whitespacesAndNewlines), !n.isEmpty { body["note"] = n }
        var ok = true
        // Before sending: the service's event that the request ended can arrive before the reply does.
        answeredHere.insert(h.id)
        do {
            try await c.send("POST", "/v1/handoffs/\(DaemonClient.enc(h.id))/resolve", json: body, timeout: 30)
            // The card goes away the moment the answer lands; say what happens next, not which button was pressed.
            let who = h.requestedBy == nil ? "the agent" : h.requesterName
            let noted = body["note"] == nil ? nil : done ? "Your note went with it." : "Your reason went with it."
            toast = done
                ? Toast(kind: .info, title: "\(who.prefix(1).uppercased() + who.dropFirst()) will continue", message: noted)
                : Toast(kind: .info, title: "Told \(who) you can’t do it", message: noted)
        } catch let e as APIError where e.status == 404 || e.status == 409 {
            toast = Toast(kind: .info, title: "This request has ended", details: e.rawDetails)   // resolved elsewhere or timed out
            ok = false
        } catch {
            answeredHere.remove(h.id)   // still pending: the card stays and can be answered again
            fail("Couldn’t send your answer", error)
            return false
        }
        var resolved = h
        resolved.state = done ? "done" : "cancelled"
        applyHandoff(resolved)
        if let d = devices.first(where: { $0.id == h.deviceId }), d.leasedByHuman {
            _ = try? await c.send("DELETE", c.dev(d.id, "/lease"), timeout: 30)
        }
        await refresh()
        return ok
    }

    // MARK: Recording

    func syncRecording(_ d: Device) async {
        guard let c = client, d.can("record"), !recordingUnsupported.contains(d.id) else { return }
        do {
            let s = try await c.get(RecordingStatus.self, c.dev(d.id, "/recording"), timeout: 15)
            if s.active {
                let started = s.startedAt.flatMap(ISO8601DateFormatter.flexible) ?? recordings[d.id]?.startedAt ?? Date()
                recordings[d.id] = RecordingState(path: s.path, startedAt: started)
            } else if recordings[d.id] != nil {
                recordings[d.id] = nil   // stopped by an agent or hit maxSeconds
                if let p = s.path { recordingFinished(d.id, path: p, size: nil) }
            }
        } catch let e as APIError where e.status == 501 || e.code == "not_supported" {
            recordingUnsupported.insert(d.id)
        } catch {}
    }

    /// SSE `recording` event: `{deviceId, active, path, startedAt?, sizeBytes?, autoStopped?}`.
    private func applyRecordingEvent(_ id: String, _ obj: JSONValue) {
        if case .bool(true)? = obj["active"] {
            let started = obj["startedAt"]?.stringValue.flatMap(ISO8601DateFormatter.flexible) ?? recordings[id]?.startedAt ?? Date()
            recordings[id] = RecordingState(path: obj["path"]?.stringValue, startedAt: started)
        } else {
            recordings[id] = nil
            if let p = obj["path"]?.stringValue {
                var size: Double?
                if case .number(let n)? = obj["sizeBytes"] { size = n }
                recordingFinished(id, path: p, size: size)
            }
        }
    }

    /// A recording's file is final. One the app started moves to the user's folder with a readable name
    /// ("Pixel 9 2026-11-04 at 14.02.11.mp4"); then `savedRecordings` changes once, which posts the toast.
    private func recordingFinished(_ id: String, path: String, size: Double?) {
        guard finishedRecordingPaths.insert(path).inserted else { return }
        guard let started = appRecordings.removeValue(forKey: id), let d = devices.first(where: { $0.id == id }) else {
            savedRecordings[id] = RecordingResult(path: path, sizeBytes: size)
            return
        }
        let src = URL(fileURLWithPath: path)
        let dst = SavedMedia.url(for: d.name, at: started, ext: src.pathExtension.isEmpty ? "mp4" : src.pathExtension)
        Task {
            let moved = await Task.detached { SavedMedia.move(src, to: dst) }.value
            savedRecordings[id] = RecordingResult(path: (moved ? dst : src).path, sizeBytes: size)
        }
    }

    func startRecording(_ d: Device) {
        guard let c = client else { return }
        savedRecordings[d.id] = nil
        appRecordings[d.id] = Date()
        recordings[d.id] = RecordingState(path: nil, startedAt: Date(), starting: true)
        Task {
            do {
                // The daemon caps recordings (default 300 s); a person recording by hand gets the maximum.
                let data = try await c.send("POST", c.dev(d.id, "/recording/start"), json: ["maxSeconds": 3600], timeout: 30)
                let obj = try? JSONDecoder().decode(JSONValue.self, from: data)
                let started = obj?["startedAt"]?.stringValue.flatMap(ISO8601DateFormatter.flexible) ?? Date()
                appRecordings[d.id] = started
                recordings[d.id] = RecordingState(path: obj?["path"]?.stringValue, startedAt: started)
            } catch let e as APIError where e.code == "recording_active" {
                appRecordings[d.id] = nil   // someone else's recording
                await syncRecording(d)
            } catch let e as APIError where e.code == "lease_conflict" {
                recordings[d.id] = nil
                appRecordings[d.id] = nil
                toast = Toast(kind: .info, title: "Take over \(d.name) to record it", details: e.rawDetails, actionTitle: "Take Over", action: { self.takeOver(d) })
            } catch let e as APIError where e.status == 501 || e.code == "not_supported" {
                recordings[d.id] = nil
                appRecordings[d.id] = nil
                recordingUnsupported.insert(d.id)
                toast = Toast(kind: .info, title: "Recording isn’t available for this device", details: e.rawDetails)
            } catch {
                recordings[d.id] = nil
                appRecordings[d.id] = nil
                fail("Couldn’t start recording", error, device: d)
            }
        }
    }

    func stopRecording(_ d: Device) {
        guard let c = client else { return }
        recordings[d.id]?.stopping = true
        Task {
            do {
                let data = try await c.send("POST", c.dev(d.id, "/recording/stop"), json: [:], timeout: 90)
                recordings[d.id] = nil
                if let r = try? JSONDecoder().decode(RecordingResult.self, from: data) { recordingFinished(d.id, path: r.path, size: r.sizeBytes) }
            } catch let e as APIError where e.code == "not_recording" {
                recordings[d.id] = nil
            } catch {
                recordings[d.id]?.stopping = false
                fail("Couldn’t stop recording", error, device: d)
                await syncRecording(d)
            }
        }
    }

    // MARK: Jobs

    /// Polls a job until it finishes, keeping `jobs[id]` up to date. Returns the final job. A failure says what failed
    /// (`failure`, e.g. "Couldn’t start Pixel 9") and the service's explanation and fix: a toast for a one-off action,
    /// the alert when `blocking` (DECISIONS §6).
    @discardableResult
    func track(_ job: Job, device: String? = nil, failure: String? = nil, blocking: Bool = false) async -> Job {
        jobs[job.id] = job
        if let device { deviceJobs[device] = job.id }
        var current = job
        while !current.isFinished {
            try? await Task.sleep(for: .milliseconds(800))
            guard let c = client else { break }
            if let j = try? await c.get(Job.self, "/v1/jobs/\(DaemonClient.enc(job.id))", timeout: 15) {
                current = j
                jobs[j.id] = j
            }
        }
        if let device, deviceJobs[device] == job.id { deviceJobs[device] = nil }
        if current.isFailed {
            let d = device.flatMap { id in devices.first { $0.id == id } }
            let title = failure ?? d.map { "Couldn’t finish on \($0.name)" } ?? "That didn’t finish"
            let p = FriendlyError.from(job: current, title: title, device: d)
            if blocking { problem = p } else { toast = Toast(title: p.title, message: p.message, details: p.details) }
        }
        await refresh()
        return current
    }

    // MARK: Actions

    /// Runs a one-off action. `failure` is the title if it fails ("Couldn’t shut down Pixel 9"); one-off failures
    /// become a toast, `blocking` ones the alert.
    /// With `busy` ("Saving snapshot…"), the device shows that and refuses power changes until the action and the
    /// following refresh finish.
    func perform(_ failure: String, device: Device? = nil, blocking: Bool = false, busy label: String? = nil,
                 pending quick: String? = nil, _ op: @escaping (DaemonClient) async throws -> Void) {
        guard let c = client else { toast = Toast(title: "PhoneDock isn’t connected", message: "It reconnects automatically."); return }
        let busyId = label == nil ? nil : device?.id
        if let busyId { busy[busyId] = label }
        let pendingId = quick == nil ? nil : device?.id
        if let pendingId { pending[pendingId] = quick }
        Task {
            do { try await op(c) } catch { fail(failure, error, device: device, blocking: blocking) }
            await refresh()
            if let busyId { busy[busyId] = nil }
            if let pendingId { pending[pendingId] = nil }
        }
    }

    /// Shows a failure the way the error pattern says: toast for one-off actions, alert when `blocking`.
    func fail(_ title: String, _ error: Error, device: Device? = nil, blocking: Bool = false) {
        let p = FriendlyError.from(error, title: title, device: device)
        if blocking { problem = p; return }
        var t = Toast(title: p.title, message: p.message, details: p.details)
        if let d = device, (error as? APIError)?.code == "lease_conflict" {
            // Not an error: someone else is simply in control. Informational, nothing to copy, gone once control changes.
            t = Toast(kind: .info, title: p.title, message: p.message, actionTitle: "Take Over",
                      action: { [weak self] in self?.takeOver(d) }, clearsOnControlChange: d.id)
        }
        toast = t
    }

    func boot(_ d: Device, cold: Bool = false, window: Bool = false) {
        guard let c = client else { return }
        pending[d.id] = "Starting…"   // until the service has the job: the click answers at once
        Task {
            do {
                var body: [String: Any] = [:]
                if cold { body["coldBoot"] = true }
                if window { body["window"] = true; body["headless"] = false }
                let job = try await c.sendJob("POST", c.dev(d.id, "/boot"), json: body)
                pending[d.id] = nil
                await track(job, device: d.id, failure: "Couldn’t start \(d.name)")
            } catch { pending[d.id] = nil; fail("Couldn’t start \(d.name)", error, device: d) }
        }
    }

    func shutdown(_ d: Device) { perform("Couldn’t shut down \(d.name)", device: d, pending: "Shutting down…") { try await $0.send("POST", $0.dev(d.id, "/shutdown")) } }
    /// "Deleting…" for the whole operation (it shuts the device down first), then a toast, and the selection moves to
    /// the next device in the list, as in Finder and Mail, instead of leaving an empty window.
    func delete(_ d: Device) {
        perform("Couldn’t delete \(d.name)", device: d, blocking: true, busy: "Deleting…") { [weak self] c in
            try await c.send("DELETE", c.dev(d.id))
            await MainActor.run {
                guard let self else { return }
                if self.selection == d.id {
                    let order = self.devices.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
                    let i = order.firstIndex { $0.id == d.id } ?? 0
                    let rest = order.filter { $0.id != d.id }
                    self.selection = rest.isEmpty ? nil : rest[min(i, rest.count - 1)].id
                }
                self.toast = Toast(kind: .success, title: "Deleted \(d.name)")
            }
        }
    }
    func takeOver(_ d: Device) { perform("Couldn’t take over \(d.name)", device: d, pending: "Taking over…") { try await $0.send("POST", $0.dev(d.id, "/lease"), json: ["owner": AppIdentity.owner, "force": true]) } }
    func handBack(_ d: Device) { perform("Couldn’t hand back \(d.name)", device: d, pending: "Handing back…") { try await $0.send("DELETE", $0.dev(d.id, "/lease")) } }
    func openWindow(_ d: Device) {
        if SelfTest.blocksForeground("\(d.windowActionTitle) for \(d.name)") { return }
        let before = SeparateWindows.scrcpyPids()
        perform(d.backend == "ios-simulator" ? "Couldn’t open \(d.name) in Simulator" : "Couldn’t open \(d.name) in a separate window", device: d) { c in
            try await c.send("POST", c.dev(d.id, "/window"))
            // The service starts scrcpy on its own and it would outlive this app: remember it, close it at quit.
            if d.backend.hasPrefix("android") {
                try? await Task.sleep(for: .seconds(1.5))
                await MainActor.run { SeparateWindows.remember(since: before, nativeId: d.nativeId ?? d.name) }
            }
        }
    }

    /// Makes a device and closes nothing: the sheet is gone, the sidebar shows the work, the alert reports a failure.
    func createDevice(spec: [String: Any], name: String, platform: String) {
        guard let c = client else { return }
        let p = PendingDevice(id: UUID(), name: name, platform: platform, stage: "Creating…")
        creating.append(p)
        func update(_ f: (inout PendingDevice) -> Void) { if let i = creating.firstIndex(where: { $0.id == p.id }) { f(&creating[i]) } }
        Task {
            defer { creating.removeAll { $0.id == p.id } }
            do {
                let job = try await c.sendJob("POST", "/v1/devices", json: spec)
                jobs[job.id] = job
                var cur = job
                var selected = false
                while !cur.isFinished {
                    try? await Task.sleep(for: .milliseconds(800))
                    if let j = try? await c.get(Job.self, "/v1/jobs/\(DaemonClient.enc(job.id))", timeout: 15) { cur = j; jobs[j.id] = j }
                    let booting = cur.progress?.contains { $0.lowercased().contains("boot") } ?? false
                    update { $0.stage = booting ? StageText.start(cur) : "Creating…" }
                    // The record exists after "creating"; the sidebar row takes over from the placeholder.
                    await refresh()
                    if let d = devices.first(where: { $0.name == name && $0.backend == (spec["backend"] as? String ?? $0.backend) }) {
                        deviceJobs[d.id] = job.id
                        if !selected { selected = true; selection = d.id }
                        creating.removeAll { $0.id == p.id }
                    }
                }
                for (k, v) in deviceJobs where v == job.id { deviceJobs[k] = nil }
                await refresh()
                if cur.isFailed { problem = FriendlyError.from(job: cur, title: "Couldn’t create \(name)") }
                else if let id = cur.resultDeviceId, !selected { selection = id }
            } catch {
                problem = FriendlyError.from(error, title: "Couldn’t create \(name)")
            }
        }
    }
    /// Home on a sleeping Android phone wakes it first (the key alone would only light the screen).
    func key(_ d: Device, _ k: String) {
        let wake = k == "home" && d.platform == "android" && asleep.contains(d.id)
        perform("That key didn’t reach \(d.name)", device: d) {
            if wake { try await $0.input(d.id, ["action": "key", "key": "wake"]); try? await Task.sleep(for: .milliseconds(400)) }
            try await $0.input(d.id, ["action": "key", "key": k])
        }
    }

    /// The Wake action of "The phone is asleep": Android has a wake key; an iPhone simulator wakes with its lock button.
    func wake(_ d: Device) {
        asleep.remove(d.id)
        perform("Couldn’t wake \(d.name)", device: d) { try await $0.input(d.id, ["action": "key", "key": d.platform == "android" ? "wake" : "lock"]) }
    }

    /// Turns the screen the other way from how it is now. A press while the last one is still turning goes from that
    /// one's target, so quick presses alternate too.
    func rotate(_ d: Device) {
        let now = rotating[d.id] ?? d.orientation ?? d.screen.map { $0.width > $0.height ? "landscape" : "portrait" } ?? "portrait"
        let target = now == "landscape" ? "portrait" : "landscape"
        rotating[d.id] = target
        perform("Couldn’t rotate \(d.name)", device: d) { [weak self] c in
            defer { Task { @MainActor in if self?.rotating[d.id] == target { self?.rotating[d.id] = nil } } }
            let data = try await c.send("POST", c.dev(d.id, "/rotate"), json: ["orientation": target])
            struct Result: Decodable { var orientation: String?; var screen: ScreenInfo? }
            guard let r = try? JSONDecoder().decode(Result.self, from: data) else { return }
            await MainActor.run {
                // the record follows at once, so a quick next press turns the other way (the device event comes later)
                if let s = self, let i = s.devices.firstIndex(where: { $0.id == d.id }) {
                    if let o = r.orientation { s.devices[i].orientation = o }
                    if let sc = r.screen { s.devices[i].screen = sc }
                }
                // An app that keeps its orientation (the phone home screen, many games) doesn't turn: say so.
                if let o = r.orientation, o != target {
                    self?.toast = Toast(kind: .info, title: "The screen stays in \(o)",
                                        message: "The app on screen doesn’t rotate. Open one that does and it turns.")
                }
            }
        }
    }

    /// Saves to the user's screenshot folder (`SavedMedia.folder`) and says so with a toast, as recordings do.
    func screenshot(_ d: Device) {
        if asleep.contains(d.id) {
            toast = Toast(kind: .info, title: "\(d.name) is asleep", message: "A screenshot would be black. Wake it first.",
                          actionTitle: "Wake", action: { [weak self] in self?.wake(d) })
            return
        }
        perform("Couldn’t save a screenshot", device: d) { c in
            let (data, _) = try await c.raw("GET", c.dev(d.id, "/screenshot"), query: ["format": "png"])
            let url = SavedMedia.url(for: d.name, at: Date(), ext: "png")
            try data.write(to: url)
            await MainActor.run { self.announceSaved(.screenshot, url: url, size: Double(data.count)) }
        }
    }

    /// "Screenshot saved to Desktop" / "Recording saved to Desktop", the size under it, and Show in Finder.
    func announceSaved(_ kind: SavedMedia.Kind, url: URL, size: Double?) {
        let where_ = SavedMedia.displayName(of: url.deletingLastPathComponent())
        let size = size ?? (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.doubleValue
        // Where it went is in the title: that's what the person looks for next.
        toast = Toast(kind: .success, title: "\(kind == .screenshot ? "Screenshot" : "Recording") saved to \(where_)",
                      message: size.map { ByteCountFormatter.string(fromByteCount: Int64($0), countStyle: .file) }, actionTitle: "Show in Finder",
                      action: { if !SelfTest.blocksForeground("Show in Finder \(url.lastPathComponent)") { NSWorkspace.shared.activateFileViewerSelecting([url]) } },
                      duration: kind == .screenshot ? 6 : 10)
    }

    func installApp(_ d: Device, path: String) {
        perform("Couldn’t install the app", device: d, blocking: true) { try await $0.send("POST", $0.dev(d.id, "/apps"), json: ["path": path]) }
    }
}

/// A device the service is still making (the New Device sheet has already closed).
struct PendingDevice: Identifiable, Equatable {
    let id: UUID
    var name: String
    var platform: String
    var stage: String
    var deviceId: String?
}

/// Stage text for a device that is being created or started ("Starting… (installing system image)").
enum StageText {
    static func start(_ job: Job?) -> String {
        let line = (job?.lastLine ?? "").lowercased()
        let installing = ["system image", "install", "download", "unpack", "extract", "first boot", "optimiz"].contains { line.contains($0) }
        return installing ? "Starting… (installing system image)" : "Starting…"
    }
}

struct RecordingState: Equatable {
    var path: String?
    var startedAt: Date
    var starting = false
    var stopping = false
}

extension Notification.Name {
    static let phoneDockAction = Notification.Name("PhoneDockAction")
}

extension Device {
    /// Where "Open in …" opens the device: iPhone simulators in Apple's Simulator, which people know by name; others
    /// in a separate window (Android mirrors through scrcpy, which the tooltip names, not the menu).
    var windowActionName: String { backend == "ios-simulator" ? "Simulator" : "Separate Window" }
    var windowActionTitle: String { "Open in \(windowActionName)" }
    var windowActionHelp: String {
        if backend.hasPrefix("android") { return "Mirror \(name) in a separate window you can move anywhere (scrcpy)" }
        if backend == "ios-simulator" { return "Show \(name) in Simulator" }
        return "Open \(name) in a separate window"
    }
}

/// scrcpy windows PhoneDock asked for. The service starts them detached, so they would stay behind when the app quits;
/// the app remembers which processes appeared because of its request and ends them when it quits.
@MainActor
enum SeparateWindows {
    private static var pids: Set<Int32> = []

    nonisolated static func scrcpyPids() -> Set<Int32> {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        p.arguments = ["-x", "scrcpy"]
        let out = Pipe()
        p.standardOutput = out; p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return [] }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return Set(String(decoding: data, as: UTF8.self).split(whereSeparator: \.isNewline).compactMap { Int32($0) })
    }

    private static func args(_ pid: Int32) -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/ps")
        p.arguments = ["-o", "args=", "-p", String(pid)]
        let out = Pipe()
        p.standardOutput = out; p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return "" }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(decoding: data, as: UTF8.self)
    }

    static func remember(since before: Set<Int32>, nativeId: String) {
        for pid in scrcpyPids().subtracting(before) where args(pid).contains(nativeId) { pids.insert(pid) }
    }

    /// Called when the app quits.
    static func closeAll() {
        for pid in pids where scrcpyPids().contains(pid) { kill(pid, SIGTERM) }
        pids = []
    }
}
