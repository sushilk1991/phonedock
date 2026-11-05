import Foundation
import AppKit
import ImageIO
import Darwin
import os.signpost

let perfLog = OSLog(subsystem: "dev.phonedock.app", category: "perf")

struct APIError: LocalizedError, Sendable, Hashable {
    var status: Int
    var code: String
    var message: String
    var hints: [String] = []
    /// Raw cause from the daemon (command, exit code, stderr). Only shown under Details.
    var detail: String? = nil
    var errorDescription: String? {
        hints.isEmpty ? message : message + "\n" + hints.map { "• " + $0 }.joined(separator: "\n")
    }
}

struct FrameResult: Sendable {
    var image: NSImage?
    var deviceWidth: Double?
    var deviceHeight: Double?
    var fetchMs: Double = 0
    var decodeMs: Double = 0
    var bytes: Int = 0
    var etag: String?
}

/// Thin async HTTP client for the PhoneDock daemon. Immutable + Sendable so it can be used from any task.
struct DaemonClient: Sendable {
    let base: URL
    let token: String

    static let session: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 60
        cfg.httpMaximumConnectionsPerHost = 8
        return URLSession(configuration: cfg)
    }()

    static func enc(_ id: String) -> String {
        id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? id
    }

    func request(_ method: String, _ path: String, query: [String: String] = [:], body: Encodable? = nil, json: [String: Any]? = nil, timeout: TimeInterval = 60) throws -> URLRequest {
        guard var comps = URLComponents(string: base.absoluteString + path) else {
            throw APIError(status: 0, code: "bad_url", message: "Bad path \(path)")
        }
        if !query.isEmpty { comps.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) } }
        var req = URLRequest(url: comps.url!)
        req.httpMethod = method
        req.timeoutInterval = timeout
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue(AppIdentity.owner, forHTTPHeaderField: "X-PhoneDock-Owner")
        if let body {
            req.httpBody = try JSONEncoder().encode(AnyEncodable(body))
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        } else if let json {
            req.httpBody = try JSONSerialization.data(withJSONObject: json)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        } else if method == "POST" || method == "PATCH" {
            req.httpBody = Data("{}".utf8)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return req
    }

    func raw(_ method: String, _ path: String, query: [String: String] = [:], body: Encodable? = nil, json: [String: Any]? = nil, timeout: TimeInterval = 60) async throws -> (Data, HTTPURLResponse) {
        let req = try request(method, path, query: query, body: body, json: json, timeout: timeout)
        let (data, resp) = try await Self.session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw APIError(status: 0, code: "bad_response", message: "No HTTP response") }
        if !(200..<300).contains(http.statusCode) {
            if let e = try? JSONDecoder().decode(APIErrorBody.self, from: data) {
                throw APIError(status: http.statusCode, code: e.error.code ?? "error", message: e.error.message ?? "HTTP \(http.statusCode)", hints: e.error.hints ?? [], detail: e.error.detail)
            }
            throw APIError(status: http.statusCode, code: "http_\(http.statusCode)", message: String(data: data, encoding: .utf8)?.prefix(300).description ?? "HTTP \(http.statusCode)")
        }
        return (data, http)
    }

    func get<T: Decodable>(_ type: T.Type, _ path: String, query: [String: String] = [:], timeout: TimeInterval = 60) async throws -> T {
        let (data, _) = try await raw("GET", path, query: query, timeout: timeout)
        return try JSONDecoder().decode(T.self, from: data)
    }

    @discardableResult
    func send(_ method: String, _ path: String, json: [String: Any]? = nil, timeout: TimeInterval = 120) async throws -> Data {
        try await raw(method, path, json: json, timeout: timeout).0
    }

    func sendJob(_ method: String, _ path: String, json: [String: Any]? = nil) async throws -> Job {
        let data = try await send(method, path, json: json)
        if let env = try? JSONDecoder().decode(JobEnvelope.self, from: data) { return env.job }
        return try JSONDecoder().decode(Job.self, from: data)
    }

    func text(_ path: String, query: [String: String] = [:]) async throws -> String {
        let (data, _) = try await raw("GET", path, query: query)
        return String(decoding: data, as: UTF8.self)
    }

    func dev(_ id: String, _ suffix: String = "") -> String { "/v1/devices/\(Self.enc(id))\(suffix)" }

    func frame(_ id: String, maxSize: Int = 900, etag: String? = nil) async throws -> FrameResult {
        let fetchID = OSSignpostID(log: perfLog)
        let fetchStart = CFAbsoluteTimeGetCurrent()
        os_signpost(.begin, log: perfLog, name: "Frame fetch", signpostID: fetchID)
        let data: Data
        let http: HTTPURLResponse
        do {
            var req = try request("GET", dev(id, "/frame"), query: ["maxSize": String(maxSize)], timeout: 15)
            if let etag { req.setValue(etag, forHTTPHeaderField: "If-None-Match") }
            let (body, response) = try await Self.session.data(for: req)
            guard let response = response as? HTTPURLResponse else { throw APIError(status: 0, code: "bad_response", message: "No HTTP response") }
            guard (200..<300).contains(response.statusCode) || response.statusCode == 304 else {
                if let e = try? JSONDecoder().decode(APIErrorBody.self, from: body) { throw APIError(status: response.statusCode, code: e.error.code ?? "error", message: e.error.message ?? "HTTP \(response.statusCode)", hints: e.error.hints ?? [], detail: e.error.detail) }
                throw APIError(status: response.statusCode, code: "http_\(response.statusCode)", message: String(data: body, encoding: .utf8)?.prefix(300).description ?? "HTTP \(response.statusCode)")
            }
            (data, http) = (body, response)
        } catch {
            os_signpost(.end, log: perfLog, name: "Frame fetch", signpostID: fetchID)
            throw error
        }
        let fetchMs = (CFAbsoluteTimeGetCurrent() - fetchStart) * 1000
        os_signpost(.end, log: perfLog, name: "Frame fetch", signpostID: fetchID)
        if http.statusCode == 304 { return FrameResult(image: nil, fetchMs: fetchMs, etag: http.value(forHTTPHeaderField: "ETag") ?? etag) }
        let decodeID = OSSignpostID(log: perfLog)
        let decodeStart = CFAbsoluteTimeGetCurrent()
        os_signpost(.begin, log: perfLog, name: "Frame decode", signpostID: decodeID)
        let source = CGImageSourceCreateWithData(data as CFData, nil)
        let decoded = source.flatMap { CGImageSourceCreateImageAtIndex($0, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary) }
        let img = decoded.map { NSImage(cgImage: $0, size: NSSize(width: $0.width, height: $0.height)) }
        os_signpost(.end, log: perfLog, name: "Frame decode", signpostID: decodeID)
        let decodeMs = (CFAbsoluteTimeGetCurrent() - decodeStart) * 1000
        guard let img else { throw APIError(status: 0, code: "bad_image", message: "Undecodable frame") }
        let w = (http.value(forHTTPHeaderField: "X-Device-Width")).flatMap(Double.init)
        let h = (http.value(forHTTPHeaderField: "X-Device-Height")).flatMap(Double.init)
        return FrameResult(image: img, deviceWidth: w, deviceHeight: h, fetchMs: fetchMs, decodeMs: decodeMs, bytes: data.count, etag: http.value(forHTTPHeaderField: "ETag"))
    }

    func input(_ id: String, _ action: [String: Any]) async throws {
        try await send("POST", dev(id, "/input"), json: action, timeout: 30)
    }
}

