# PhoneDock from the shell (no MCP)

Use this when your client has no PhoneDock MCP tools. Everything the MCP tools do, the `phonedock` CLI does too.
If `phonedock` isn't on PATH, use the full path: `/Applications/PhoneDock.app/Contents/Resources/bin/phonedock`.
`phonedock help` lists every command.

## Rules that differ from MCP

- **Add `--json` to every command** you read the output of. Errors then come back on stdout as
  `{"error":{"code":"no_match","message":"…","hints":[…]}}`, with exit code 1. Usage mistakes exit 2.
- **Coordinates are device pixels** (a full-size screenshot's pixels), not MCP's 1024-px space. `phonedock ui`,
  `find` and `screenshot` report device pixels, so numbers you read from them work as they are.
- **Pick one owner name and use it on every call**: `export PHONEDOCK_OWNER=agent:<you>` (or `--owner agent:<you>`).
  The default owner is `cli:<username>`, the same as the person's own terminal. A lease belongs to its owner: input
  from any other owner is refused with `lease_conflict` while you hold the device.
- `<id>` is a device id, its native id (simulator UDID, AVD name, adb serial) or a unique name/prefix.

## The loop

```sh
export PHONEDOCK_OWNER=agent:me
phonedock devices --json                                   # what exists, state, who holds it
phonedock acquire --platform ios --json                    # lease a free PhoneDock device (or: lease <id> --ttl 600)
phonedock create --backend ios-simulator --name pd-test --profile "iPhone 17 Pro" --boot --json   # if there's none
phonedock ui pd-test                                       # outline: e12 Button "Sign in" @(810,1815) …
phonedock tap pd-test --text "Sign in" --json              # find + tap (--type Button, --match exact, --index N)
phonedock tap pd-test @e12                                 # a ref from the last `ui`
phonedock fill pd-test "kim@example.com" --text Email --json   # tap, clear, type, verify (--submit, --secret)
phonedock wait-for pd-test visible --text Welcome --timeout 10000 --json   # visible | gone | idle
phonedock scroll-to pd-test "About" --json                 # exit 1 if it isn't there
phonedock screenshot pd-test -o /tmp/shot.png --json       # full size; --max-size 1024 for a smaller look
phonedock release pd-test
```

**Check an input worked in the same call** with `--expect`: `phonedock tap $D --text "Sign in" --expect Welcome`
(also `--expect gone:Loading`, `id:<id>`, `changed`; `--expect-timeout MS`, default 5000). It prints
`Verified: …` or `Not verified: …` and exits 1 when not verified; with `--json` the result has
`expect: { ok, outcome: "verified" | "screen_unchanged" | "changed_not_found", message }`. Every input result has
`delivery` and `retrySafe`; an error with `"retrySafe": true` reached nothing and can be sent again, one with
`"delivery": "unknown"` may have landed: read the screen first.

`phonedock profiles ios-simulator` and `phonedock profiles android-emulator` list models (Android: `--profile pixel_9`);
`phonedock images` lists installed OS images (pass one with `--image <id>` if `create` reports `no_image`);
`phonedock backends` says what works on this Mac. `find <id> <text>` and `scroll-to` exit 1 when nothing matches.

## Save turns: chain steps in one shell call

Each tool call is a round trip; one shell call can run a whole known sequence. Stop at the first failure with `&&`
(or `set -e`) and end with a read of the screen:

```sh
export PHONEDOCK_OWNER=agent:me D=pd-test
phonedock fill $D "test@example.com" --text Email --json >/dev/null \
  && phonedock tap $D --text "Continue" --json >/dev/null \
  && phonedock wait-for $D visible --text "Welcome" --timeout 15000 --json >/dev/null \
  && phonedock ui $D
```

Raw input in one call (device pixels): `phonedock input <id> '[{"action":"tap","x":540,"y":1200},{"action":"type","text":"hello"},{"action":"key","key":"enter"}]'`.

## Other commands you'll use

| Need | Command |
|---|---|
| Boot / shut down / delete | `boot <id>` · `shutdown <id>` · `rm <id>` (refuses devices PhoneDock didn't create unless `--force`) |
| Apps | `apps <id>` · `install <id> <path.app\|.apk>` · `launch <id> <appId>` · `terminate <id> <appId>` · `open-url <id> <url>` |
| Navigation | `back <id>` · `gesture <id> go_home` · `key <id> enter` · `hide-keyboard <id>` · `swipe <id> x1 y1 x2 y2` |
| System prompts | `alert <id>` (shows it; exit 1 when none is up) · `alert <id> accept` · `alert <id> dismiss` · `alert <id> button "Allow Once"` |
| Look and feel | `appearance <id> dark` · `rotate <id> landscape` · `location <id> <lat> <lon>` |
| Debugging | `logs <id> -n 200 --filter MyApp` · `crashes <id> --since 15m` · `crashes <id> <crashId>` · `foreground <id>` |
| Evidence | `screenshot <id> -o file.png` · `record <id> start --max 120` … `record <id> stop` |
| Performance | `trace start <id> --app <appId> [--template T] [--time-limit 60] [--launch]` … `trace stop <id>` (summary, compared with the last run) · `trace run <id> --app <appId> --flow f.yaml` · `trace ls <id>` |
| Reset | `snapshot save <id> clean` · `snapshot restore <id> clean` · `appdata <id> save <appId> logged-in` |
| App notes | `app-notes show <appId>` · `app-notes save <appId> --file notes.md` (or pipe it in) · `app-notes list` · `app-notes rm <appId>` · `app-notes path [appId]` |
| Inside the device | `shell <id> -- <command…>` (runs on the device, not the Mac) |

**App notes** are what earlier agents learned about an app (see "Learn an app once" in SKILL.md). `launch` prints
`PhoneDock has notes for <appId>: phonedock app-notes show <appId>` when there are some: read them first. `show`
prints the Markdown as saved; `save` replaces it with the whole updated text.

## When a person must act

```sh
phonedock handoff request pd-test "Approve the Face ID prompt, then press Done" --wait --json
```

It blocks until the person presses Done (exit 0) or Can't Do It, or it times out (exit 1); the JSON says which
and carries their note. Keep your lease while you wait, then read the screen again (`phonedock ui`). Never type
credentials you weren't given.

## Leases

- `phonedock acquire [--platform ios|android] [--backend B] [--ttl S]` picks a free PhoneDock device and leases it.
- `phonedock lease <id> --ttl 600` leases a device you name; every call you make renews it.
- `phonedock release <id>` when you're done. `phonedock devices` shows the holder of each device.
- Don't use `lease --force` to take a device from another owner unless the user tells you to.
