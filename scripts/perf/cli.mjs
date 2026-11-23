import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const root = process.env.PHONEDOCK_PERF_DIR;
if (!root || !process.argv[2] || !process.argv[3]) throw new Error("Set PHONEDOCK_PERF_DIR; pass before and after launchers");
const env = { ...process.env, PHONEDOCK_HOME: join(root, "home"), PHONEDOCK_PORT: "47433", PHONEDOCK_DEVICE_FILTER: "pdtest-", PHONEDOCK_NODE: process.execPath, NODE_COMPILE_CACHE: join(root, "compile-cache") };
const results = [];
delete env.NODE_COMPILE_CACHE;
delete env.NODE_DISABLE_COMPILE_CACHE;
for (let i = 0; i < 26; i++) for (const after of i % 2 ? [true, false] : [false, true]) {
  const start = performance.now();
  const entry = process.argv[after ? 3 : 2];
  await new Promise((res, rej) => {
    const c = spawn(resolve(entry), ["devices", "--json"], { env: after ? { ...env, NODE_COMPILE_CACHE: join(root, "launcher-only-cache") } : env, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    c.stderr.on("data", (b) => err += b);
    c.on("exit", (code) => code === 0 ? res() : rej(new Error(err)));
  });
  results.push({ i, after, ms: performance.now() - start });
}
writeFileSync(join(root, "cli-source-launcher-paired.json"), JSON.stringify(results, null, 2));
for (const after of [false, true]) {
  const a = results.filter((x) => x.i > 0 && x.after === after).map((x) => x.ms).sort((a2, b) => a2 - b);
  console.log({ after, n: a.length, p50: a[Math.ceil(a.length * 0.5) - 1], p95: a[Math.ceil(a.length * 0.95) - 1] });
}