struct AnyEncodable: Encodable {
    let value: Encodable
    init(_ v: Encodable) { value = v }
    func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
}

// MARK: - Daemon discovery / launch

enum DaemonLocator {
    static var home: URL {
        if let h = ProcessInfo.processInfo.environment["PHONEDOCK_HOME"], !h.isEmpty { return URL(fileURLWithPath: (h as NSString).expandingTildeInPath) }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/PhoneDock")
    }

    /// The source checkout for dev builds: `PHONEDOCK_REPO`, else the first parent of the executable (or the working
    /// directory) that contains src/daemon/main.ts. Bundled builds use their Resources instead.
    static let repo: String = {
        if let r = ProcessInfo.processInfo.environment["PHONEDOCK_REPO"], !r.isEmpty { return (r as NSString).expandingTildeInPath }
        let fm = FileManager.default
        for start in [Bundle.main.executableURL?.deletingLastPathComponent(), URL(fileURLWithPath: fm.currentDirectoryPath)].compactMap({ $0 }) {
            var dir = start.standardizedFileURL
            while dir.path != "/" {
                if fm.fileExists(atPath: dir.appendingPathComponent("src/daemon/main.ts").path) { return dir.path }
                dir.deleteLastPathComponent()
            }
        }
        return fm.currentDirectoryPath
    }()

    static let defaultPort = 47420

    /// `PHONEDOCK_PORT` from the environment (test daemons), else the default port.
    static var port: Int {
        if let p = ProcessInfo.processInfo.environment["PHONEDOCK_PORT"], let n = Int(p.trimmingCharacters(in: .whitespaces)), n > 0 { return n }
        return defaultPort
    }

    /// Mirrors `daemonInfoName()` in src/core/paths.ts: the default port uses daemon.json, others daemon-<port>.json.
    static func daemonInfoName(_ port: Int = port) -> String { port == defaultPort ? "daemon.json" : "daemon-\(port).json" }

    static var isBundled: Bool { Bundle.main.bundlePath.hasSuffix(".app") }

