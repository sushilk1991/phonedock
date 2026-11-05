// UpdateVerifier.swift — the code-signing check PhoneDock runs on an update before it lets Sparkle install it.
// Foundation + Security only (no Sparkle, no SwiftUI), so it also compiles on its own for tests.

import Foundation
import Security

/// Sparkle checks an update's EdDSA signature (SUPublicEDKey) before it unpacks the archive (SUVerifyUpdateBeforeExtraction).
/// It deliberately accepts a new Developer ID team as long as that signature is good, so teams can be rotated. PhoneDock
/// doesn't rotate teams: on top of the EdDSA check, the app about to be installed must
///   - have a valid signature, nested code included (Sparkle.framework, its helpers),
///   - have the running app's code-signing identifier,
///   - be signed with a Developer ID Application certificate of the running app's team, with the hardened runtime,
///   - be the build the appcast promised.
/// A local build without a team (ad-hoc signed) accepts only another valid signature with the same identifier.
enum UpdateVerifier {
    struct Identity: Equatable {
        /// Code-signing identifier ("dev.phonedock.app").
        var identifier: String
        /// Developer ID team; nil for an ad-hoc signed (local) build.
        var teamID: String?
    }

    struct Failure: Error, CustomStringConvertible {
        var description: String
    }

    /// The signing identity of the running app; nil if it isn't signed at all.
    static func runningIdentity() -> Identity? {
        var selfCode: SecCode?
        guard SecCodeCopySelf([], &selfCode) == errSecSuccess, let selfCode else { return nil }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(selfCode, [], &staticCode) == errSecSuccess, let staticCode else { return nil }
        return identity(of: staticCode)
    }

    /// The signing identity of a bundle on disk (no validity check).
    static func identity(at url: URL) -> Identity? {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code else { return nil }
        return identity(of: code)
    }

    private static func identity(of code: SecStaticCode) -> Identity? {
        guard let info = signingInfo(code), let identifier = info[kSecCodeInfoIdentifier as String] as? String else { return nil }
        let team = (info[kSecCodeInfoTeamIdentifier as String] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return Identity(identifier: identifier, teamID: team)
    }

    private static func signingInfo(_ code: SecStaticCode) -> [String: Any]? {
        var info: CFDictionary?
        guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess else { return nil }
        return info as? [String: Any]
    }

    /// The requirement an update has to meet for an app signed as `expected`.
    static func requirement(for expected: Identity) -> String {
        let id = "identifier \"\(expected.identifier)\""
        guard let team = expected.teamID else { return id }
        // Apple's Developer ID requirement (as in `codesign -d -r-` of a Developer ID app), pinned to our team.
        return "anchor apple generic and \(id)"
            + " and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */"
            + " and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */"
            + " and certificate leaf[subject.OU] = \"\(team)\""
    }

    /// Checks the app at `bundle` against the running app's identity (see the type's comment).
    static func verify(bundle: URL, expected: Identity, expectedBuild: String?) -> Result<Void, Failure> {
        var codeRef: SecStaticCode?
        guard SecStaticCodeCreateWithPath(bundle as CFURL, [], &codeRef) == errSecSuccess, let code = codeRef else {
            return .failure(Failure(description: "No code signature at \(bundle.path)"))
        }
        var reqRef: SecRequirement?
        let reqText = requirement(for: expected)
        guard SecRequirementCreateWithString(reqText as CFString, [], &reqRef) == errSecSuccess, let req = reqRef else {
            return .failure(Failure(description: "Couldn’t build the requirement: \(reqText)"))
        }
        let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSStrictValidate | kSecCSCheckNestedCode)
        var cfError: Unmanaged<CFError>?
        let status = SecStaticCodeCheckValidityWithErrors(code, flags, req, &cfError)
        guard status == errSecSuccess else {
            let why = cfError.map { String(describing: $0.takeRetainedValue()) } ?? "OSStatus \(status)"
            let got = identity(of: code)
            return .failure(Failure(description: "The update’s signature doesn’t meet \(reqText): \(why)"
                + " (update is signed as \(got?.identifier ?? "?"), team \(got?.teamID ?? "none"))"))
        }
        let info = signingInfo(code) ?? [:]
        if let team = expected.teamID {
            // The requirement already pins the team; read it back so a log says what was checked.
            guard info[kSecCodeInfoTeamIdentifier as String] as? String == team else {
                return .failure(Failure(description: "The update isn’t signed by team \(team)"))
            }
            let codeFlags = (info[kSecCodeInfoFlags as String] as? NSNumber)?.uint32Value ?? 0
            guard codeFlags & SecCodeSignatureFlags.runtime.rawValue != 0 else {
                return .failure(Failure(description: "The update isn’t signed with the hardened runtime"))
            }
        }
        if let expectedBuild {
            let plist = (try? Data(contentsOf: bundle.appendingPathComponent("Contents/Info.plist")))
                .flatMap { try? PropertyListSerialization.propertyList(from: $0, format: nil) as? [String: Any] }
            let build = plist?["CFBundleVersion"] as? String
            guard build == expectedBuild else {
                return .failure(Failure(description: "The update is build \(build ?? "?"), the appcast promised \(expectedBuild)"))
            }
        }
        return .success(())
    }

    // MARK: Where Sparkle unpacked the update

    /// Sparkle's installer unpacks an update into
    /// `~/Library/Caches/<bundle id>[.sparkle]/org.sparkle-project.Sparkle/Installation/<id>/<id>/<Name>.app`
    /// (SPULocalCacheDirectory.m and AppInstaller.m in Sparkle 2.10.1; ".sparkle" is added to a bundle id that ends in
    /// ".app", as PhoneDock's does). Returns the newest unpacked app with this bundle id and build, or nil, in which case
    /// the update isn't installed (fail closed). Package.swift pins Sparkle, so this layout changes only on purpose.
    static func stagedUpdate(bundleIdentifier: String, build: String, cachesDirectory: URL? = nil) -> URL? {
        let fm = FileManager.default
        guard let caches = cachesDirectory ?? fm.urls(for: .cachesDirectory, in: .userDomainMask).first else { return nil }
        var roots = [bundleIdentifier, bundleIdentifier + ".sparkle"].map {
            caches.appendingPathComponent($0).appendingPathComponent("org.sparkle-project.Sparkle/Installation")
        }
        roots = roots.filter { fm.fileExists(atPath: $0.path) }
        var found: [(URL, Date)] = []
        for root in roots {
            for a in (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? [] {
                for b in (try? fm.contentsOfDirectory(at: a, includingPropertiesForKeys: nil)) ?? [] {
                    for app in (try? fm.contentsOfDirectory(at: b, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
                    where app.pathExtension == "app" {
                        let plist = (try? Data(contentsOf: app.appendingPathComponent("Contents/Info.plist")))
                            .flatMap { try? PropertyListSerialization.propertyList(from: $0, format: nil) as? [String: Any] }
                        guard plist?["CFBundleIdentifier"] as? String == bundleIdentifier,
                              plist?["CFBundleVersion"] as? String == build else { continue }
                        let date = (try? b.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                        found.append((app, date))
                    }
                }
            }
        }
        return found.max { $0.1 < $1.1 }?.0
    }
}
