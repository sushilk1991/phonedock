#!/usr/bin/env bash
# Builds dist/PhoneDock.app (SwiftUI app + bundled node + daemon/CLI bundles), then a .zip and a .dmg.
# Usage: scripts/build-app.sh             local build, ad-hoc signed (runs on this Mac only)
#        scripts/build-app.sh --release   Developer ID signed, hardened runtime, notarized and stapled DMG, plus the
#                                         signed update archive's appcast entry (scripts/release-appcast.sh)
# Release env: PHONEDOCK_NOTARY_PROFILE  notarytool keychain profile (required; see `xcrun notarytool store-credentials`)
#              PHONEDOCK_SIGN_IDENTITY   signing identity (default: the first "Developer ID Application" in the keychain)
# Test env:    PHONEDOCK_VERSION, PHONEDOCK_BUILD_NUMBER  override the version and CFBundleVersion (local test builds)
#              PHONEDOCK_SPARKLE_PUBLIC_KEY               EdDSA public key to embed instead of app/sparkle-public-ed-key.txt
# Releasing, step by step: docs/RELEASING.md. Never installs anything into /Applications.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${PHONEDOCK_VERSION:-$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo 0.1.0)}"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
DIST="${PHONEDOCK_DIST:-$ROOT/dist}"   # override to build somewhere other than dist/
APP="$DIST/PhoneDock.app"
WORK="$DIST/.work"
RELEASE=0
case "${1:-}" in
  --release) RELEASE=1 ;;
  "") ;;
  *) echo "usage: scripts/build-app.sh [--release]" >&2; exit 2 ;;
esac

# CFBundleVersion is what Sparkle compares to decide whether an appcast item is newer, so it has to grow with every
# release. It comes from the version: MAJOR*1000000 + MINOR*1000 + PATCH (0.2.0 → 2000, 1.4.12 → 1004012), so bumping
# package.json's version is the only step. CFBundleShortVersionString stays the version people see.
if [ -n "${PHONEDOCK_BUILD_NUMBER:-}" ]; then
  BUILD_NUMBER="$PHONEDOCK_BUILD_NUMBER"