    /// docs/IPHONE-WIFI.md: bundled copy inside the app, else the repo checkout.
    static var iphoneWifiDoc: URL? {
        var cands: [URL] = []
        if isBundled, let r = Bundle.main.resourceURL { cands.append(r.appendingPathComponent("docs/IPHONE-WIFI.md")) }
        cands.append(URL(fileURLWithPath: repo + "/docs/IPHONE-WIFI.md"))
        return cands.first { FileManager.default.fileExists(atPath: $0.path) }
    }

    static var cliPath: String {
        if isBundled, let r = Bundle.main.resourceURL?.appendingPathComponent("bin/phonedock").path,
           FileManager.default.fileExists(atPath: r) { return r }
        return repo + "/bin/phonedock"
    }

    static func readDaemonFile() -> DaemonFile? {
        let url = home.appendingPathComponent(daemonInfoName())
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(DaemonFile.self, from: data)
    }

    static func health(port: Int) async -> HealthInfo? {
        guard let url = URL(string: "http://127.0.0.1:\(port)/v1/health") else { return nil }
        var req = URLRequest(url: url)
        req.timeoutInterval = 2
        guard let (data, resp) = try? await DaemonClient.session.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return (try? JSONDecoder().decode(HealthInfo.self, from: data)) ?? HealthInfo(ok: true)
    }

    static func findNode() -> String? {
        if isBundled, let n = Bundle.main.resourceURL?.appendingPathComponent("node").path,
           FileManager.default.isExecutableFile(atPath: n) { return n }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let path = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map { "\($0)/node" }
        for p in ["\(home)/.local/bin/node", "/opt/homebrew/bin/node", "/usr/local/bin/node"] + path
        where FileManager.default.isExecutableFile(atPath: p) { return p }
        return nil
    }

    static func daemonScript() -> String? {
        if isBundled, let s = Bundle.main.resourceURL?.appendingPathComponent("daemon/phonedockd.mjs").path,
           FileManager.default.fileExists(atPath: s) { return s }
        let dev = repo + "/src/daemon/main.ts"
        return FileManager.default.fileExists(atPath: dev) ? dev : nil
    }

