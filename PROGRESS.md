# PhoneDock performance audit

Scope: branch `perf-audit`, base `bf19b9e` (0.4.0). No edits to README.md, site/, docs/media/, skills/ or docs/VIRTUAL-PHONES.md. Android/physical iPhone are unmeasured source analysis only. No Mac mini or full local npm test.

Done:
- Measured private source daemon, CLI/MCP, multipart/frame transport and two 300 s background release-app runs. Same Node 24.11.0, test simulator and harness settings; shared-host noise is explicit.
- Source launcher: 25 alternating pairs, devices p50 105.77 -> 52.98 ms, p95 122.75 -> 57.38 ms. Commit `2222bbc`.
- Discovery completion: 2 -> 1 provider reads; explicit rename and delayed SSE publication preserved. Commit `9abad75`.
- App live CPU 2.07% -> 2.37%, idle 0.94% -> 1.56%; no app CPU/memory improvement claimed. Explicit refresh batch outer root/stage/inspector bodies 2 before and after, across 11/10 device-list applications. Main-thread samples mostly event-loop wait.
- Rejected ffmpeg thread tuning; identical JPEG hashes, saving only a few ms. Retained opt-in audit counters, portable scripts, report and JSON evidence under docs/performance/2026-11-23.
- npm ci once locally; 18 focused Node tests on Instabox/Node 24.22.3 and final tsc passed. Release app/bundles built; actual bundled-daemon health/list/screenshot and bundled MCP list passed. Independent Muse review found no blockers; its test/measurement gaps were addressed or bounded explicitly.
- Cleanup verified: private 47433 free; owned simulator `42067FBB-E3CA-4F18-97A8-3E46F31B03F4` deleted (available inventory back to 37); temporary bundle, baseline binary, scratch home/task caches removed. Both per-run restores and final preferences match the original backup exactly. Default daemon/existing devices untouched.

Evidence retained locally: `/var/folders/r2/hxzthddn0vnd14jsz35qwcc40000gn/T/pdtest-perf-hsdtlqwg`. No runnable bundle/home remains there. Reusable fe-hero checkout/dependency cache retained; no disposable box created.

Delivery: branch pushed; PR https://github.com/sushilk1991/phonedock/pull/2 is open against main. Full-suite status is tracked in the PR checks. Remaining operational step: read CI/review status and remove finished task-owned Herdr terminals. Do not merge.
