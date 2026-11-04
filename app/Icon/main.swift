// Renders the PhoneDock app icon PNG. Compiled together with ../Sources/PhoneDock/AppIcon.swift by scripts/build-app.sh.
import Foundation
let args = CommandLine.arguments
guard args.count >= 2 else { print("usage: make-icon <out.png> [size]"); exit(2) }
let size = args.count >= 3 ? Int(args[2]) ?? 1024 : 1024
exit(AppIcon.writePNG(size: size, to: URL(fileURLWithPath: args[1])) ? 0 : 1)