elif [[ "$VERSION" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)(-.*)?$ ]]; then
  if [ "${BASH_REMATCH[2]}" -ge 1000 ] || [ "${BASH_REMATCH[3]}" -ge 1000 ]; then
    echo "error: version $VERSION: minor and patch must be below 1000 for the build number" >&2; exit 1
  fi
  if [ -n "${BASH_REMATCH[4]}" ] && [ "$RELEASE" = 1 ]; then
    echo "error: $VERSION is a pre-release and would share its build number with ${VERSION%%-*}; set PHONEDOCK_BUILD_NUMBER" >&2; exit 1
  fi
  BUILD_NUMBER=$(( 10#${BASH_REMATCH[1]} * 1000000 + 10#${BASH_REMATCH[2]} * 1000 + 10#${BASH_REMATCH[3]} ))
else
  echo "error: version '$VERSION' isn't MAJOR.MINOR.PATCH; set PHONEDOCK_BUILD_NUMBER" >&2; exit 1
fi
[[ "$BUILD_NUMBER" =~ ^[0-9]+$ ]] || { echo "error: PHONEDOCK_BUILD_NUMBER must be a whole number" >&2; exit 1; }

# Auto-update (Sparkle, app/Sources/PhoneDock/UpdateController.swift): the app reads this appcast, which GitHub Pages
# serves from site/appcast.xml, and installs only archives signed with the private half of this EdDSA key.
FEED_URL="https://sushilk1991.github.io/phonedock/appcast.xml"
ED_KEY_FILE="$ROOT/app/sparkle-public-ed-key.txt"
ED_PUBLIC_KEY="${PHONEDOCK_SPARKLE_PUBLIC_KEY:-}"
if [ -z "$ED_PUBLIC_KEY" ] && [ -f "$ED_KEY_FILE" ]; then
  ED_PUBLIC_KEY="$(grep -v '^#' "$ED_KEY_FILE" | tr -d ' \n\r\t')"
fi
if [ -n "$ED_PUBLIC_KEY" ] && ! [[ "$ED_PUBLIC_KEY" =~ ^[A-Za-z0-9+/]{43}=$ ]]; then
  echo "error: the Sparkle public key '$ED_PUBLIC_KEY' isn't a base64 EdDSA public key (44 characters)" >&2; exit 1
fi
if [ -z "$ED_PUBLIC_KEY" ] && [ "$RELEASE" = 1 ]; then
  echo "error: no Sparkle public key (SUPublicEDKey), so this release could never update itself." >&2
  echo "       One-time setup (docs/RELEASING.md): create the key in your login keychain, then save its public half:" >&2
  echo "         app/.build/artifacts/sparkle/Sparkle/bin/generate_keys --account phonedock" >&2
  echo "         app/.build/artifacts/sparkle/Sparkle/bin/generate_keys --account phonedock -p > app/sparkle-public-ed-key.txt" >&2
  exit 1
fi

# Check release credentials before spending minutes on a build.
if [ "$RELEASE" = 1 ]; then
  IDENTITY="${PHONEDOCK_SIGN_IDENTITY:-$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' | head -n 1)}"
  if [ -z "$IDENTITY" ]; then
    echo "error: no Developer ID Application identity found; set PHONEDOCK_SIGN_IDENTITY" >&2; exit 1
  fi
  if [ -z "${PHONEDOCK_NOTARY_PROFILE:-}" ]; then
    echo "error: set PHONEDOCK_NOTARY_PROFILE to a notarytool keychain profile" >&2
    echo "       (create one with: xcrun notarytool store-credentials <name> --apple-id <id> --team-id <team>)" >&2
    exit 1
  fi
  if ! xcrun notarytool history --keychain-profile "$PHONEDOCK_NOTARY_PROFILE" >/dev/null 2>&1; then
    echo "error: notarytool profile '$PHONEDOCK_NOTARY_PROFILE' doesn't work; recreate it with store-credentials" >&2; exit 1
  fi
  echo "==> Release build $VERSION ($BUILD_NUMBER), signing as: $IDENTITY"
fi
mkdir -p "$DIST" "$WORK"

echo "==> Building Swift app (release)"
swift build -c release --package-path "$ROOT/app"
BIN_DIR="$(swift build -c release --package-path "$ROOT/app" --show-bin-path)"
BIN="$BIN_DIR/PhoneDock"
SPARKLE_FW="$BIN_DIR/Sparkle.framework"
[ -d "$SPARKLE_FW" ] || { echo "error: Sparkle.framework is missing from $BIN_DIR" >&2; exit 1; }

echo "==> Bundling daemon + CLI"
node "$ROOT/scripts/bundle.mjs"

echo "==> Rendering icon"
ICONSET="$WORK/PhoneDock.iconset"
rm -rf "$ICONSET" && mkdir -p "$ICONSET"
swiftc -O -o "$WORK/make-icon" "$ROOT/app/Sources/PhoneDock/AppIcon.swift" "$ROOT/app/Icon/main.swift"
"$WORK/make-icon" "$WORK/icon-1024.png" 1024
# Render every size directly: AppIcon draws a simplified mark at 32 px and below, which scaling would lose.
for s in 16 32 128 256 512; do
  "$WORK/make-icon" "$ICONSET/icon_${s}x${s}.png" $s
  "$WORK/make-icon" "$ICONSET/icon_${s}x${s}@2x.png" $((s * 2))
done
iconutil -c icns "$ICONSET" -o "$WORK/AppIcon.icns"

# Sparkle's settings: check daily (and soon after each launch, UpdateController.swift) without asking first; never
# download or install without a click; check the archive's EdDSA signature before unpacking it.
SPARKLE_PLIST=""
if [ -n "$ED_PUBLIC_KEY" ]; then
  SPARKLE_PLIST="  <key>SUFeedURL</key><string>${FEED_URL}</string>
  <key>SUPublicEDKey</key><string>${ED_PUBLIC_KEY}</string>
  <key>SUEnableAutomaticChecks</key><true/>
  <key>SUScheduledCheckInterval</key><integer>86400</integer>
  <key>SUAutomaticallyUpdate</key><false/>
  <key>SUAllowsAutomaticUpdates</key><false/>
  <key>SUVerifyUpdateBeforeExtraction</key><true/>
"
else
  echo "    note: no Sparkle public key (app/sparkle-public-ed-key.txt), so this build won't check for updates"
fi

echo "==> Assembling $APP ($VERSION, build $BUILD_NUMBER)"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Frameworks" "$APP/Contents/Resources/daemon" "$APP/Contents/Resources/cli" "$APP/Contents/Resources/bin"
cp "$BIN" "$APP/Contents/MacOS/PhoneDock"
# Sparkle: the binary links @rpath/Sparkle.framework (rpath @executable_path/../Frameworks); ditto keeps its symlinks.
# Its XPC services are only for sandboxed apps (SUEnableInstallerLauncherService, SUEnableDownloaderService) and
# PhoneDock isn't sandboxed, so they stay out, with the headers: less code to sign and ship.
SPK="$APP/Contents/Frameworks/Sparkle.framework"
ditto "$SPARKLE_FW" "$SPK"
rm -rf "$SPK/Versions/B/XPCServices" "$SPK/XPCServices" "$SPK/Versions/B/Headers" "$SPK/Headers" \
       "$SPK/Versions/B/PrivateHeaders" "$SPK/PrivateHeaders" "$SPK/Versions/B/Modules" "$SPK/Modules"
cp "$WORK/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
# Indigo accent for default buttons, selection and focus (applies when the user's system accent is Multicolor).
xcrun actool "$ROOT/app/Assets.xcassets" --compile "$APP/Contents/Resources" --platform macosx \
  --minimum-deployment-target 15.0 --accent-color AccentColor --output-partial-info-plist "$WORK/assets-info.plist" >/dev/null

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>PhoneDock</string>
  <key>CFBundleDisplayName</key><string>PhoneDock</string>
  <key>CFBundleIdentifier</key><string>dev.phonedock.app</string>
  <key>CFBundleExecutable</key><string>PhoneDock</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${BUILD_NUMBER}</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>NSAccentColorName</key><string>AccentColor</string>
  <key>LSMinimumSystemVersion</key><string>15.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSHumanReadableCopyright</key><string>Copyright © 2026 Sushil Kumar · Apache-2.0</string>
  <key>NSLocalNetworkUsageDescription</key><string>PhoneDock connects to iPhones and Android phones on your Wi-Fi network so agents can control them.</string>
  <key>NSBonjourServices</key>
  <array>
    <string>_remotepairing._tcp</string>
    <string>_apple-mobdev2._tcp</string>
    <string>_remotepairing-manual-pairing._tcp</string>
    <string>_adb-tls-connect._tcp</string>
    <string>_adb-tls-pairing._tcp</string>
    <string>_adb._tcp</string>
  </array>
${SPARKLE_PLIST}</dict>
</plist>
PLIST

NODE_BIN="${NODE:-$(command -v node)}"
NODE_REAL="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$NODE_BIN")"
echo "    node: $NODE_REAL"
cp "$NODE_REAL" "$APP/Contents/Resources/node"
chmod 755 "$APP/Contents/Resources/node"

if [ -f "$ROOT/dist/bundle/daemon/phonedockd.mjs" ]; then
  cp "$ROOT/dist/bundle/daemon/phonedockd.mjs" "$APP/Contents/Resources/daemon/phonedockd.mjs"
else
  echo "    warning: daemon bundle missing (src/daemon/main.ts not written yet?)"
fi
if [ -f "$ROOT/dist/bundle/cli/phonedock.mjs" ]; then
  cp "$ROOT/dist/bundle/cli/phonedock.mjs" "$APP/Contents/Resources/cli/phonedock.mjs"
else
  echo "    warning: CLI bundle missing"
fi
# Docs the app links to (Connect sheet › iPhone over Wi-Fi).
mkdir -p "$APP/Contents/Resources/docs"
cp "$ROOT/docs/IPHONE-WIFI.md" "$APP/Contents/Resources/docs/IPHONE-WIFI.md"
# The agent skill that `phonedock setup` installs for Claude Code, Codex, Cursor and Pi.
rm -rf "$APP/Contents/Resources/skills" && mkdir -p "$APP/Contents/Resources/skills"
cp -R "$ROOT/skills/phonedock" "$APP/Contents/Resources/skills/phonedock"
find "$APP/Contents/Resources/skills" -name .DS_Store -delete
# Native helpers used by backends (e.g. OCR), if present. Python caches stay out of the bundle.
if [ -d "$ROOT/tools" ]; then
  cp -R "$ROOT/tools" "$APP/Contents/Resources/tools"
  find "$APP/Contents/Resources/tools" \( -name __pycache__ -o -name '*.pyc' -o -name .DS_Store \) -prune -exec rm -rf {} +
fi

cat > "$APP/Contents/Resources/bin/phonedock" <<'WRAP'
#!/bin/sh
# PhoneDock CLI (bundled): runs the CLI bundle with the Node runtime shipped inside PhoneDock.app.
SELF="$0"
while [ -L "$SELF" ]; do
  LINK="$(readlink "$SELF")"
  case "$LINK" in /*) SELF="$LINK" ;; *) SELF="$(dirname "$SELF")/$LINK" ;; esac
done
RES="$(cd "$(dirname "$SELF")/.." && pwd)"
export PHONEDOCK_BUNDLE_RESOURCES="$RES"
exec "$RES/node" "$RES/cli/phonedock.mjs" "$@"
WRAP
chmod 755 "$APP/Contents/Resources/bin/phonedock"

if [ "$RELEASE" = 1 ]; then
  echo "==> Codesigning (Developer ID, hardened runtime)"
  # Node's V8 needs JIT pages under the hardened runtime; nothing else in the bundle needs an entitlement.
  NODE_ENT="$WORK/node.entitlements"
  cat > "$NODE_ENT" <<'ENT'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict>
</plist>
ENT
  # Sign inside-out: nested code first, then the app. Sparkle's helpers (the installer, and the small app that shows
  # progress and relaunches PhoneDock) get our Developer ID too: library validation under the hardened runtime and
  # macOS's App Management check (who may replace this app) both want one team throughout.
  codesign --force --timestamp --options runtime -s "$IDENTITY" "$SPK/Versions/B/Autoupdate"
  codesign --force --timestamp --options runtime -s "$IDENTITY" "$SPK/Versions/B/Updater.app"
  codesign --force --timestamp --options runtime -s "$IDENTITY" "$SPK"
  codesign --force --timestamp --options runtime --entitlements "$NODE_ENT" -s "$IDENTITY" "$APP/Contents/Resources/node"
  codesign --force --timestamp --options runtime -s "$IDENTITY" "$APP"
  codesign --verify --deep --strict "$APP" && echo "    signature ok"
  TEAM="$(codesign -dv "$APP" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
  for f in "$SPK/Versions/B/Autoupdate" "$SPK/Versions/B/Updater.app" "$SPK" "$APP/Contents/Resources/node"; do
    t="$(codesign -dv "$f" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
    [ "$t" = "$TEAM" ] || { echo "error: $f is signed by team '$t', the app by '$TEAM'" >&2; exit 1; }
  done
else
  echo "==> Codesigning (ad-hoc; use --release for a build other Macs can open)"
  codesign --force --deep -s - "$APP"
  codesign --verify --deep "$APP" && echo "    signature ok"
fi

echo "==> Packaging"
ZIP="$DIST/PhoneDock-$VERSION.zip"
DMG="$DIST/PhoneDock-$VERSION.dmg"
rm -f "$ZIP" "$DMG"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
DMGSRC="$WORK/dmg"
rm -rf "$DMGSRC" && mkdir -p "$DMGSRC"
cp -R "$APP" "$DMGSRC/"
ln -s /Applications "$DMGSRC/Applications"
hdiutil create -volname PhoneDock -srcfolder "$DMGSRC" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$DMGSRC"

if [ "$RELEASE" = 1 ]; then
  echo "==> Notarizing (this usually takes a few minutes)"
  codesign --force --timestamp -s "$IDENTITY" "$DMG"
  RESULT="$WORK/notary-result.plist"
  SUBMIT_RC=0
  xcrun notarytool submit "$DMG" --keychain-profile "$PHONEDOCK_NOTARY_PROFILE" --wait --output-format plist > "$RESULT" || SUBMIT_RC=$?
  STATUS="$(plutil -extract status raw -o - "$RESULT" 2>/dev/null || echo Unknown)"
  SUBMISSION="$(plutil -extract id raw -o - "$RESULT" 2>/dev/null || true)"
  if [ "$SUBMIT_RC" != 0 ] || [ "$STATUS" != "Accepted" ]; then
    [ -n "$SUBMISSION" ] && xcrun notarytool log "$SUBMISSION" --keychain-profile "$PHONEDOCK_NOTARY_PROFILE" "$WORK/notary-log.json" || true
    echo "error: notarization status '$STATUS'; log: $WORK/notary-log.json" >&2
    exit 1
  fi
  # Staple the app too, so the .zip opens offline, then rebuild the zip from the stapled app.
  xcrun stapler staple "$APP" >/dev/null
  xcrun stapler staple "$DMG" >/dev/null
  # The zip is also the update archive Sparkle downloads; release-appcast.sh signs it below.
  rm -f "$ZIP" && ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
  spctl --assess --type execute "$APP" && echo "    Gatekeeper accepts the app"
  spctl --assess --type open --context context:primary-signature "$DMG" && echo "    Gatekeeper accepts the DMG"
  shasum -a 256 "$DMG" "$ZIP" | sed "s|$DIST/||" > "$DIST/SHA256SUMS.txt"
  echo "==> Update archive: EdDSA signature and appcast entry"
  "$ROOT/scripts/release-appcast.sh" "$ZIP"
fi

echo
echo "Built:"
du -sh "$APP" "$ZIP" "$DMG"
[ "$RELEASE" = 1 ] && cat "$DIST/SHA256SUMS.txt"
exit 0
