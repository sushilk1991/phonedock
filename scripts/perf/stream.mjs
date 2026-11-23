import { get } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const root = process.env.PHONEDOCK_PERF_DIR, label = process.argv[2];
if (!root || !label) throw new Error("Set PHONEDOCK_PERF_DIR and pass a result label (see docs/PERFORMANCE-AUDIT.md)");
const token = JSON.parse(readFileSync(join(root, "home/daemon-47433.json"))).token;
const id = "ios-simulator:" + JSON.parse(readFileSync(join(root, "device.json"))).udid;
const pid = Number(readFileSync(join(root, "active-daemon-pid"), "utf8"));
const proc = () => {
  const [cpu, rss] = execFileSync("ps", ["-p", String(pid), "-o", "time=,rss="], { encoding: "utf8" }).trim().split(/\s+/);
  let sec = 0;
  for (const n of cpu.split(":")) sec = sec * 60 + Number(n);
  return { sec, rssKiB: Number(rss) };
};
const t = performance.now(), before = proc(), stamps = [], hashes = /* @__PURE__ */ new Set();
let bytes = 0, buf = Buffer.alloc(0);
await new Promise((resolve, reject) => {
  const req = get("http://127.0.0.1:47433/v1/devices/" + encodeURIComponent(id) + "/stream?maxSize=900&fps=15", { headers: { Authorization: "Bearer " + token } }, (res) => {
    if (res.statusCode !== 200) {
      res.resume();
      reject(new Error("HTTP " + res.statusCode));
      return;
    }
    res.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (; ; ) {
        const h = buf.indexOf("\r\n\r\n");
        if (h < 0) break;
        const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, h).toString())?.[1]);
        if (!len) {
          reject(new Error("Invalid multipart length"));
          req.destroy();
          break;
        }
        if (buf.length < h + 4 + len + 2) break;
        const jpeg = buf.subarray(h + 4, h + 4 + len);
        stamps.push(performance.now() - t);
        bytes += len;
        hashes.add(createHash("sha256").update(jpeg).digest("hex"));
        buf = buf.subarray(h + 4 + len + 2);
      }
    });
    res.on("error", (e) => {
      if (e.code !== "ECONNRESET") reject(e);
    });
  });
  req.on("error", reject);
  setTimeout(() => {
    req.destroy();
    resolve();
  }, 3e4);
});
const after = proc(), elapsed = performance.now() - t, intervals = stamps.slice(1).map((v, i) => v - stamps[i]).sort((a, b) => a - b);
const out = { label, durationMs: elapsed, frames: stamps.length, uniqueImages: hashes.size, bytes, firstFrameMs: stamps[0], arrivalFps: (stamps.length - 1) / (stamps.at(-1) - stamps[0]) * 1e3, interArrivalMs: { p50: intervals[Math.ceil(intervals.length * 0.5) - 1], p95: intervals[Math.ceil(intervals.length * 0.95) - 1] }, daemonCpuPercent: (after.sec - before.sec) / elapsed * 1e5, rssKiB: after.rssKiB, stamps };
writeFileSync(join(root, label + "-stream.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ...out, stamps: void 0 }, null, 2));
