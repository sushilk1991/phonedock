# Reliability and observation audit

Implementation and local verification: 2026-11-09, branch `fix/reliability-and-observation`.
This records the changes made after checking the supplied external audit against the source.
No release, commit, push, or restart of the main PhoneDock daemon was performed.

## Changes

| Area | Result |
|---|---|
| Input delivery | Request-local delivery accounting replaces cross-request inference. Device input is serialized, ownership is checked again at transport send boundaries, and takeover fences the remaining steps of a batch. |
| Multiple daemons | SQLite transactions coordinate claims between upgraded daemons sharing one PhoneDock home, including identical owner strings. Acquisition tokens prevent stale releases from clearing newer ownership. |
| Response loss | SDKs retain an input request ID, refuse to replay uncertain delivery, and expose receipt lookup. Read-only access remains available after a foreign takeover. The daemon reserves a receipt before execution; duplicates recover its result rather than sending again. Clipboard PUT/POST uses these protections too. |
| Human handoff | Done and timeout can complete while temporary human input is still running. The human's active claim remains intact; the requester's eligible lease returns when that input releases it. |
| UI observations | Concurrent equivalent reads share backend work. Action generations prevent a dump started before input from becoming trusted merely because it finished afterward. Snapshot IDs bind refs to their original observation. MCP propagates snapshots from both `get_ui` and visible `wait_for` results. |
| Discovery | Providers refresh independently, with bounded waits and visible status. Canonical IDs target their own provider. Name/native-ID/prefix resolution waits for initial discovery instead of inferring absence or uniqueness from a partial list. |
| iPhone plumbing | Both sidecars share Python discovery, including uv/pipx trampolines. Discovery requires Python 3.11+. Native Unicode paste uses the sidecar without plaintext temporary files, verifies insertion, and conditionally restores a secret clipboard transaction without overwriting an intervening copy. |
| Native iPhone functions | Added appearance, HID pinch, bounded app-filtered logs, and exact AX-PID/process/app foreground resolution. Unknown foreground identity raises `foreground_unknown`; only confirmed SpringBoard means no foreground app. These additions need physical-device validation. |
| Capabilities | Corrected WDA double-tap/stream and OCR capability metadata, and stale experimental metadata for the stable native iPhone path. |
| Visual assertions | CLI, MCP and the runner use full-resolution color comparison. Missing baselines fail by default; recording and updating are explicit. Approved-root checks reject traversal and symlink escapes; atomic replacement avoids overwriting another hard link. |
| Evidence | Flows and suites produce self-contained, script-free HTML reports. Optional per-action screenshots and tap markers add evidence when requested. Text redaction runs before JSON serialization, including secrets containing quotes, backslashes and newlines. Screenshot pixels remain unchanged. |
| Diagnostics | Added host/device doctor, simulator/emulator environment controls, heuristic UI audit, and read-only debug-enabled Android WebView DOM/network diagnostics. CLI, SDK and typed MCP entry points are documented in the API guide. |
| Agent overhead | Added a typed runtime MCP profile (`--profile runtime`, also `--compact`) and visible/interactive UI filters plus ref-sensitive outline diffs. This is a subset of tools, not a generic untyped command dispatcher. |
| Measurement | Metrics now distinguish input queue and execution time. Receipt pruning avoids repeated directory scans/stat calls; claims reuse prepared statements. |

The public additions include optional UI snapshot/provenance fields, request IDs and receipts, input `snapshotId`
and `returnUi`, new diagnostic/environment routes and SDK methods, and explicit flow comparison/report options.
Existing coordinate units remain full-resolution screenshot pixels. No public fields were renamed or removed.
The intentional stricter behavior is that a missing visual baseline fails instead of silently creating a passing baseline.

## Verification

| Check | Local result |
|---|---|
| TypeScript | `npx tsc --noEmit -p .` passed. |
| Node 26 unit/integration suite | 407 passed, zero failures or skips. |
| Node 24.22.2 suite | 407 passed, zero failures or skips. |
| Python SDK transport suite | 12 passed, using disposable HTTP servers. |
| Fresh Python 3.12 environment | Installed `pymobiledevice3==11.49.2`; all three native sidecar protocol tests and both transport-fence tests passed, without contacting a phone. |
| Python syntax | All tools parsed with Python 3.12. |
| Bundles | Daemon and CLI bundles built; the Node 24 bundled daemon was exercised separately from the source daemon. |
| macOS app | `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift build --package-path app -c debug` passed. |
| Independent review | Nine local review lenses plus a separate Grok-family adversarial pass. An independent validator checked eight retained cases after fixes; none remained actionable. Claude returned no review because of its provider usage limit. Exact served peer model/effort was not attested. |
| Whitespace | `git diff --check HEAD` passed. |

