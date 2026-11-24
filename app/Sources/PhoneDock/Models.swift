import Foundation

/// Loosely-typed JSON for backend-specific payloads (info, meta, action log entries).
enum JSONValue: Codable, Hashable, Sendable, CustomStringConvertible {
    case string(String), number(Double), bool(Bool), object([String: JSONValue]), array([JSONValue]), null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else if let o = try? c.decode([String: JSONValue].self) { self = .object(o) }
        else { self = .null }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .object(let o): try c.encode(o)
        case .array(let a): try c.encode(a)
        case .null: try c.encodeNil()
        }
    }

    var description: String {
        switch self {
        case .string(let s): return s
        case .number(let n): return n.rounded() == n && abs(n) < 1e15 ? String(Int(n)) : String(n)
        case .bool(let b): return b ? "true" : "false"
        case .null: return "null"
        case .array(let a): return "[" + a.map(\.description).joined(separator: ", ") + "]"
        case .object(let o):
            return o.keys.sorted().map { "\($0): \(o[$0]!.description)" }.joined(separator: ", ")
        }
    }

    subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    var stringValue: String? { if case .string(let s) = self { return s }; return nil }
}

struct ScreenInfo: Codable, Hashable, Sendable {
    var width: Double
    var height: Double
    var scale: Double?
    var density: Double?
    var orientation: String?
}

struct Lease: Codable, Hashable, Sendable {
    var owner: String
    var acquiredAt: String?
    var expiresAt: String?
}

struct DeviceSpec: Codable, Hashable, Sendable {
    var backend: String?
    var name: String?
    var image: String?
    var profile: String?
    var cpus: Int?
    var ramMB: Int?
    var storageMB: Int?
    var width: Int?
    var height: Int?
    var dpi: Int?
    var headless: Bool?
    var autoStart: Bool?
}

struct Device: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var backend: String
    var nativeId: String?
    var name: String
    var platform: String
    var kind: String
    var state: String
    var managed: Bool?
    var osVersion: String?
    var model: String?
    var connection: String?
    var screen: ScreenInfo?
    /// "portrait" or "landscape": how the screen is turned right now (the daemon follows rotation).
    var orientation: String?
    var spec: DeviceSpec?
    var capabilities: [String]?
    var lease: Lease?
    var error: String?
    var meta: JSONValue?
    var handoff: Handoff?

    var caps: [String] { capabilities ?? [] }
    func can(_ c: String) -> Bool { caps.contains(c) }
    var isRunning: Bool { state == "running" }
    var leasedByAgent: Bool { if let l = lease { return l.owner != AppIdentity.owner }; return false }
    var leasedByHuman: Bool { lease?.owner == AppIdentity.owner }
    /// A virtual phone: an Android emulator made with `options.disguise`, which presents as a real handset
    /// (docs/VIRTUAL-PHONES.md). Its `meta.disguise` names the phone it presents as.
    var isVirtualPhone: Bool { if case .object = meta?["disguise"] { return true }; return false }

    var platformName: String {
        switch platform { case "ios": return "iOS"; case "android": return "Android"; case "linux": return "Linux"; default: return platform.capitalized }
    }

    var platformSymbol: String {
        switch platform {
        case "android": return "smartphone"
        case "ios": return "iphone"
        case "linux": return "terminal"
        default: return "desktopcomputer"
        }
    }
}

/// An agent asking the human to do something it can't (Face ID, passcode, Apple ID sign-in, CAPTCHA…).
struct Handoff: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var deviceId: String
    var reason: String
    var requestedBy: String?
    var createdAt: String?
    var expiresAt: String?
    var state: String           // pending | done | cancelled | timeout
    var note: String?
    var resolvedAt: String?
    var resolvedBy: String?

    var isPending: Bool { state == "pending" }
    var expiresDate: Date? { expiresAt.flatMap(ISO8601DateFormatter.flexible) }
    var createdDate: Date? { createdAt.flatMap(ISO8601DateFormatter.flexible) }
    var requester: String { requestedBy.flatMap { $0.isEmpty ? nil : $0 } ?? "an agent" }
}

struct RecordingStatus: Decodable, Sendable {
    var active: Bool
    var path: String?
    var startedAt: String?
}

struct RecordingResult: Decodable, Sendable {
    var path: String
    var sizeBytes: Double?
}

struct CrashReport: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var appId: String?
    var process: String?
    var time: String?
    var kind: String?
    var summary: String?

    var title: String { process ?? appId ?? summary ?? id }
}

/// One entry of `GET /v1/ios/discover` (Bonjour / devicectl scan).
struct DiscoveredPhone: Codable, Hashable, Identifiable, Sendable {
    var name: String
    var host: String?
    var udid: String?
    var source: String?
    var service: String?
    var deviceId: String?
    var id: String { [name, host ?? "", udid ?? "", service ?? ""].joined(separator: "|") }
}

