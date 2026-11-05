// swift-tools-version: 6.0
import PackageDescription

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
            // The app bundle keeps Sparkle.framework in Contents/Frameworks; a development build (`swift run`) finds it
            // next to the binary.
            linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks",
                                           "-Xlinker", "-rpath", "-Xlinker", "@loader_path"])]
        )
    ]
)
