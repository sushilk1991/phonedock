// Checks an EdDSA (Ed25519) signature the way Sparkle checks an update: release-appcast.sh uses it to prove that the
// archive's signature matches the SUPublicEDKey inside the app being released, which is what installed copies check.
// Usage: ed25519-verify <public-key-base64> <signature-base64> <file>   exit 0 = valid, 1 = invalid, 2 = bad input
import CryptoKit
import Foundation

let args = CommandLine.arguments
guard args.count == 4,
      let publicKey = Data(base64Encoded: args[1]), let signature = Data(base64Encoded: args[2]),
      let key = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKey),
      let data = try? Data(contentsOf: URL(fileURLWithPath: args[3]), options: .mappedIfSafe) else {
    FileHandle.standardError.write(Data("usage: ed25519-verify <public-key-base64> <signature-base64> <file>\n".utf8))
    exit(2)
}
exit(key.isValidSignature(signature, for: data) ? 0 : 1)
