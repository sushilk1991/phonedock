#!/usr/bin/env bash
# End-to-end test of the Android path: daemon HTTP API, CLI and MCP against one Android emulator, using the
# sample app in fixtures/android-sample (built on demand).
#
# Usage: scripts/e2e-android.sh
# Env:   PHONEDOCK_PORT  test daemon port (default 47480; 47420 and 47450 are refused, they belong to the app/others)
#        E2E_DEVICE      device id (default android-emulator:PhoneDock-Pixel)
#        E2E_AVD         AVD name the device must report before any input is sent (default PhoneDock-Pixel)
#        E2E_KEEP_DAEMON=1  leave the daemon running at the end
#
# Starts a daemon from this tree on PHONEDOCK_PORT, prints one PASS/FAIL/SKIP line per step with its time, stops the
# daemon on exit (and removes daemon-<port>.json). Leaves the emulator on its home screen, in portrait, with the
# sample app uninstalled. Exit status: 0 when every step passed, 1 otherwise.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
export PHONEDOCK_PORT="${PHONEDOCK_PORT:-47480}"
DEV="${E2E_DEVICE:-android-emulator:PhoneDock-Pixel}"
AVD="${E2E_AVD:-PhoneDock-Pixel}"
PKG=dev.phonedock.sample
APK="$REPO/fixtures/android-sample/build/PhoneDockSample.apk"
PD="$REPO/bin/phonedock"
PD_HOME="${PHONEDOCK_HOME:-$HOME/Library/Application Support/PhoneDock}"
INFO="$PD_HOME/daemon-$PHONEDOCK_PORT.json"
BASE="http://127.0.0.1:$PHONEDOCK_PORT"
DEV_ENC="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$DEV")"
export PHONEDOCK_OWNER="${PHONEDOCK_OWNER:-e2e:android}"
TMP="$(mktemp -d -t pd-e2e-android)"

case "$PHONEDOCK_PORT" in
  47420|47450) echo "refusing to run on port $PHONEDOCK_PORT (shared daemon); use a dedicated test port" >&2; exit 2 ;;
esac
for t in node jq curl; do command -v "$t" >/dev/null || { echo "missing tool: $t" >&2; exit 2; }; done

now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time*1000'; }
PASSED=0; FAILED=0; SKIPPED=0; RESULTS=()
NOTE=""   # a step may set NOTE to a short detail shown on its PASS line

