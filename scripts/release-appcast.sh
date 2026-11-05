#!/usr/bin/env bash
# Signs a release's update archive (the notarized PhoneDock-<version>.zip from `scripts/build-app.sh --release`) with
# the Sparkle EdDSA key and adds its item to the appcast that PhoneDock checks (site/appcast.xml, served by GitHub Pages
# at https://sushilk1991.github.io/phonedock/appcast.xml). It publishes nothing: docs/RELEASING.md has the next steps.
#
# Usage: scripts/release-appcast.sh [options] dist/PhoneDock-<version>.zip
#   --appcast FILE             appcast to update (default: site/appcast.xml)
#   --download-url-prefix URL  where the zip will be downloadable
#                              (default: https://github.com/sushilk1991/phonedock/releases/download/v<version>/)
#   --release-notes-url URL    (default: https://github.com/sushilk1991/phonedock/releases/tag/v<version>)
#   --ed-key-file FILE         private EdDSA key file instead of the login keychain (also PHONEDOCK_SPARKLE_KEY_FILE)
#   --account NAME             keychain account of the key `generate_keys --account phonedock` made (default: phonedock;
#                              also PHONEDOCK_SPARKLE_ACCOUNT)
#   --local-test               accept an ad-hoc signed, un-notarized app and loopback URLs (local update tests only)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
APPCAST="$ROOT/site/appcast.xml"
URL_PREFIX=""
NOTES_URL=""
KEY_FILE="${PHONEDOCK_SPARKLE_KEY_FILE:-}"
ACCOUNT="${PHONEDOCK_SPARKLE_ACCOUNT:-phonedock}"
LOCAL_TEST=0
ARCHIVE=""
die() { echo "error: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --appcast) APPCAST="$2"; shift 2 ;;
    --download-url-prefix) URL_PREFIX="$2"; shift 2 ;;
    --release-notes-url) NOTES_URL="$2"; shift 2 ;;
    --ed-key-file) KEY_FILE="$2"; shift 2 ;;
    --account) ACCOUNT="$2"; shift 2 ;;
    --local-test) LOCAL_TEST=1; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    -*) die "unknown option $1 (see --help)" ;;
    *) [ -z "$ARCHIVE" ] || die "one archive at a time"; ARCHIVE="$1"; shift ;;
  esac
done
[ -n "$ARCHIVE" ] || die "usage: scripts/release-appcast.sh [options] dist/PhoneDock-<version>.zip"
[ -f "$ARCHIVE" ] || die "no archive at $ARCHIVE"
[ -f "$APPCAST" ] || die "no appcast at $APPCAST"
[ -z "$KEY_FILE" ] || [ -f "$KEY_FILE" ] || die "no private key file at $KEY_FILE"
case "$ARCHIVE" in *.zip) ;; *) die "the update archive must be the .zip (Sparkle installs the app inside it)" ;; esac

# Sparkle's own tools, from the exact Sparkle version the app links (Package.swift pins it).
SPARKLE_BIN="$ROOT/app/.build/artifacts/sparkle/Sparkle/bin"
if [ ! -x "$SPARKLE_BIN/sign_update" ]; then
  swift package --package-path "$ROOT/app" resolve >/dev/null