struct ConnectResult: Decodable, Sendable {
    var ok: Bool?
    var device: Device?
    var wdaUrl: String?
    var message: String?
}

struct Availability: Codable, Hashable, Sendable {
    var ok: Bool
    var reason: String?
    var hints: [String]?
    var version: String?
}

struct BackendInfo: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var displayName: String
    var platform: String
    var kind: String
    var capabilities: [String]?
    var availability: Availability?
    /// Maturity from `/v1/backends`: "stable", "beta" or "experimental" (absent means stable).
    var stage: String?

    var isAvailable: Bool { availability?.ok ?? false }

    /// The badge to show next to the name: "Beta", "Experimental", or nil when stable.
    var stageLabel: String? {
        switch stage {
        case "beta": return "Beta"
        case "experimental": return "Experimental"
        default: return nil
        }
    }

    /// The name without a "(beta)" or "(experimental)" suffix the CLI shows; the app shows a badge instead.
    var plainName: String {
        guard let stage, stage != "stable", displayName.hasSuffix(" (\(stage))") else { return displayName }
        return String(displayName.dropLast(stage.count + 3))
    }
}

struct OsImage: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var backend: String?
    var platform: String?
    var name: String
    var version: String?
    var installed: Bool
    /// false: installed but the service found it can't create devices (absent: assume it works).
    var usable: Bool?
    /// HardwareProfile ids this image can run (absent: any).
    var profiles: [String]?
    var sizeMB: Double?
    var notes: String?

    var isUsable: Bool { usable != false }
}

/// `GET /v1/disguise`: what a virtual phone can present as, and which carriers its SIM can claim.
struct DisguiseCatalog: Codable, Hashable, Sendable {
    struct Profile: Codable, Hashable, Identifiable, Sendable {
        var id: String
        var name: String            // "Google Pixel 8"
        var manufacturer: String
        var model: String           // "Pixel 8"
        var androidRelease: String  // "14"
        var sdk: Int
        /// The Google Play system image it runs on.
        var image: String
    }
    struct Carrier: Codable, Hashable, Identifiable, Sendable {
        var id: String
        var name: String
        var country: String         // "US"
    }
    var backend: String
    var defaultProfile: String
    var defaultCarrier: String
    var profiles: [Profile]
    var carriers: [Carrier]
}

struct HardwareProfile: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var name: String
    var width: Int?
    var height: Int?
    var dpi: Int?
    var ramMB: Int?
}

struct AppInfo: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var name: String?
    var version: String?
    var build: String?
    var system: Bool?
}

/// Git dirty flag in a flow run record: true, false, or "unknown".
enum RunDirtyState: Hashable, Sendable, Codable {
    case clean
    case dirty
    case unknown

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let b = try? c.decode(Bool.self) {
            self = b ? .dirty : .clean
        } else {
            self = .unknown
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .clean: try c.encode(false)
        case .dirty: try c.encode(true)
        case .unknown: try c.encode("unknown")
        }
    }

    var label: String {
        switch self {
        case .clean: return "clean"
        case .dirty: return "dirty"
        case .unknown: return "unknown"
        }
    }
}

struct RunSummary: Codable, Hashable, Identifiable, Sendable {
    var schemaVersion: Int
    var id: String
    var status: String
    var startedAt: String
    var durationMs: Double
    var attempts: Int
    var owner: String
    var message: String?
    var flowName: String
    var flowFile: String
    var deviceId: String
    var deviceName: String
    var platform: String
    var osVersion: String
    var appId: String
    var appVersion: String
    var appBuild: String
    var commit: String
    var dirty: RunDirtyState
    var stepCount: Int
    var passedSteps: Int
    var failedSteps: Int
    var report: String?
}

struct RunFlowProvenance: Codable, Hashable, Sendable {
    var name: String
    var file: String?
    var fileDisplay: String
    var sha256: String
    var platform: String?
}

struct RunSourceProvenance: Codable, Hashable, Sendable {
    var commit: String
    var branch: String
    var dirty: RunDirtyState
}

struct RunDeviceProvenance: Codable, Hashable, Sendable {
    var id: String
    var name: String
    var platform: String
    var backend: String
    var kind: String
    var osVersion: String
    var model: String
}

struct RunAppProvenance: Codable, Hashable, Sendable {
    var id: String
    var name: String
    var version: String
    var build: String
}

struct RunStepRecord: Codable, Hashable, Identifiable, Sendable {
    var index: Int
    var description: String
    var status: String
    var ms: Double
    var message: String?
    var screenshot: String?
    var beforeScreenshot: String?
    var id: Int { index }
}

struct RunArtifacts: Codable, Hashable, Sendable {
    var dir: String?
    var report: String?
    var files: [String]?
}