# step "<name>" <function> : runs the function, captures its output, prints PASS/FAIL with timing.
step() {
  local name="$1"; shift
  local t0 t1 out rc
  NOTE=""
  t0=$(now_ms)
  ( "$@" ) > "$TMP/step.out" 2>&1; rc=$?   # subshell: `die` exits the step, not the script
  t1=$(now_ms)
  out="$(cat "$TMP/step.out")"
  local secs; secs=$(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%6.2fs", (b-a)/1000}')
  if [ $rc -eq 0 ]; then
    NOTE="$(printf '%s' "$out" | grep '^NOTE:' | tail -1 | sed 's/^NOTE: //')"
    PASSED=$((PASSED+1)); RESULTS+=("PASS $secs  $name${NOTE:+  ($NOTE)}")
    printf 'PASS %s  %s%s\n' "$secs" "$name" "${NOTE:+  ($NOTE)}"
  elif [ $rc -eq 77 ]; then
    NOTE="$(printf '%s' "$out" | grep '^NOTE:' | tail -1 | sed 's/^NOTE: //')"
    SKIPPED=$((SKIPPED+1)); RESULTS+=("SKIP $secs  $name${NOTE:+  ($NOTE)}")
    printf 'SKIP %s  %s%s\n' "$secs" "$name" "${NOTE:+  ($NOTE)}"
  else
    FAILED=$((FAILED+1)); RESULTS+=("FAIL $secs  $name")
    printf 'FAIL %s  %s\n' "$secs" "$name"
    printf '%s\n' "$out" | grep -v '^NOTE:' | tail -15 | sed 's/^/       | /'
  fi
}
note() { echo "NOTE: $*"; }
die() { echo "$*"; exit 1; }   # steps run in a subshell, so this ends only the current step

pd() { "$PD" "$@"; }
token() { jq -r .token "$INFO"; }
# api METHOD PATH [json-body] → body on stdout; HTTP status in $TMP/status
api() {
  local m="$1" p="$2" body="${3:-}"
  local args=(-s -o "$TMP/body" -w '%{http_code}' -X "$m" -H "Authorization: Bearer $(token)" -H "X-PhoneDock-Owner: $PHONEDOCK_OWNER")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  curl "${args[@]}" "$BASE$p" > "$TMP/status"
  cat "$TMP/body"
}
status() { cat "$TMP/status"; }
foreground() { pd foreground "$DEV" --json | jq -r '.app.id // "none"'; }
ui_text() { pd ui "$DEV"; }

cleanup() {
  local rc=$?
  # Leave the device as we found it: portrait, sample app gone, home screen.
  if [ -f "$INFO" ] && [ -f "$TMP/device-ok" ]; then
    pd rotate "$DEV" portrait >/dev/null 2>&1 || true
    if pd apps "$DEV" --json 2>/dev/null | jq -e --arg p "$PKG" 'any(.[]; .id == $p)' >/dev/null 2>&1; then
      pd uninstall "$DEV" "$PKG" >/dev/null 2>&1 || true
    fi
    pd key "$DEV" home >/dev/null 2>&1 || true
    pd release "$DEV" >/dev/null 2>&1 || true
  fi
  if [ "${E2E_KEEP_DAEMON:-0}" != 1 ]; then
    pd daemon stop >/dev/null 2>&1 || true
    rm -f "$INFO"
  fi
  rm -rf "$TMP"
  exit $rc
}
trap cleanup EXIT INT TERM

# ── steps ───────────────────────────────────────────────────────────────────────
s_build_apk() {
  if [ ! -f "$APK" ] || [ -n "$(find "$REPO/fixtures/android-sample" -newer "$APK" \( -name '*.java' -o -name '*.xml' -o -name build.sh \) -not -path '*/build/*' | head -1)" ]; then
    "$REPO/fixtures/android-sample/build.sh" || return 1
  fi
  [ -f "$APK" ] || die "no APK at $APK"
  note "$(du -k "$APK" | cut -f1) KB"
}
s_daemon_start() {
  if curl -sf "$BASE/v1/health" >/dev/null 2>&1; then pd daemon stop >/dev/null; rm -f "$INFO"; fi
  pd daemon start || return 1
  local h; h="$(curl -sf "$BASE/v1/health")" || die "health check failed"
  [ -f "$INFO" ] || die "missing $INFO"
  [ "$(jq -r .pid "$INFO")" = "$(echo "$h" | jq -r .pid)" ] || die "daemon-$PHONEDOCK_PORT.json pid does not match /v1/health"
  note "pid $(echo "$h" | jq -r .pid), v$(echo "$h" | jq -r .version)"
}
s_devices() {
  local st; st="$(pd devices --backend android-emulator --json | jq -r --arg d "$DEV" '.[] | select(.id == $d) | .state')"
  [ "$st" = running ] || die "device $DEV state is '${st:-missing}', want running"
  note "$DEV running"
}
s_info() {
  local j; j="$(pd info "$DEV" --json)" || return 1
  local avd; avd="$(echo "$j" | jq -r '.props["ro.boot.qemu.avd_name"] // .avd // empty')"
  [ "$avd" = "$AVD" ] || die "device reports AVD '$avd', want '$AVD' – refusing to send input"
  touch "$TMP/device-ok"
  note "AVD $avd, Android $(echo "$j" | jq -r '.props["ro.build.version.release"] // "?"')"
}
s_screenshot() {
  pd screenshot "$DEV" -o "$TMP/shot.png" >/dev/null || return 1
  [ "$(head -c 8 "$TMP/shot.png" | xxd -p)" = "89504e470d0a1a0a" ] || die "not a PNG"
  local wh; wh="$(node -e 'const b=require("fs").readFileSync(process.argv[1]);console.log(b.readUInt32BE(16)+"x"+b.readUInt32BE(20))' "$TMP/shot.png")"
  case "$wh" in 0x*|*x0) die "bad PNG size $wh";; esac
  note "PNG $wh"
}
s_frame() {
  # The first poll may be the screenshot fallback (stream warming up, no ETag); poll until the live stream answers.
  # On a still screen the Android encoder emits nothing, so the stream may only start once something moves:
  # after ~3 s of fallbacks, open and close the app drawer once.
  local hdr="$TMP/frame.h" src="" etag="" i nudged=""
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
    if [ "$i" = 8 ] && [ -z "$nudged" ]; then
      pd swipe "$DEV" 540 1900 540 500 300 >/dev/null; pd key "$DEV" home >/dev/null; nudged=" after a screen change"
    fi
    curl -s -D "$hdr" -o "$TMP/frame.jpg" -H "Authorization: Bearer $(token)" "$BASE/v1/devices/$DEV_ENC/frame?maxSize=720" >/dev/null
    grep -q '^HTTP/1.1 200' "$hdr" || die "frame: $(head -1 "$hdr")"
    grep -qi '^content-type: image/jpeg' "$hdr" || die "frame content-type is not image/jpeg"
    [ "$(head -c 3 "$TMP/frame.jpg" | xxd -p)" = "ffd8ff" ] || die "frame is not a JPEG"
    src="$(grep -i '^x-frame-source:' "$hdr" | awk '{print $2}' | tr -d '\r')"
    etag="$(grep -i '^etag:' "$hdr" | sed 's/^[^:]*: *//' | tr -d '\r')"
    [ "$src" = stream ] && break
    sleep 0.25
  done
  [ "$src" = stream ] || die "frame never came from the live stream (last source: ${src:-?})"
  local size; size="$(wc -c < "$TMP/frame.jpg" | tr -d ' ')"
  if [ -z "$etag" ]; then note "JPEG $size B from the stream$nudged; no ETag (304 not supported)"; exit 0; fi
  # Unchanged frame → 304. A frame may change between polls (clock, caret), so retry with the newest ETag.
  local code="" n=0
  for i in 1 2 3 4 5 6 7 8 9 10; do
    code="$(curl -s -D "$hdr" -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(token)" -H "If-None-Match: $etag" "$BASE/v1/devices/$DEV_ENC/frame?maxSize=720")"
    n=$i
    [ "$code" = 304 ] && break
    [ "$code" = 200 ] || die "If-None-Match → HTTP $code"
    etag="$(grep -i '^etag:' "$hdr" | sed 's/^[^:]*: *//' | tr -d '\r')"
    sleep 0.1
  done
  [ "$code" = 304 ] || die "never got 304 for an unchanged frame"
  note "JPEG $size B from the stream$nudged; If-None-Match → 304 (try $n)"
}
s_ui_tree() {
  local t; t="$(ui_text)" || return 1
  echo "$t" | head -1 | grep -q '^# accessibility' || die "ui header: $(echo "$t" | head -1)"
  [ "$(echo "$t" | grep -c '^e[0-9]')" -gt 3 ] || die "ui tree too small"
  note "$(echo "$t" | grep -c '^e[0-9]') elements"
}
s_lease() {
  local l; l="$(PHONEDOCK_OWNER=e2e:holder pd lease "$DEV" --ttl 60 --json)" || return 1
  [ "$(echo "$l" | jq -r .owner)" = e2e:holder ] || die "lease owner: $l"
  local code; PHONEDOCK_OWNER=e2e:intruder api POST "/v1/devices/$DEV_ENC/input" '{"action":"key","key":"home"}' > "$TMP/conf.json"
  code="$(status)"
  [ "$code" = 409 ] && [ "$(jq -r .error.code "$TMP/conf.json")" = lease_conflict ] || die "intruder input: HTTP $code $(cat "$TMP/conf.json")"
  PHONEDOCK_OWNER=e2e:holder pd release "$DEV" >/dev/null || return 1
  local after; after="$(api GET "/v1/devices/$DEV_ENC" | jq -c '.lease')"
  [ "$after" = null ] || die "lease still held after release: $after"
  note "acquire → 409 lease_conflict for another owner → release"
}
s_preclean() {
  if pd apps "$DEV" --json | jq -e --arg p "$PKG" 'any(.[]; .id == $p)' >/dev/null; then pd uninstall "$DEV" "$PKG" >/dev/null || return 1; note "removed a previous install"; else note "not installed"; fi
}
s_install() {
  local r; r="$(pd install "$DEV" "$APK" --json)" || return 1
  [ "$(echo "$r" | jq -r .app.id)" = "$PKG" ] || die "install result: $r"
  note "$(echo "$r" | jq -r '.app.name + " " + .app.version')"
}
s_apps_has() {
  local j; j="$(pd apps "$DEV" --json)" || return 1
  echo "$j" | jq -e --arg p "$PKG" 'any(.[]; .id == $p)' >/dev/null || die "$PKG not in apps list"
  # The label comes from the install (seeded) or the on-device helper; give a background lookup one retry.
  local name; name="$(echo "$j" | jq -r --arg p "$PKG" '.[] | select(.id == $p) | .name // empty')"
  if [ -z "$name" ]; then sleep 1.5; name="$(pd apps "$DEV" --json | jq -r --arg p "$PKG" '.[] | select(.id == $p) | .name // empty')"; fi
  [ "$name" = "PhoneDock Sample" ] || die "$PKG has name '${name}', want 'PhoneDock Sample'"
  note "$PKG = \"$name\""
}
s_launch() {
  pd launch "$DEV" "$PKG" >/dev/null || return 1
  pd wait-for "$DEV" visible --text "PhoneDock Sample" --timeout 10000 >/dev/null || return 1
  [ "$(foreground)" = "$PKG" ] || die "foreground is $(foreground)"
  note "foreground $PKG"
}
s_ui_title() { ui_text | grep -q '"PhoneDock Sample"' || die "UI tree has no \"PhoneDock Sample\""; }
dismiss_stylus_onboarding() {
  # Gboard shows a one-time "Try out your stylus" sheet on first focus. It lives in the IME window, which
  # uiautomator does not dump, so look for it with OCR (find falls back to OCR when the tree has no match).
  if pd find "$DEV" "Try out your stylus" --json 2>/dev/null | jq -e '.match != null' >/dev/null; then
    pd tap "$DEV" --text Cancel >/dev/null 2>&1 || pd key "$DEV" back >/dev/null
    echo "NOTE: dismissed Gboard stylus onboarding"
  fi
}
s_type_greet() {
  pd tap "$DEV" --text "Your name" --type EditText >/dev/null || exit 1
  dismiss_stylus_onboarding
  pd focus "$DEV" --timeout 2000 --json | jq -e '.focused.id // "" | test("nameField")' >/dev/null || pd tap "$DEV" --text "Your name" --type EditText >/dev/null
  pd type "$DEV" Ada >/dev/null || exit 1
  ui_text | grep nameField | grep -q '"Ada"' || die "name field after typing: $(ui_text | grep nameField)"
  pd tap "$DEV" --text Greet --type Button >/dev/null || exit 1
  pd wait-for "$DEV" visible --text "Hello, Ada!" --timeout 5000 >/dev/null || die "no \"Hello, Ada!\" on screen: $(ui_text | grep -E 'greeting|Hello')"
  note "\"Hello, Ada!\" shown"
}
s_switch() {
  local before; before="$(ui_text | grep notifyStatus)"
  if echo "$before" | grep -q 'Notifications on'; then pd tap "$DEV" --text Notifications --type Switch >/dev/null; sleep 0.5; fi
  pd tap "$DEV" --text Notifications --type Switch >/dev/null || return 1
  pd wait-for "$DEV" visible --text "Notifications on" --match exact --timeout 5000 >/dev/null || die "no \"Notifications on\""
  ui_text | grep notifyToggle | grep -qE ',on\]|\[on\]' || die "switch not reported as on: $(ui_text | grep notifyToggle)"
  note "Switch on → \"Notifications on\""
}
s_expect() {
  # expect on an input: verified / not verified because the screen did not change / changed but the text never
  # appeared (exit 1 for both), with the delivery on every result; an error before anything was sent is retry-safe.
  local r
  r="$(pd --json launch "$DEV" "$PKG" --expect "PhoneDock Sample")" || die "launch --expect: $(echo "$r" | jq -r '.expect.message // .')"
  local want=on; ui_text | grep notifyStatus | grep -q 'Notifications on' && want=off
  r="$(pd --json tap "$DEV" --text Notifications --type Switch --expect "Notifications $want" --expect-match exact)" || die "not verified: $(echo "$r" | jq -r '.expect.message // .')"
  [ "$(echo "$r" | jq -r .expect.outcome)" = verified ] || die "outcome: $(echo "$r" | jq -c .expect)"
  [ "$(echo "$r" | jq -r '.delivery + " " + (.retrySafe|tostring)')" = "sent false" ] || die "delivery: $(echo "$r" | jq -c '{delivery, retrySafe}')"
  r="$(pd --json tap "$DEV" --text Notifications --type Switch --expect "pdtest nothing like this" --expect-timeout 1500)" && die "an unmet expect exited 0"
  [ "$(echo "$r" | jq -r .expect.outcome)" = changed_not_found ] || die "switch flip: $(echo "$r" | jq -c .expect)"
  r="$(pd --json tap "$DEV" --text "PhoneDock Sample" --type TextView --expect "pdtest nothing like this" --expect-timeout 1500)" && die "an unmet expect exited 0"
  [ "$(echo "$r" | jq -r .expect.outcome)" = screen_unchanged ] || die "label tap: $(echo "$r" | jq -c .expect)"
  local c; c="$(pd find "$DEV" Notifications --type Switch --json | jq -c '.match.center')"
  r="$(api POST "/v1/devices/$DEV_ENC/input" "{\"actions\":[{\"action\":\"tap\",\"x\":$(echo "$c" | jq .x),\"y\":$(echo "$c" | jq .y)}],\"expect\":{\"changed\":true}}")"
  [ "$(echo "$r" | jq -r '.expect.outcome + " " + .delivery')" = "verified sent" ] || die "batch: HTTP $(status) $r"
  r="$(api POST "/v1/devices/$DEV_ENC/input" '{"action":"tap","x":1,"y":1,"expect":{"visble":"x"}}')"
  [ "$(status)" = 400 ] && [ "$(echo "$r" | jq -r '.error.delivery + " " + (.error.retrySafe|tostring)')" = "not_sent true" ] || die "bad expect: HTTP $(status) $r"
  note "verified / changed_not_found / screen_unchanged; batch {changed}; bad expect → 400 not_sent, retry-safe"
}
s_headsup_scroll() {
  # A heads-up notification over Settings: the UI read describes Settings and reports the heads-up as an overlay, and
  # a swipe scrolls Settings' own list, never the notification shade's (the QS bug: expanded_qs_scroll_view).
  pd shell "$DEV" -- pm grant "$PKG" android.permission.POST_NOTIFICATIONS >/dev/null || return 1
  pd shell "$DEV" -- am start -W --activity-clear-task -a android.settings.SETTINGS >/dev/null || return 1
  pd wait-for "$DEV" visible --text "Network & internet" --timeout 10000 >/dev/null || die "Settings did not open"
  pd shell "$DEV" -- am broadcast -n "$PKG/.NotifyReceiver" --es title pdtest --es text "headsup-$$" >/dev/null || return 1
  local t="" i
  for i in 1 2 3 4 5 6 7 8 9 10; do t="$(ui_text)"; echo "$t" | grep -q '^# Over the screen: heads-up' && break; sleep 0.3; done
  echo "$t" | grep -q "^# Over the screen: heads-up notification: .*headsup-$$" || die "no heads-up line: $(echo "$t" | head -3)"
  echo "$t" | grep -q '"Network & internet"' || die "the tree is not Settings"
  echo "$t" | grep -qE 'id=(expanded_qs_scroll_view|qs_frame|notification_stack_scroller)' && die "the tree has the shade's elements: $(echo "$t" | grep -E 'qs_|notification_stack' | head -2)"
  local w; w="$(api GET "/v1/devices/$DEV_ENC/ui")"
  echo "$w" | jq -e 'any(.windows[]?; .role == "heads_up") and any(.windows[]?; .role == "app" and .package == "com.android.settings")' >/dev/null \
    || die "windows: $(echo "$w" | jq -c '[.windows[]? | {role, package}]')"
  local s; s="$(api POST "/v1/devices/$DEV_ENC/swipe" '{"direction":"up"}')"
  local cid; cid="$(echo "$s" | jq -r '.container.id // ""')"
  case "$cid" in com.android.systemui:*) die "swiped in the SystemUI container $cid";; com.android.settings:*) ;; *) die "swipe: HTTP $(status) $s";; esac
  pd key "$DEV" home >/dev/null
  note "heads-up reported (try $i); swiped in ${cid#com.android.settings:id/}"
}
s_key_back_home() {
  pd key "$DEV" back >/dev/null || return 1
  pd key "$DEV" back >/dev/null || return 1   # first back may only clear focus / hide the keyboard
  sleep 0.5
  local fg; fg="$(foreground)"
  [ "$fg" != "$PKG" ] || die "still in $PKG after back"
  pd launch "$DEV" "$PKG" >/dev/null && sleep 0.8
  pd key "$DEV" home >/dev/null || return 1
  sleep 0.5
  fg="$(foreground)"
  [ "$fg" != "$PKG" ] || die "still in $PKG after home"
  note "back → $fg; home → $fg"
}
s_swipe() {
  # On the home screen a swipe up opens the app drawer, which lists the sample app by name.
  pd swipe "$DEV" 540 1900 540 500 300 >/dev/null || return 1
  pd wait-for "$DEV" visible --text "PhoneDock Sample" --timeout 5000 >/dev/null || die "app drawer did not open"
  pd key "$DEV" home >/dev/null
  note "swipe up opened the app drawer"
}
screen_wh() { pd ui "$DEV" | head -1 | awk '{print $3}'; }
s_rotate() {
  pd launch "$DEV" "$PKG" >/dev/null || return 1
  pd rotate "$DEV" landscape >/dev/null || return 1
  local wh; for _ in 1 2 3 4 5 6 7 8 9 10; do sleep 0.5; wh="$(screen_wh)"; [ "$wh" = 2424x1080 ] && break; done
  [ "$wh" = 2424x1080 ] || die "landscape screen is $wh"
  pd rotate "$DEV" portrait >/dev/null || return 1
  local wh2; for _ in 1 2 3 4 5 6 7 8 9 10; do sleep 0.5; wh2="$(screen_wh)"; [ "$wh2" = 1080x2424 ] && break; done
  [ "$wh2" = 1080x2424 ] || die "portrait screen is $wh2"
  note "$wh → $wh2"
}
s_logs() {
  local n; n="$(pd logs "$DEV" -n 300 --filter "$PKG" | grep -c "$PKG")"
  [ "$n" -gt 0 ] || die "no log lines mention $PKG"
  note "$n lines mention $PKG"
}
s_mcp() {
  pd launch "$DEV" "$PKG" >/dev/null || return 1
  pd wait-for "$DEV" visible --text "PhoneDock Sample" --timeout 10000 >/dev/null || return 1
  local o; o="$(node "$REPO/scripts/e2e-android-mcp.mjs" "$DEV" "PhoneDock Sample")"; local rc=$?
  echo "$o"
  [ $rc -eq 0 ] || return 1
  note "$(echo "$o" | jq -r 'select(.tool) | .tool + (if .ms then " " + (.ms|tostring) + "ms" else "" end)' | paste -sd, - | sed 's/,/, /g')"
}
s_recording() {
  local r; r="$(pd record "$DEV" start --max 60 --json)" || return 1
  pd swipe "$DEV" 540 1600 540 900 300 >/dev/null; sleep 1
  pd tap "$DEV" --text Greet >/dev/null; sleep 2
  local s; s="$(pd record "$DEV" stop --json)" || return 1
  local f; f="$(echo "$s" | jq -r .path)"
  [ -s "$f" ] || die "no file at $f"
  if command -v ffprobe >/dev/null; then
    local dur; dur="$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$f")" || die "ffprobe failed on $f"
    awk -v d="$dur" 'BEGIN{exit !(d > 1)}' || die "duration $dur s"
    note "$(basename "$f"), $(echo "$s" | jq -r .sizeBytes) B, ${dur%.*}s (ffprobe)"
  else
    note "$(basename "$f"), $(echo "$s" | jq -r .sizeBytes) B"
  fi
  rm -f "$f"
}
s_crash() {
  pd launch "$DEV" "$PKG" >/dev/null || return 1
  pd wait-for "$DEV" visible --text Crash --timeout 5000 >/dev/null || return 1
  local since; since="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  pd tap "$DEV" --text Crash --type Button >/dev/null || return 1
  local list n=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    list="$(pd crashes "$DEV" --app "$PKG" --since "$since" --json)" || return 1
    n="$(echo "$list" | jq 'length')"; [ "$n" -gt 0 ] && break
  done
  [ "$n" -gt 0 ] || die "no crash for $PKG since $since (unfiltered newest: $(pd crashes "$DEV" --limit 1 --json | jq -c '.[0] | {time, appId}'))"
  echo "$list" | jq -e '.[0].summary | test("PhoneDock sample crash")' >/dev/null || die "summary: $(echo "$list" | jq -r '.[0].summary')"
  local id; id="$(echo "$list" | jq -r '.[0].id')"
  pd crashes "$DEV" "$id" | grep -q 'IllegalStateException' || die "crash $id text has no exception"
  [ "$(foreground)" != "$PKG" ] || die "app still in foreground after crash"
  note "$id: $(echo "$list" | jq -r '.[0].summary' | cut -c1-70)"
}
s_open_url() {
  pd open-url "$DEV" https://example.com >/dev/null || return 1
  local fg; for _ in 1 2 3 4 5 6; do sleep 0.5; fg="$(foreground)"; [ "$fg" != none ] && [ "$fg" != "$PKG" ] && break; done
  case "$fg" in none|"$PKG"|*launcher*) die "foreground after open-url: $fg";; esac
  pd key "$DEV" home >/dev/null
  note "opened in $fg"
}
s_terminate() {
  pd launch "$DEV" "$PKG" >/dev/null || return 1
  pd wait-for "$DEV" visible --text "PhoneDock Sample" --timeout 10000 >/dev/null || return 1
  pd terminate "$DEV" "$PKG" >/dev/null || return 1
  sleep 0.8
  [ "$(foreground)" != "$PKG" ] || die "$PKG still in foreground"
  local pid; pid="$(pd shell "$DEV" -- pidof "$PKG" 2>/dev/null | tr -d '[:space:]')"
  [ -z "$pid" ] || die "$PKG still running (pid $pid)"
  note "not running"
}
s_uninstall() {
  pd uninstall "$DEV" "$PKG" >/dev/null || return 1
  ! pd apps "$DEV" --json | jq -e --arg p "$PKG" 'any(.[]; .id == $p)' >/dev/null || die "$PKG still listed"
  note "apps list no longer has $PKG"
}
s_err_missing_file() {
  local r rc; r="$(pd install "$DEV" "$TMP/no-such-app.apk" --json 2>&1)"; rc=$?
  [ $rc -ne 0 ] || die "install of a missing file succeeded"
  local code msg det; code="$(echo "$r" | jq -r .error.code)"; msg="$(echo "$r" | jq -r .error.message)"; det="$(echo "$r" | jq -r '.error.detail // ""')"
  [ "$code" = not_found ] || die "code $code"
  case "$msg" in *"/"*|*".apk"*|*ENOENT*|*"HTTP"*) die "message is not plain: $msg";; esac
  echo "$det" | grep -q 'no-such-app.apk' || die "detail lacks the path: $det"
  note "\"$msg\" + detail \"$(echo "$det" | head -1 | cut -c1-60)\""
}
s_err_unknown_device() {
  local b; b="$(api GET "/v1/devices/android-emulator%3Apdtest-no-such-device")"
  [ "$(status)" = 404 ] || die "HTTP $(status)"
  [ "$(echo "$b" | jq -r .error.code)" = not_found ] || die "body: $b"
  local b2; b2="$(api POST "/v1/devices/android-emulator%3Apdtest-no-such-device/input" '{"action":"key","key":"home"}')"
  [ "$(status)" = 404 ] || die "input on unknown device: HTTP $(status) $b2"
  note "404 not_found: \"$(echo "$b" | jq -r .error.message)\""
}
s_handoff() {
  local h; h="$(PHONEDOCK_OWNER=e2e:agent pd handoff request "$DEV" "E2E: please confirm" --timeout 120 --json)" || return 1
  local hid; hid="$(echo "$h" | jq -r .id)"
  [ "$(echo "$h" | jq -r .state)" = pending ] || die "state $(echo "$h" | jq -r .state)"
  [ "$(api GET "/v1/devices/$DEV_ENC" | jq -r '.handoff.id // empty')" = "$hid" ] || die "Device.handoff is not $hid"
  pd handoff ls --state pending --json | jq -e --arg h "$hid" 'any(.[]; .id == $h)' >/dev/null || die "not in handoff ls"
  local r; r="$(PHONEDOCK_OWNER=e2e:human pd handoff resolve "$hid" done --note "e2e ok" --json)" || return 1
  [ "$(echo "$r" | jq -r .state)" = done ] || die "resolved state: $(echo "$r" | jq -r .state)"
  [ "$(api GET "/v1/devices/$DEV_ENC" | jq -c '.handoff')" = null ] || die "Device.handoff still set"
  local again; again="$(pd handoff resolve "$hid" done --json 2>&1)"
  [ "$(echo "$again" | jq -r .error.code)" = handoff_resolved ] || die "second resolve: $again"
  note "$hid pending → done by $(echo "$r" | jq -r .resolvedBy)"
}