    /// Launches the daemon detached (it keeps running after the app quits so agents can use it).
    static func launch() throws {
        guard let node = findNode() else { throw APIError(status: 0, code: "no_node", message: "Node.js not found", hints: ["Install Node 24+ (brew install node)"]) }
        guard let script = daemonScript() else { throw APIError(status: 0, code: "no_daemon", message: "Daemon not found", hints: ["Expected \(repo)/src/daemon/main.ts or a bundled daemon"]) }
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let logURL = home.appendingPathComponent(port == defaultPort ? "daemon.log" : "daemon-\(port).log")
        if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil) }
        let log = try FileHandle(forWritingTo: logURL)
        log.seekToEndOfFile()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [script]
        var env = ProcessInfo.processInfo.environment
        env["PHONEDOCK_HOME"] = home.path
        env["PHONEDOCK_PORT"] = String(port)
        if !isBundled { env["PHONEDOCK_REPO"] = repo }
        p.environment = env
        p.currentDirectoryURL = URL(fileURLWithPath: isBundled ? home.path : repo)
        p.standardOutput = log
        p.standardError = log
        p.standardInput = FileHandle.nullDevice
        try p.run()
        UserDefaults.standard.set(Int(p.processIdentifier), forKey: launchedKey)
    }

    private static var launchedKey: String { "daemonLaunchedByApp.\(port)" }

    // MARK: Who launched the daemon (Local Network privacy)

    /// macOS Local Network privacy is granted to the *responsible* process. A daemon spawned by PhoneDock.app inherits
    /// the app's permission; one started from a terminal does not and can't reach Wi-Fi phones (EHOSTUNREACH).
    enum Origin: Equatable {
        case app(String)          // responsible process is a PhoneDock.app bundle
        case other(String?)       // responsible process path (a terminal, launchd…); nil = the daemon is its own
        case unknown

        var isApp: Bool { if case .app = self { return true }; return false }
    }

    private typealias ResponsibleFn = @convention(c) (pid_t) -> pid_t
    private static let responsibleFn: ResponsibleFn? = {
        guard let h = dlopen(nil, RTLD_NOW), let sym = dlsym(h, "responsibility_get_pid_responsible_for_pid") else { return nil }
        return unsafeBitCast(sym, to: ResponsibleFn.self)
    }()

    static func processPath(_ pid: pid_t) -> String? {
        var buf = [CChar](repeating: 0, count: 4096)
        return proc_pidpath(pid, &buf, UInt32(buf.count)) > 0 ? String(cString: buf) : nil
    }

    static func origin(ofDaemon pid: Int) -> Origin {
        let p = pid_t(pid)
        guard pid > 0, processPath(p) != nil else { return .unknown }
        let recorded = UserDefaults.standard.integer(forKey: launchedKey) == pid
        guard let fn = responsibleFn else { return recorded && isBundled ? .app(Bundle.main.bundlePath) : .unknown }
        let r = fn(p)
        if r > 0, r != p, let path = processPath(r) {
            return path.contains("/PhoneDock.app/Contents/MacOS/") ? .app(path) : .other(path)
        }
        // Measured on macOS 27: once the app that spawned the daemon quits, the daemon becomes its own responsible
        // process (and so loses the app's Local Network permission). Only a live PhoneDock.app counts.
        if r > 0, r != p, recorded, isBundled { return .app(Bundle.main.bundlePath) }
        return .other(nil)
    }

    /// The command line a process was started with (KERN_PROCARGS2). Unlike `processPath`, it survives the executable
    /// being moved or deleted, which is what an in-place update does to a running daemon.
    static func processArguments(_ pid: pid_t) -> [String]? {
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = 0
        guard pid > 0, sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else { return nil }
        var buf = [UInt8](repeating: 0, count: size)
        guard sysctl(&mib, 3, &buf, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else { return nil }
        // Layout: argc, the exec path, NUL padding, then argc NUL-terminated arguments (then the environment).
        let argc = Int(buf.withUnsafeBytes { $0.load(as: Int32.self) })
        var i = MemoryLayout<Int32>.size
        while i < size, buf[i] != 0 { i += 1 }
        while i < size, buf[i] == 0 { i += 1 }
        var args: [String] = []
        while args.count < argc, i < size {
            let start = i
            while i < size, buf[i] != 0 { i += 1 }
            args.append(String(decoding: buf[start..<i], as: UTF8.self))
            i += 1
        }
        return args
    }

    /// A daemon that runs this bundle's code (started by this app or by the CLI inside it) but reports another
    /// version: the bundle was replaced under it by an update. Its code is gone from disk and it lacks the new routes,
    /// so the app replaces it rather than attach. Daemons from a terminal, a repo or another copy are left alone.
    static func isOutdatedBundledDaemon(pid: Int, version: String?) -> Bool {
        guard isBundled, let version, !version.isEmpty,
              let mine = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String, version != mine,
              let resources = Bundle.main.resourceURL?.standardizedFileURL.path,
              let args = processArguments(pid_t(pid)) else { return false }
        return args.contains { $0.hasPrefix(resources + "/") }
    }

    /// SIGTERM the daemon and wait (up to ~6 s) for it to exit.
    static func stop(pid: Int) async -> Bool {
        guard pid > 0, kill(pid_t(pid), SIGTERM) == 0 else { return false }
        for _ in 0..<60 {
            try? await Task.sleep(for: .milliseconds(100))
            if kill(pid_t(pid), 0) != 0 { return true }
        }
        return false
    }

    /// TCP-connects to host:port from a child process of this app (bundled node), i.e. with the same Local Network
    /// permission a daemon launched by the app would have.
    static func localNetworkCheck(host: String, port: Int) async -> (ok: Bool, code: String, message: String) {
        guard let node = findNode() else { return (false, "no_node", "Node.js not found") }
        let script = """
        const net = require('net'); const [host, port] = process.argv.slice(1);
        const s = net.connect({ host, port: Number(port) });
        const done = (r) => { process.stdout.write(JSON.stringify(r)); s.destroy(); process.exit(0); };
        s.setTimeout(4000, () => done({ code: 'ETIMEDOUT' }));
        s.on('connect', () => done({ code: 'CONNECTED' }));
        s.on('error', (e) => done({ code: e.code || 'ERROR', message: e.message }));
        """
        return await withCheckedContinuation { cont in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: node)
            p.arguments = ["-e", script, host, String(port)]
            let out = Pipe()
            p.standardOutput = out
            p.standardError = FileHandle.nullDevice
            p.terminationHandler = { _ in
                let data = out.fileHandleForReading.readDataToEndOfFile()
                let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                let code = obj?["code"] as? String ?? "ERROR"
                switch code {
                case "CONNECTED": cont.resume(returning: (true, code, "Allowed — connected to \(host):\(port)."))
                case "ECONNREFUSED": cont.resume(returning: (true, code, "Allowed — \(host) answered, but nothing listens on port \(port)."))
                case "EHOSTUNREACH": cont.resume(returning: (false, code, "Blocked (EHOSTUNREACH) — macOS Local Network permission is missing for PhoneDock, or the host is down."))
                case "ETIMEDOUT": cont.resume(returning: (false, code, "No answer from \(host):\(port) within 4 s (wrong IP, or a firewall)."))
                default: cont.resume(returning: (false, code, (obj?["message"] as? String) ?? "Failed (\(code))"))
                }
            }
            do { try p.run() } catch { cont.resume(returning: (false, "spawn", error.localizedDescription)) }
        }
    }
}