struct RunRecord: Codable, Hashable, Identifiable, Sendable {
    var schemaVersion: Int
    var id: String
    var status: String
    var startedAt: String
    var endedAt: String
    var durationMs: Double
    var attempts: Int
    var owner: String
    var message: String?
    var flow: RunFlowProvenance
    var source: RunSourceProvenance
    var device: RunDeviceProvenance
    var app: RunAppProvenance
    var steps: [RunStepRecord]
    var artifacts: RunArtifacts?
}

struct Snapshot: Codable, Hashable, Identifiable, Sendable {
    var name: String
    var createdAt: String?
    var sizeMB: Double?
    var id: String { name }
}

struct ActionEntry: Codable, Hashable, Sendable {
    var at: String?
    var owner: String?
    var action: JSONValue?

    var summary: String {
        guard let a = action else { return "?" }
        if case .object(var o) = a {
            let name = o.removeValue(forKey: "action")?.description ?? o.removeValue(forKey: "type")?.description ?? "action"
            let rest = o.keys.sorted().map { "\($0)=\(o[$0]!.description)" }.joined(separator: " ")
            return rest.isEmpty ? name : "\(name)  \(rest)"
        }
        return a.description
    }
}

struct Job: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var kind: String?
    var state: String
    var progress: [String]?
    var result: JSONValue?
    var errorText: String?
    /// A failed job's structured error ({ code, message, hints, detail }), when the service sends one.
    var apiError: APIError?
    var startedAt: String?
    var endedAt: String?

    enum CodingKeys: String, CodingKey { case id, kind, state, progress, result, error, startedAt, endedAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decodeIfPresent(String.self, forKey: .kind)
        state = (try? c.decode(String.self, forKey: .state)) ?? "running"
        progress = try? c.decodeIfPresent([String].self, forKey: .progress)
        result = try? c.decodeIfPresent(JSONValue.self, forKey: .result)
        startedAt = try? c.decodeIfPresent(String.self, forKey: .startedAt)
        endedAt = try? c.decodeIfPresent(String.self, forKey: .endedAt)
        if let e = try? c.decodeIfPresent(String.self, forKey: .error) { errorText = e }
        else if let e = try? c.decodeIfPresent(APIErrorBody.Inner.self, forKey: .error), let message = e.message {
            errorText = message
            apiError = APIError(status: 0, code: e.code ?? "job_failed", message: message, hints: e.hints ?? [], detail: e.detail)
        } else if let e = try? c.decodeIfPresent(JSONValue.self, forKey: .error) {
            errorText = e["message"]?.description ?? e.description
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(state, forKey: .state)
    }

    var isDone: Bool { state == "done" }
    var isFailed: Bool { state == "failed" }
    var isFinished: Bool { isDone || isFailed }
    var lastLine: String? { progress?.last }

    /// Best-effort percentage parsed from the most recent progress line ("… 42%").
    var fraction: Double? {
        guard let line = progress?.last(where: { $0.contains("%") }) else { return nil }
        let pattern = /(\d{1,3}(?:\.\d+)?)\s*%/
        guard let m = line.firstMatch(of: pattern), let v = Double(m.1) else { return nil }
        return min(max(v / 100, 0), 1)
    }

    var resultDeviceId: String? { result?["id"]?.stringValue ?? result?["device"]?["id"]?.stringValue }
}

struct JobEnvelope: Decodable, Sendable {
    var job: Job
}

struct ComponentProgress: Codable, Hashable, Sendable {
    var phase: String
    var percent: Int?
    var bytesDone: Int64?
    var bytesTotal: Int64?
    var detail: String?
}

struct ComponentErrorInfo: Codable, Hashable, Sendable {
    var code: String
    var message: String
    var detail: String?
}

struct ComponentStatus: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var displayName: String
    var description: String
    var state: String
    var pinnedVersion: String
    var installedVersion: String?
    var source: String
    var updateAvailable: Bool
    var sizeBytes: Int64?
    var estimatedBytes: Int64
    var downloadBytes: Int64?
    var progress: ComponentProgress?
    var jobId: String?
    var error: ComponentErrorInfo?
    var lastAttemptAt: String?
    var nextRetryAt: String?
}

struct APIErrorBody: Decodable, Sendable {
    struct Inner: Decodable, Sendable { var code: String?; var message: String?; var hints: [String]?; var detail: String? }
    var error: Inner
}

struct HealthInfo: Decodable, Sendable {
    var ok: Bool?
    var version: String?
    var pid: Int?
    var uptimeSec: Double?
}

struct DaemonFile: Decodable, Sendable {
    var port: Int
    var token: String
    var pid: Int?
    var version: String?
}

enum AppIdentity {
    static let owner = "app:human"
}

extension ISO8601DateFormatter {
    // Cached: formatters are expensive to create and this runs for every lease, handoff and activity row.
    nonisolated(unsafe) private static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }()
    nonisolated(unsafe) private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime]; return f
    }()
    private static let lock = NSLock()

    static func flexible(_ s: String) -> Date? {
        lock.lock(); defer { lock.unlock() }
        return fractional.date(from: s) ?? plain.date(from: s)
    }
}
