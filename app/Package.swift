// swift-tools-version: 6.0
import Foundation
import PackageDescription

// Swift 6.4's `swiftbuild` backend scrubs `SDKROOT` when linking and `swift-driver` forwards `--sysroot` (not
// `-isysroot`) to `clang`, so `clang` misses `SDKSettings.json` and stamps `LC_BUILD_VERSION sdk 15.0` instead of the
// installed SDK. On macOS 26+, an `sdk 15.0` binary falls back to pre-macOS 26 compatibility chrome where AppKit shifts
// the detail titlebar background 3 pt left of the split dividers and disables Liquid Glass. Forwarding `-isysroot` lets
// `clang` read `SDKSettings.json` and stamp the active SDK while keeping the macOS 15.0 deployment target.
let activeMacOSSDK: String? = {
    let env = ProcessInfo.processInfo.environment
    var candidates: [String] = []
    if let sdk = env["SDKROOT"], !sdk.isEmpty { candidates.append(sdk) }
    if let dev = env["DEVELOPER_DIR"], !dev.isEmpty {
        candidates.append("\(dev)/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk")
    }
    candidates += [
        "/var/db/xcode_select_link/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk",
        "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk",
        "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk",
    ]
    return candidates.first { FileManager.default.fileExists(atPath: "\($0)/SDKSettings.json") }
}()

// The app bundle keeps Sparkle.framework in Contents/Frameworks; a development build (`swift run`) finds it
// next to the binary.
var appLinkerFlags = [
    "-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks",
    "-Xlinker", "-rpath", "-Xlinker", "@loader_path",
]
if let activeMacOSSDK {
    appLinkerFlags += ["-Xclang-linker", "-isysroot", "-Xclang-linker", activeMacOSSDK]
}

let package = Package(
    name: "PhoneDock",
    platforms: [.macOS(.v15)],
    products: [.executable(name: "PhoneDock", targets: ["PhoneDock"])],
    dependencies: [
        // Auto-update (UpdateController.swift). Pinned exactly: UpdateVerifier.swift reads where Sparkle's installer
        // unpacks an update, so a new Sparkle version gets a deliberate bump and a re-run of the update test
        // (docs/RELEASING.md). scripts/build-app.sh embeds Sparkle.framework in Contents/Frameworks.
        .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.10.1"),
    ],
    targets: [
        .executableTarget(
            name: "PhoneDock",
            dependencies: [.product(name: "Sparkle", package: "Sparkle")],
            path: "Sources/PhoneDock",
            swiftSettings: [.swiftLanguageMode(.v5), .enableUpcomingFeature("BareSlashRegexLiterals")],
            linkerSettings: [.unsafeFlags(appLinkerFlags)]
        )
    ]
)