s_snapshot_restore_running() {
  # Save while the screen sleeps, wake it, restore: the phone must end up running AND awake, and the list must not
  # show the emulator's own default_boot snapshot.
  local name="e2e-snap-$$"
  pd key "$DEV" home >/dev/null 2>&1
  pd shell "$DEV" -- input keyevent 223 >/dev/null || return 1      # screen off
  sleep 1
  pd snapshot save "$DEV" "$name" >/dev/null || die "snapshot save failed"
  pd shell "$DEV" -- input keyevent 224 >/dev/null
  pd snapshot restore "$DEV" "$name" >/dev/null || die "snapshot restore failed"
  local st; st="$(pd devices --backend android-emulator --json | jq -r --arg d "$DEV" '.[] | select(.id == $d) | .state')"
  [ "$st" = running ] || die "after restore the phone is '$st', want running"
  local pw; pw="$(pd shell "$DEV" -- dumpsys power)"
  case "$pw" in *mWakefulness=Awake*) ;; *) die "after restore the screen is not awake";; esac
  local list; list="$(pd snapshot ls "$DEV" --json)"
  echo "$list" | jq -e 'any(.[]; .name == "default_boot")' >/dev/null && die "default_boot is listed"
  echo "$list" | jq -e --arg n "$name" 'any(.[]; .name == $n)' >/dev/null || die "$name not listed"
  local a b
  a="$(echo "$list" | jq -c '[.[] | {name, sizeMB}]')"; b="$(pd snapshot ls "$DEV" --json | jq -c '[.[] | {name, sizeMB}]')"
  [ "$a" = "$b" ] || die "snapshot sizes changed between two listings: $a vs $b"
  pd snapshot rm "$DEV" "$name" >/dev/null || die "snapshot rm failed"
  note "restored: running, awake; default_boot hidden; sizes stable"
}
human_api() { curl -s -X "$1" -H "Authorization: Bearer $(token)" -H 'X-PhoneDock-Owner: app:human' -H 'Content-Type: application/json' ${2:+-d "$2"} "$BASE/v1/devices/$DEV_ENC/lease"; }
s_hand_back() {
  # Take Over pre-empts an agent; Hand Back gives the device back to it while its session is alive.
  local agent="e2e:agent-$$"
  PHONEDOCK_OWNER="$agent" pd lease "$DEV" >/dev/null || return 1
  human_api POST '{"force":true}' >/dev/null
  [ "$(api GET "/v1/devices/$DEV_ENC" | jq -r .lease.owner)" = app:human ] || die "Take Over did not give the person the lease"
  local r; r="$(human_api DELETE)"
  [ "$(echo "$r" | jq -r .returnedTo)" = "$agent" ] || die "Hand Back did not return to $agent: $r"
  [ "$(api GET "/v1/devices/$DEV_ENC" | jq -r .lease.owner)" = "$agent" ] || die "lease is not back with $agent"
  PHONEDOCK_OWNER="$agent" pd release "$DEV" >/dev/null
  note "handed back to $agent"
}
s_activity_words() {
  api POST "/v1/devices/$DEV_ENC/input" '{"action":"tap","x":900,"y":150}' >/dev/null
  local a; a="$(api GET "/v1/devices/$DEV_ENC/actions?limit=80")"
  echo "$a" | jq -e 'any(.[]; .action.action == "tap" and .where == "near the top right")' >/dev/null || die "tap has no coarse location"
  echo "$a" | jq -e 'any(.[]; .action.action == "snapshot.save")' >/dev/null || die "no snapshot.save event"
  echo "$a" | jq -e 'any(.[]; .action.action == "lease.hand_back" and (.action.returnedTo // "") != "")' >/dev/null || die "no hand-back event"
  note "tap near the top right; snapshot and hand-back events present"
}

