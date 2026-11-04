#!/usr/bin/env bash
# Builds the PhoneDock Sample app for the iOS Simulator (unsigned).
# Output: fixtures/ios-sample/build/Build/Products/Debug-iphonesimulator/PhoneDockSample.app
set -euo pipefail
cd "$(dirname "$0")"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
xcodegen generate --quiet
xcodebuild -project PhoneDockSample.xcodeproj -scheme PhoneDockSample -configuration Debug \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO -derivedDataPath build -quiet build
APP="$PWD/build/Build/Products/Debug-iphonesimulator/PhoneDockSample.app"
test -d "$APP" && echo "$APP"
