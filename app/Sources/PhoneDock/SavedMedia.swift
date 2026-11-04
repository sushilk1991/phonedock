import Foundation

/// Where the app saves the screenshots and recordings a person takes: the folder macOS's own Screenshot app uses
/// (Screenshot › Options › Save to, `com.apple.screencapture location`), which is the Desktop unless they changed it.
/// One place for both, next to their other screenshots. Agents' files stay where the agent was told they are.
enum SavedMedia {
    enum Kind { case screenshot, recording }

    static var folder: URL {
        let fm = FileManager.default
        // Self-test runs save to a scratch folder instead of the Desktop.
        let env = ProcessInfo.processInfo.environment
        if !(env["PHONEDOCK_APP_SELFTEST"] ?? "").isEmpty, let d = env["PHONEDOCK_APP_SAVE_DIR"], !d.isEmpty {
            let u = URL(fileURLWithPath: d, isDirectory: true)
            try? fm.createDirectory(at: u, withIntermediateDirectories: true)
            return u
        }
        if let raw = UserDefaults(suiteName: "com.apple.screencapture")?.string(forKey: "location"), !raw.isEmpty {
            var isDir: ObjCBool = false
            let path = (raw as NSString).expandingTildeInPath
            if fm.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue, fm.isWritableFile(atPath: path) {
                return URL(fileURLWithPath: path, isDirectory: true)
            }
        }
        return fm.urls(for: .desktopDirectory, in: .userDomainMask).first
            ?? fm.homeDirectoryForCurrentUser.appendingPathComponent("Desktop", isDirectory: true)
    }

    private static let stamp: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd 'at' HH.mm.ss"
        return f
    }()

    /// "Pixel 9 2026-11-04 at 14.02.11.png" in `folder`; " (2)" and up if that name is taken.
    static func url(for device: String, at date: Date, ext: String) -> URL {
        let safe = device.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
        let base = "\(safe) \(stamp.string(from: date))"
        let dir = folder
        var url = dir.appendingPathComponent("\(base).\(ext)")
        var n = 2
        while FileManager.default.fileExists(atPath: url.path) {
            url = dir.appendingPathComponent("\(base) (\(n)).\(ext)")
            n += 1
        }
        return url
    }

    /// Rename (same volume), else copy and delete. False leaves the file where it was.
    static func move(_ src: URL, to dst: URL) -> Bool {
        let fm = FileManager.default
        do { try fm.moveItem(at: src, to: dst); return true } catch {}
        do { try fm.copyItem(at: src, to: dst); try? fm.removeItem(at: src); return true } catch { return false }
    }

    /// "Desktop", "Screenshots": the folder as Finder names it.
    static func displayName(of dir: URL) -> String {
        FileManager.default.displayName(atPath: dir.path)
    }
}
