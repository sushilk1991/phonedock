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
    var system: Bool?
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