# ── run ─────────────────────────────────────────────────────────────────────────
echo "PhoneDock Android e2e · device $DEV · port $PHONEDOCK_PORT · $(date '+%Y-%m-%d %H:%M:%S')"
T_START=$(now_ms)
step "build sample APK"                      s_build_apk
step "daemon start (from this tree)"         s_daemon_start
step "devices: $DEV running"                 s_devices
step "info (AVD check)"                      s_info
if [ ! -f "$TMP/device-ok" ]; then echo "device check failed – not sending any input"; exit 1; fi
step "screenshot (PNG)"                      s_screenshot
step "frame endpoint (JPEG, ETag/304)"       s_frame
step "UI tree"                               s_ui_tree
step "lease acquire / conflict / release"    s_lease
step "pre-clean sample app"                  s_preclean
step "install APK"                           s_install
step "apps list contains $PKG with its label" s_apps_has
step "launch"                                s_launch
step "UI tree shows \"PhoneDock Sample\""    s_ui_title
step "tap field, type Ada, Greet → Hello"    s_type_greet
step "toggle Switch → Notifications on"      s_switch
step "expect: verified / changed / unchanged" s_expect
step "heads-up over Settings: overlay, app swipe" s_headsup_scroll
step "key back / home"                       s_key_back_home
step "swipe"                                 s_swipe
step "rotate landscape and back"             s_rotate
step "logs contain the package"              s_logs
step "MCP stdio: list/screenshot/ui/tap"     s_mcp
step "recording start/stop (playable mp4)"   s_recording
step "tap Crash → crashes list shows it"     s_crash
step "open-url https://example.com"          s_open_url
step "terminate"                             s_terminate
step "uninstall"                             s_uninstall
step "error: install a missing file"         s_err_missing_file
step "error: unknown device → 404"           s_err_unknown_device
step "handoff request + resolve via CLI"     s_handoff
step "snapshot restore leaves the phone running" s_snapshot_restore_running
step "Take Over then Hand Back returns to the agent" s_hand_back
step "Activity: coarse tap location, lifecycle events" s_activity_words
T_END=$(now_ms)

echo
echo "Summary: $PASSED passed, $FAILED failed, $SKIPPED skipped in $(awk -v a="$T_START" -v b="$T_END" 'BEGIN{printf "%.1f", (b-a)/1000}')s"
[ "$FAILED" -eq 0 ]