Regression coverage includes mid-flight disconnects, truncated/error responses, timeouts, refusal before send,
stable IDs across allowed auth/start retries, duplicate requests across real Node processes, receipt retention
and capacity, receipt recovery after takeover, clipboard ordering, delayed sidecar startup, stale UI generations,
handoff completion races, escaped secret artifacts, baseline confinement, image dimensions/colors/masks, report
escaping, bounded inventory refreshes, and CDP forwarding/socket cleanup.

### Disposable device checks

Only newly created `pdtest-` devices were used. Private daemons ran on 47591/47592 with an isolated home;
the main daemon on 47420 and existing phones, simulators, AVDs and LAN devices were not controlled.

- Android 16/API 36 emulator: installed and launched the sample app; verified fill and tap expectations; returned
  post-action UI; imported media; granted a permission; set/cleared status-bar overrides; captured screenshots;
  ran the UI audit; recorded and compared a visual baseline and generated HTML evidence.
- iPhone 17 Pro/iOS 27.0 simulator: installed/launched the sample app, verified text entry and greeting,
  exercised permissions/status bar/media/UI audit, and passed visual comparison after waiting for screen idle
  (0.0% changed). An initial assertion during the Home transition correctly failed.
- iPhone Duo/iOS 27.2 simulator: exposed a new multi-display bug. Screenshot and recording now select the primary
  display consistent with the AX tree (1398×2034 pixels at 3×). AXe acknowledged touch input without changing this
  display; PhoneDock now rejects that input with `501 not_supported`, `delivery: not_sent`, and removes those
  per-device input capabilities. This is an explicit compatibility limit, not full Duo interaction support.
- Two live daemons on Node 26 and Node 24: verified same-owner claim conflicts, human takeover rejecting old input
  before send, and receipt recovery after takeover. Unit tests also exercise independent SQLite connections/processes.
- Three simultaneous Android UI requests produced one backend UI read in 680 ms. This confirms work sharing on
  this run; it does not establish a general latency percentage or replace paired benchmarks.

Test devices and private daemons were cleaned up after verification. Local test logs and sample-app evidence
were kept under `/tmp/pdtest-audit-7y6pOo`; these are disposable artifacts, not repository fixtures.

## Limits and follow-up work

- Shared claims protect upgraded daemons using the same home and canonical device identity. Older daemons,
  different homes and unrelated tools do not participate. Handoffs remain daemon-local and do not survive restart.
- Completed/dead receipt retention is bounded to 24 hours and 1,024 files. Live running receipts stay protected
  past the age limit, including after a failed completion write; the store fails closed rather than replaying input.
- Physical iPhone appearance, new pinch, foreground/log and Unicode-paste paths have fake/helper coverage only in
  this change. Existing user phones were deliberately excluded from tests. Cable-free pairing, automatic DDI
  mounting and sidecar consolidation remain follow-ups pending a dedicated hardware test session.
- Environment controls are for supported simulators/emulators. Biometric notifications are experimental;
  physical biometric prompts still need a person. Media import does not inject a virtual camera feed.
- UI audit results are heuristics from reported frames, not accessibility certification or proof of actual hit areas.
  Android WebView inspection requires debugging enabled by the app. Its refs are separate from native refs;
  uncalibrated CSS bounds must not be used as device coordinates. There is no iOS DOM bridge or universal native
  HTTP interception in this change.
- HTML escaping, redaction, embedding and evidence tests passed. Browser visual QA could not run because the
  browser-control host was unavailable. Screenshot pixels may contain visible private data even when text is redacted.
- GitHub Actions is configured for Node 24/26 and mandatory sidecar tests but has not been executed on GitHub.
  No paired end-to-end benchmark or hardware compatibility matrix was completed.

The external audit's unquoted `#` example follows normal YAML comment syntax. Quote selectors such as
`tap: "Issue #12"`; changing the parser to treat comments as selector text would break valid flows.
Its measured-latency and competitor comparisons should not be treated as benchmarks of this implementation.

Next useful work is a paired cold/warm latency benchmark (including a full receipt store), physical-iPhone
qualification, and a debug-WebView sample app test. Multi-device flows, automatic crash-on-action attachment,
iOS WebView support and build/debug integrations are separate product work rather than completed features here.
