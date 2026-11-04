#!/usr/bin/env bash
# Builds the PhoneDock Sample app for Android (debug-signed APK) with the plain SDK tools: no Gradle.
# Output: fixtures/android-sample/build/PhoneDockSample.apk
# Env overrides: ANDROID_SDK_ROOT, BUILD_TOOLS (version), PLATFORM (e.g. android-36), JAVA_HOME.
set -euo pipefail
cd "$(dirname "$0")"

SDK="${ANDROID_SDK_ROOT:-/opt/homebrew/share/android-commandlinetools}"
BT="$SDK/build-tools/${BUILD_TOOLS:-36.0.0}"
ANDROID_JAR="$SDK/platforms/${PLATFORM:-android-36}/android.jar"
JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}"
export JAVA_HOME PATH="$JAVA_HOME/bin:$PATH"
for f in "$BT/aapt2" "$BT/d8" "$BT/zipalign" "$BT/apksigner" "$ANDROID_JAR" "$JAVA_HOME/bin/javac" "$JAVA_HOME/bin/keytool"; do
  [ -e "$f" ] || { echo "build.sh: missing $f" >&2; exit 1; }
done

OUT=build
rm -rf "$OUT/gen" "$OUT/classes" "$OUT/dex" "$OUT/res.zip" "$OUT"/*.unaligned.apk "$OUT"/*.aligned.apk
mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex"

# 1. Resources → compiled .flat archive → linked base APK + R.java
"$BT/aapt2" compile --dir res -o "$OUT/res.zip"
"$BT/aapt2" link -o "$OUT/app.unaligned.apk" -I "$ANDROID_JAR" --manifest AndroidManifest.xml \
  --min-sdk-version 26 --target-sdk-version 36 --java "$OUT/gen" "$OUT/res.zip"

# 2. Java → classes → classes.dex
javac --release 17 -nowarn -encoding UTF-8 -classpath "$ANDROID_JAR" -d "$OUT/classes" \
  $(find src "$OUT/gen" -name '*.java')
"$BT/d8" --release --min-api 26 --lib "$ANDROID_JAR" --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')
(cd "$OUT/dex" && zip -q -j ../app.unaligned.apk classes.dex)

# 3. Align, then sign with a throwaway debug keystore (generated once under build/)
KS="$OUT/debug.keystore"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -storepass android -keypass android -alias androiddebugkey \
    -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=PhoneDock Debug,O=PhoneDock,C=US" >/dev/null 2>&1
fi
"$BT/zipalign" -f -p 4 "$OUT/app.unaligned.apk" "$OUT/app.aligned.apk"
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --out "$OUT/PhoneDockSample.apk" "$OUT/app.aligned.apk"
rm -f "$OUT/app.unaligned.apk" "$OUT/app.aligned.apk" "$OUT/PhoneDockSample.apk.idsig"
"$BT/apksigner" verify "$OUT/PhoneDockSample.apk"
echo "$PWD/$OUT/PhoneDockSample.apk"
