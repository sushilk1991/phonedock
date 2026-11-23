import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, openSync } from "node:fs";
import { resolve, join } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
const root = process.env.PHONEDOCK_PERF_DIR;
if (!root) throw new Error("Set PHONEDOCK_PERF_DIR to the isolated audit directory (see docs/PERFORMANCE-AUDIT.md)");
const label = process.argv[2] ?? "baseline";
const entry = process.argv[3] ?? join(root, "PhoneDock.app/Contents/Resources/daemon/phonedockd.mjs");
const cli = process.argv[4] ?? resolve("src/cli/main.ts");
const udid = JSON.parse(readFileSync(join(root, "device.json"))).udid;
const id = "ios-simulator:" + udid;
const env = { ...process.env, PHONEDOCK_HOME: join(root, "home"), PHONEDOCK_PORT: "47433", PHONEDOCK_DEVICE_FILTER: "pdtest-", DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = (a) => {
  a = [...a].sort((x, y) => x - y);
  return { n: a.length, p50: a[Math.ceil(a.length * 0.5) - 1], p95: a[Math.ceil(a.length * 0.95) - 1], min: a[0], max: a.at(-1) };
};
const timing = async (fn) => {
  const t = performance.now();
  const out2 = await fn();
  return [performance.now() - t, out2];
};
const out = { label, node: process.version, entry, cli, startedAt: (/* @__PURE__ */ new Date()).toISOString() };
const save = () => writeFileSync(join(root, label + "-daemon.json"), JSON.stringify(out, null, 2));
let daemon, mcp, token;
async function req(path, options = {}) {
  const r = await fetch("http://127.0.0.1:47433" + path, { ...options, headers: { Authorization: "Bearer " + token, ...options.headers } });
  if (!r.ok && r.status !== 304) throw new Error(r.status + " " + await r.text());
  return r;
}
function proc(pid) {
  try {
    const r = execFileSync("ps", ["-o", "time=,rss=", "-p", String(pid)], { encoding: "utf8" }).trim().split(/\s+/);
    const parts = r[0].split(":").map(Number);
    let sec = 0;
    for (const v of parts) sec = sec * 60 + v;
    return { seconds: sec, rssKiB: Number(r[1]) };
  } catch {
    return null;
  }
}
async function cpu(seconds) {
  const a = proc(daemon.pid), t = performance.now();
  await delay(seconds * 1e3);
  const b = proc(daemon.pid);
  return { durationMs: performance.now() - t, cpuPercent: (b.seconds - a.seconds) / (performance.now() - t) * 1e5, rssStartKiB: a.rssKiB, rssEndKiB: b.rssKiB };
}
try {
  try {
    await fetch("http://127.0.0.1:47433/v1/health", { signal: AbortSignal.timeout(300) });
    throw new Error("Port 47433 occupied; refusing to replace its daemon");
  } catch (e) {
    if (e.message.startsWith("Port ")) throw e;
  }
  const t = performance.now();
  const log = openSync(join(root, label + "-daemon.log"), "a");
  daemon = spawn(process.execPath, [entry], { env, stdio: ["ignore", log, log] });
  for (let i = 0; i < 400; i++) {
    try {
      const r = await fetch("http://127.0.0.1:47433/v1/health", { signal: AbortSignal.timeout(200) });
      if (r.ok) {
        out.coldStartMs = performance.now() - t;
        break;
      }
    } catch {
    }
    await delay(25);
  }
  if (!out.coldStartMs) throw new Error("No health response");
  token = JSON.parse(readFileSync(join(root, "home/daemon-47433.json"))).token;
  writeFileSync(join(root, "active-daemon-pid"), String(daemon.pid));
  out.daemonPid = daemon.pid;
  save();
  console.log("health", out.coldStartMs);
  let devices;
  for (let i = 0; i < 200; i++) {
    devices = await (await req("/v1/devices")).json();
    if (devices.some((d) => d.id === id)) break;
    await delay(100);
  }
  out.devices = devices;
  save();
  const ds = [];
  for (let i = 0; i < 50; i++) {
    const [ms] = await timing(async () => await (await req("/v1/devices")).arrayBuffer());
    ds.push(ms);
    await delay(75);
  }
  out.devicesMs = stats(ds);
  const fresh = [];
  for (let i = 0; i < 50; i++) {
    const [ms] = await timing(async () => await (await req("/v1/devices?backend=ios-simulator&fresh=true")).arrayBuffer());
    fresh.push(ms);
  }
  out.freshDevicesMs = stats(fresh);
  save();
  console.log("devices", out.devicesMs, out.freshDevicesMs);
  out.idle = await cpu(20);
  save();
  const cliMs = [];
  for (let i = 0; i < 20; i++) {
    const [ms] = await timing(() => new Promise((resolve2, reject) => {
      const p = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", cli, "devices", "--json"], { env, stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      p.stderr.on("data", (b) => err += b);
      p.on("exit", (code) => code === 0 ? resolve2() : reject(new Error(err)));
    }));
    cliMs.push(ms);
  }
  out.cliDevicesMs = stats(cliMs);
  save();
  console.log("cli", out.cliDevicesMs);
  const shots = [];
  for (let i = 0; i < 10; i++) {
    const [ms, r] = await timing(async () => await (await req("/v1/devices/" + encodeURIComponent(id) + "/screenshot")).arrayBuffer());
    shots.push(ms);
    if (i === 0) writeFileSync(join(root, label + "-screenshot.png"), Buffer.from(r));
  }
  out.screenshotMs = stats(shots);
  save();
  mcp = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", cli, "mcp", "--profile", "runtime"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let next = 0;
  const pending = /* @__PURE__ */ new Map();
  let mcpErr = "";
  mcp.stderr.on("data", (b) => mcpErr += b);
  createInterface({ input: mcp.stdout }).on("line", (l) => {
    let m;
    try {
      m = JSON.parse(l);
    } catch {
      return;
    }
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  });
  mcp.on("exit", () => {
    for (const p of pending.values()) p.reject(new Error("MCP exited: " + mcpErr));
  });
  async function rpc(method, params) {
    const mid = ++next;
    return new Promise((resolve2, reject) => {
      pending.set(mid, { resolve: resolve2, reject });
      mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
    });
  }
  const [init] = await timing(() => rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "pdtest-perf", version: "1" } }));
  out.mcpInitializeMs = init;
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const lists = [];
  for (let i = 0; i < 20; i++) {
    const [ms, r] = await timing(() => rpc("tools/call", { name: "list_devices", arguments: {} }));
    if (r.isError) throw new Error(JSON.stringify(r));
    lists.push(ms);
  }
  out.mcpListMs = stats(lists);
  save();
  const mshots = [];
  for (let i = 0; i < 10; i++) {
    const [ms, r] = await timing(() => rpc("tools/call", { name: "screenshot", arguments: { device: id } }));
    if (r.isError) throw new Error(JSON.stringify(r));
    mshots.push(ms);
  }
  out.mcpScreenshotMs = stats(mshots);
  mcp.stdin.end();
  mcp.kill("SIGTERM");
  save();
  console.log("mcp", out.mcpListMs, out.mcpScreenshotMs);
  const frames = [];
  let etag;
  let t0 = performance.now();
  let n304 = 0;
  const cpu0 = proc(daemon.pid);
  let bytes = 0;
  while (performance.now() - t0 < 3e4) {
    const [ms, r] = await timing(async () => {
      const r2 = await req("/v1/devices/" + encodeURIComponent(id) + "/frame?maxSize=900", { headers: etag ? { "If-None-Match": etag } : {} });
      bytes += (await r2.arrayBuffer()).byteLength;
      return r2;
    });
    etag = r.headers.get("etag");
    if (r.status === 304) n304++;
    frames.push({ ms, status: r.status, ageMs: Number(r.headers.get("x-frame-age-ms")), source: r.headers.get("x-frame-source") });
    await delay(Math.max(0, 75 - ms));
  }
  const cpu1 = proc(daemon.pid);
  out.frames = { durationMs: performance.now() - t0, requests: frames.length, n304, bytes, fps: frames.length / (performance.now() - t0) * 1e3, requestMs: stats(frames.map((x) => x.ms)), ageMs: stats(frames.filter((x) => x.status === 200).map((x) => x.ageMs)), cpuPercent: (cpu1.seconds - cpu0.seconds) / (performance.now() - t0) * 1e5, rssKiB: cpu1.rssKiB, raw: frames };
  save();
  console.log("frames", JSON.stringify({ ...out.frames, raw: void 0 }));
  out.debug = await (await req("/v1/backends?debug=1")).json();
  save();
  console.log("READY_FOR_APP");
  await new Promise((resolve2) => {
    process.on("SIGTERM", resolve2);
    process.on("SIGINT", resolve2);
  });
} catch (e) {
  out.error = String(e.stack ?? e);
  save();
  console.error(e);
  process.exitCode = 1;
} finally {
  mcp?.kill("SIGTERM");
  if (daemon) {
    daemon.kill("SIGTERM");
    await Promise.race([new Promise((r) => daemon.once("exit", r)), delay(4e3)]);
    if (daemon.exitCode === null) daemon.kill("SIGKILL");
  }
}
