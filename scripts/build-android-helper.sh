#!/usr/bin/env bash
# Builds PhoneDock's on-device Android helper (a dex run with app_process) from its Java source and checks or
# updates the copy embedded in src/backends/android-helper.ts. The build is reproducible: the same JDK release
# target, android.jar and d8 give the same bytes.
# Usage: scripts/build-android-helper.sh --check | --update
# Env:   ANDROID_HOME (default: the Homebrew android-commandlinetools path), JAVA_HOME (JDK 17)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-}"
case "$MODE" in --check|--update) ;; *) echo "usage: scripts/build-android-helper.sh --check|--update" >&2; exit 2 ;; esac

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/opt/homebrew/share/android-commandlinetools}}"
JAR="$SDK/platforms/android-36/android.jar"
D8="$(ls -d "$SDK"/build-tools/*/ 2>/dev/null | sort -V | tail -n 1)d8"
JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}"
[ -f "$JAR" ] || { echo "error: $JAR not found (sdkmanager 'platforms;android-36')" >&2; exit 1; }
[ -x "$D8" ] || { echo "error: d8 not found under $SDK/build-tools (sdkmanager 'build-tools;36.0.0')" >&2; exit 1; }
[ -x "$JAVA_HOME/bin/javac" ] || { echo "error: javac not found; set JAVA_HOME to a JDK 17" >&2; exit 1; }

SRC="$ROOT/src/backends/android-helper/dev/phonedock/Helper.java"
TS="$ROOT/src/backends/android-helper.ts"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
"$JAVA_HOME/bin/javac" -nowarn --release 11 -classpath "$JAR" -d "$WORK/classes" "$SRC" 2>/dev/null
mkdir -p "$WORK/dex"
PATH="$JAVA_HOME/bin:$PATH" "$D8" --release --min-api 21 --lib "$JAR" --output "$WORK/dex" "$WORK/classes/dev/phonedock/"*.class
DEX="$WORK/dex/classes.dex"
BUILT="$(shasum -a 256 "$DEX" | cut -d' ' -f1)"
EMBEDDED="$(sed -n "s/^export const HELPER_DEX_SHA256 = '\([0-9a-f]*\)';/\1/p" "$TS")"

if [ "$MODE" = --check ]; then
  # Compare the embedded base64 itself, not only its recorded hash.
  EMBEDDED_BYTES="$(node -e "import('$TS').then(m => process.stdout.write(require('node:crypto').createHash('sha256').update(Buffer.from(m.HELPER_DEX_B64, 'base64')).digest('hex')))")"
  if [ "$BUILT" = "$EMBEDDED" ] && [ "$BUILT" = "$EMBEDDED_BYTES" ]; then
    echo "ok: the embedded helper matches its source ($BUILT)"; exit 0
  fi
  echo "mismatch: built $BUILT, recorded $EMBEDDED, embedded bytes $EMBEDDED_BYTES" >&2
  echo "run scripts/build-android-helper.sh --update after changing Helper.java" >&2
  exit 1
fi

node - "$TS" "$DEX" "$BUILT" <<'NODE'
const fs = require('node:fs');
const [ts, dex, sha] = process.argv.slice(2);
const b64 = fs.readFileSync(dex).toString('base64');
const lines = b64.match(/.{1,120}/g).map((l) => `  '${l}',`).join('\n');
let s = fs.readFileSync(ts, 'utf8');
s = s.replace(/^export const HELPER_DEX_SHA256 = '[0-9a-f]*';/m, `export const HELPER_DEX_SHA256 = '${sha}';`);
s = s.replace(/^export const HELPER_DEX_B64 = \[\n[\s\S]*?\n\]/m, `export const HELPER_DEX_B64 = [\n${lines}\n]`);
fs.writeFileSync(ts, s);
NODE
echo "updated: $TS ($BUILT)"