fi
[ -x "$SPARKLE_BIN/sign_update" ] || die "Sparkle's sign_update is missing ($SPARKLE_BIN); run: swift package --package-path app resolve"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/phonedock-appcast.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# Look inside the archive at exactly what users will install.
ditto -x -k "$ARCHIVE" "$WORK/x"
APPS=("$WORK"/x/*.app)
[ ${#APPS[@]} = 1 ] && [ -d "${APPS[0]}" ] || die "$ARCHIVE should hold exactly one .app at its top level"
APP="${APPS[0]}"
plist() { /usr/libexec/PlistBuddy -c "Print :$1" "$APP/Contents/Info.plist" 2>/dev/null || true; }
VERSION="$(plist CFBundleShortVersionString)"
BUILD="$(plist CFBundleVersion)"
APP_KEY="$(plist SUPublicEDKey)"
FEED="$(plist SUFeedURL)"
MIN_OS="$(plist LSMinimumSystemVersion)"
[ -n "$VERSION" ] && [ -n "$BUILD" ] || die "the app in $ARCHIVE has no version or build number"
[[ "$BUILD" =~ ^[0-9]+$ ]] || die "CFBundleVersion '$BUILD' isn't a build number (scripts/build-app.sh sets one)"
[ -n "$APP_KEY" ] || die "the app in $ARCHIVE has no SUPublicEDKey, so it could never install a later update. Save the public key in app/sparkle-public-ed-key.txt (docs/RELEASING.md) and build again."
[ -n "$FEED" ] || die "the app in $ARCHIVE has no SUFeedURL"
MIN_OS="${MIN_OS:-15.0}"
REPO_KEY_FILE="$ROOT/app/sparkle-public-ed-key.txt"
if [ -f "$REPO_KEY_FILE" ]; then
  REPO_KEY="$(grep -v '^#' "$REPO_KEY_FILE" | tr -d ' \n\r\t')"
  [ "$REPO_KEY" = "$APP_KEY" ] || [ "$LOCAL_TEST" = 1 ] || die "the app's SUPublicEDKey differs from app/sparkle-public-ed-key.txt; installed copies would reject it"
fi

if [ "$LOCAL_TEST" = 1 ]; then
  echo "    local test: skipping the Developer ID and notarization checks"
  codesign --verify --deep --strict "$APP" || die "the app's code signature is broken"
else
  codesign --verify --deep --strict "$APP" || die "the app's code signature is broken"
  INFO="$(codesign -dvv "$APP" 2>&1)"
  grep -q '^Authority=Developer ID Application:' <<<"$INFO" || die "the app isn't signed with a Developer ID Application certificate"
  grep -q '^TeamIdentifier=[A-Z0-9]\{10\}$' <<<"$INFO" || die "the app has no Team ID"
  grep -q 'flags=.*runtime' <<<"$INFO" || die "the app isn't signed with the hardened runtime"
  xcrun stapler validate "$APP" >/dev/null 2>&1 || die "the app has no stapled notarization ticket (build with --release)"
  spctl --assess --type execute "$APP" 2>/dev/null || die "Gatekeeper rejects the app"
fi
ARCHS="$(lipo -archs "$APP/Contents/MacOS/PhoneDock" 2>/dev/null || true)"
HARDWARE=""
[ "$ARCHS" = "arm64" ] && HARDWARE="arm64"   # the app and its bundled node are arm64-only

[ -n "$URL_PREFIX" ] || URL_PREFIX="https://github.com/sushilk1991/phonedock/releases/download/v$VERSION/"
[ -n "$NOTES_URL" ] || NOTES_URL="https://github.com/sushilk1991/phonedock/releases/tag/v$VERSION"
case "$URL_PREFIX" in */) ;; *) URL_PREFIX="$URL_PREFIX/" ;; esac
DOWNLOAD_URL="$URL_PREFIX$(basename "$ARCHIVE")"
if [ "$LOCAL_TEST" != 1 ]; then
  case "$DOWNLOAD_URL" in https://*) ;; *) die "the download URL must be https ($DOWNLOAD_URL)" ;; esac
fi

echo "==> Signing $(basename "$ARCHIVE") (PhoneDock $VERSION, build $BUILD)"
SIGN_ARGS=(-p)
if [ -n "$KEY_FILE" ]; then SIGN_ARGS+=(--ed-key-file "$KEY_FILE"); else SIGN_ARGS+=(--account "$ACCOUNT"); fi
if ! SIGNATURE="$("$SPARKLE_BIN/sign_update" "${SIGN_ARGS[@]}" "$ARCHIVE" 2>"$WORK/sign.err")"; then
  cat "$WORK/sign.err" >&2
  if [ -n "$KEY_FILE" ]; then die "sign_update couldn't sign with $KEY_FILE"; fi
  die "no Sparkle private key for account '$ACCOUNT' in your login keychain. Create it once with: $SPARKLE_BIN/generate_keys --account $ACCOUNT (docs/RELEASING.md)"
fi
SIGNATURE="$(tr -d ' \n\r' <<<"$SIGNATURE")"
[[ "$SIGNATURE" =~ ^[A-Za-z0-9+/]{86}==$ ]] || die "sign_update printed an unexpected signature: $SIGNATURE"
LENGTH="$(stat -f %z "$ARCHIVE")"

