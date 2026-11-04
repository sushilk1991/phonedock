#!/usr/bin/env bash
# Builds dist/PhoneDock.app (SwiftUI app + bundled node + daemon/CLI bundles), then a .zip and a .dmg.
# Usage: scripts/build-app.sh             local build, ad-hoc signed (runs on this Mac only)
#        scripts/build-app.sh --release   Developer ID signed, hardened runtime, notarized and stapled DMG
# Release env: PHONEDOCK_NOTARY_PROFILE  notarytool keychain profile (required; see `xcrun notarytool store-credentials`)
#              PHONEDOCK_SIGN_IDENTITY   signing identity (default: the first "Developer ID Application" in the keychain)
# Never installs anything into /Applications.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo 0.1.0)"
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
  echo "==> Release build, signing as: $IDENTITY"
fi
mkdir -p "$DIST" "$WORK"

echo "==> Building Swift app (release)"
swift build -c release --package-path "$ROOT/app"
BIN="$(swift build -c release --package-path "$ROOT/app" --show-bin-path)/PhoneDock"

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

echo "==> Assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/daemon" "$APP/Contents/Resources/cli" "$APP/Contents/Resources/bin"
cp "$BIN" "$APP/Contents/MacOS/PhoneDock"
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
  <key>CFBundleVersion</key><string>${VERSION}</string>
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
</dict>
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
  # Sign inside-out: nested executables first, then the app.
  codesign --force --timestamp --options runtime --entitlements "$NODE_ENT" -s "$IDENTITY" "$APP/Contents/Resources/node"
  codesign --force --timestamp --options runtime -s "$IDENTITY" "$APP"
  codesign --verify --deep --strict "$APP" && echo "    signature ok"
else
  echo "==> Codesigning (ad-hoc; use --release for a build other Macs can open)"
  codesign --force --deep -s - "$APP"
  codesign --verify --deep "$APP" && echo "    signature ok"
fi

echo "==> Packaging"
ZIP="$DIST/PhoneDock-$VERSION.zip"
DMG="$DIST/PhoneDock-$VERSION.dmg"
rm -f "$ZIP" "$DMG"
ditto -c -k --keepParent "$APP" "$ZIP"
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
  rm -f "$ZIP" && ditto -c -k --keepParent "$APP" "$ZIP"
  spctl --assess --type execute "$APP" && echo "    Gatekeeper accepts the app"
  spctl --assess --type open --context context:primary-signature "$DMG" && echo "    Gatekeeper accepts the DMG"
  shasum -a 256 "$DMG" "$ZIP" | sed "s|$DIST/||" > "$DIST/SHA256SUMS.txt"
fi

echo
echo "Built:"
du -sh "$APP" "$ZIP" "$DMG"
[ "$RELEASE" = 1 ] && cat "$DIST/SHA256SUMS.txt"
exit 0
