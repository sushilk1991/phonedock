// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PhoneDock",
    platforms: [.macOS(.v15)],
    products: [.executable(name: "PhoneDock", targets: ["PhoneDock"])],
    targets: [
        .executableTarget(
            name: "PhoneDock",
            path: "Sources/PhoneDock",
            swiftSettings: [.swiftLanguageMode(.v5), .enableUpcomingFeature("BareSlashRegexLiterals")]
        )
    ]
)