# The proof that matters: the signature verifies under the key inside the app, the key installed copies have.
swiftc -O -o "$WORK/ed25519-verify" "$ROOT/scripts/ed25519-verify.swift" 2>/dev/null || die "couldn't build scripts/ed25519-verify.swift"
"$WORK/ed25519-verify" "$APP_KEY" "$SIGNATURE" "$ARCHIVE" \
  || die "the signature doesn't match the app's SUPublicEDKey: the private key isn't the one this app trusts"
echo "    signature verifies with the app's SUPublicEDKey"

echo "==> Adding the item to $APPCAST"
python3 -I - "$APPCAST" "$VERSION" "$BUILD" "$MIN_OS" "$HARDWARE" "$NOTES_URL" "$DOWNLOAD_URL" "$LENGTH" "$SIGNATURE" <<'PY'
import re, sys, xml.etree.ElementTree as ET
from email.utils import formatdate
from xml.sax.saxutils import escape, quoteattr
path, version, build, min_os, hardware, notes, url, length, signature = sys.argv[1:]
text = open(path, encoding="utf-8").read()
if "<channel>" not in text or "</channel>" not in text:
    sys.exit(f"error: {path} has no <channel>")
# Items inside the channel, skipping XML comments (which may mention items).
start, end = text.index("<channel>"), text.index("</channel>")
matches = list(re.finditer(r"<!--.*?-->|[ \t]*<item>.*?</item>\n?", text[start:end], flags=re.S))
spans = [(start + m.start(), start + m.end()) for m in matches if not m.group(0).startswith("<!--")]
items = [text[a:b] for a, b in spans]
def build_of(item):
    m = re.search(r"<sparkle:version>\s*(\d+)\s*</sparkle:version>", item)
    return int(m.group(1)) if m else -1
same = [i for i in items if build_of(i) == int(build)]
newer = [build_of(i) for i in items if build_of(i) > int(build)]
if newer:
    sys.exit(f"error: the appcast already has build {max(newer)}, newer than {build}; bump the version")
for a, b in reversed([s for s, i in zip(spans, items) if build_of(i) == int(build)]):
    text = text[:a] + text[b:]   # re-running for the same build replaces its item
hw =f"\n      <sparkle:hardwareRequirements>{escape(hardware)}</sparkle:hardwareRequirements>" if hardware else ""
item = f"""    <item>
      <title>PhoneDock {escape(version)}</title>
      <pubDate>{formatdate(usegmt=True)}</pubDate>
      <sparkle:version>{escape(build)}</sparkle:version>
      <sparkle:shortVersionString>{escape(version)}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>{escape(min_os)}</sparkle:minimumSystemVersion>{hw}
      <sparkle:releaseNotesLink>{escape(notes)}</sparkle:releaseNotesLink>
      <enclosure url={quoteattr(url)} length="{int(length)}" type="application/octet-stream" sparkle:edSignature={quoteattr(signature)}/>
    </item>
"""
remaining = [(a, b) for (a, b), i in zip(spans, items) if build_of(i) != int(build)]
if remaining:   # newest first: before the first item still there (spans before the removed ones are unchanged)
    first = min(a for a, _ in remaining)
    removed_before = sum(b - a for (a, b), i in zip(spans, items) if build_of(i) == int(build) and b <= first)
    at = first - removed_before
else:           # the channel's first item: on its own line before </channel>
    end = text.index("</channel>")
    at = text.rfind("\n", 0, end) + 1
text = text[:at] + item + text[at:]
ET.fromstring(text.encode("utf-8"))   # still well-formed XML
open(path, "w", encoding="utf-8").write(text)
print(f"    {'replaced' if same else 'added'} PhoneDock {version} (build {build}); {len(items) - len(same) + 1} item(s) in the appcast")
PY

cat <<EOF

Signed: $(basename "$ARCHIVE")  length=$LENGTH
        sparkle:edSignature=$SIGNATURE
Feed the app reads: $FEED
EOF
if [ "$LOCAL_TEST" != 1 ]; then
  cat <<EOF

Next, in this order (docs/RELEASING.md); nothing has been published yet:
  1. Upload the archive where the appcast points:
       gh release create v$VERSION "$ARCHIVE" "${ARCHIVE%.zip}.dmg" --title "PhoneDock $VERSION" --notes-file <notes.md>
     It must answer at: $DOWNLOAD_URL
  2. Publish the appcast: commit $(basename "$APPCAST") and push to main (the Pages workflow deploys site/).
     Running copies see the update at their next launch or within a day.
EOF
fi
