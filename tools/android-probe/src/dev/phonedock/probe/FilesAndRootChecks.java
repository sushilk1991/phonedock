package dev.phonedock.probe;

import android.content.pm.PackageManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Checks for the 'files' and 'root' groups.
 */
final class FilesAndRootChecks {

    private static final String[] EMULATOR_PATHS = {
            "/dev/qemu_pipe",
            "/dev/goldfish_pipe",
            "/dev/socket/qemud",
            "/dev/qemu_trace",
            "/sys/qemu_trace",
            "/system/bin/qemu-props",
            "/vendor/bin/qemu-props",
            "/system/lib/libc_malloc_debug_qemu.so",
            "/system/lib64/libc_malloc_debug_qemu.so",
            "/dev/socket/genyd",
            "/dev/socket/baseband_genyd",
            "/fstab.ranchu",
            "/vendor/etc/fstab.ranchu",
            "/init.ranchu.rc",
            "/vendor/etc/init/hw/init.ranchu.rc",
            "/ueventd.ranchu.rc",
            "/vendor/ueventd.rc",
            "/system/bin/androVM-prop",
            "/system/bin/microvirt-prop",
            "/dev/vboxguest",
            "/system/lib/libhoudini.so",
            "/vendor/lib64/hw/gralloc.ranchu.so",
            "/vendor/lib64/libGLESv2_emulation.so",
            "/vendor/lib64/egl/libGLESv2_emulation.so",
            "/vendor/lib64/libgoldfish-ril.so",
            "/dev/virtio-ports",
            "/sys/class/virtio-ports",
            "/sys/bus/virtio/devices",
            "/sys/module/virtio_blk",
            "/sys/module/goldfish_pipe",
            "/sys/devices/virtual/misc/goldfish_pipe",
            "/sys/devices/virtual/misc/goldfish_address_space"
    };

    private static final String[] SU_DIRS = {
            "/system/bin",
            "/system/xbin",
            "/sbin",
            "/vendor/bin",
            "/su/bin",
            "/data/local/bin",
            "/data/local/xbin",
            "/debug_ramdisk",
            "/system/sd/xbin"
    };

    private static final String[] ROOT_ARTIFACTS = {
            "/data/adb",
            "/data/adb/magisk",
            "/data/adb/modules",
            "/sbin/.magisk",
            "/debug_ramdisk/.magisk",
            "/cache/.disable_magisk",
            "/system/app/Superuser.apk"
    };

    private static final String[] ROOT_PACKAGES = {
            "com.topjohnwu.magisk",
            "io.github.huskydg.magisk",
            "com.noshufou.android.su",
            "eu.chainfire.supersu",
            "me.weishu.kernelsu",
            "me.bmax.apatch",
            "org.lsposed.manager",
            "de.robv.android.xposed.installer",
            "com.saurik.substrate",
            "io.github.vvb2060.magisk",
            "com.fox2code.mmm"
    };

    private static final Pattern MAPS_PATTERN = Pattern.compile(
            "magisk|zygisk|lsposed|riru|frida|xposed|substrate|/data/adb|memfd:jit-zygisk",
            Pattern.CASE_INSENSITIVE
    );

    private static final Pattern CPUINFO_HARDWARE = Pattern.compile("(?m)^Hardware\\s*:");
    private static final Pattern CPUINFO_APPLE_IMPL = Pattern.compile(
            "(?mi)^CPU implementer\\s*:\\s*0x61\\b"
    );
    private static final Pattern ROOT_MOUNT_KEYWORDS = Pattern.compile(
            "magisk|/data/adb|KSU|APatch",
            Pattern.CASE_INSENSITIVE
    );

    private FilesAndRootChecks() {}

    static void runAll(ProbeContext ctx) {
        runFilesChecks(ctx);
        runRootChecks(ctx);
    }

    private static void runFilesChecks(ProbeContext ctx) {
        for (final String path : EMULATOR_PATHS) {
            String id = pathToId("files.path.", path);
            ctx.check(id, "files", () -> {
                File f = new File(path);
                boolean exists = f.exists();
                boolean canRead = f.canRead();
                boolean isDir = f.isDirectory();
                JSONObject obj = new JSONObject();
                obj.put("path", path);
                obj.put("exists", exists);
                obj.put("canRead", canRead);
                obj.put("isDir", isDir);
                return ProbeContext.Outcome.of(obj, exists, exists ? "path exists: " + path : null);
            });
        }

        // /proc/cpuinfo
        ctx.check("files.proc.cpuinfo", "files", () -> {
            String full = ProbeContext.readFileUpToBytes(new File("/proc/cpuinfo"), 256 * 1024);
            List<String> reasons = new ArrayList<>();
            String sw = ProbeContext.findSuspiciousWord(full);
            if (sw != null) {
                reasons.add("contains '" + sw + "'");
            }
            if (!CPUINFO_HARDWARE.matcher(full).find()) {
                reasons.add("no Hardware line");
            }
            if (CPUINFO_APPLE_IMPL.matcher(full).find()) {
                reasons.add("CPU implementer 0x61 (Apple host CPU)");
            }
            return ProbeContext.Outcome.of(
                    ProbeContext.truncate(full, ProbeContext.MAX_TEXT_CHARS),
                    !reasons.isEmpty(),
                    ProbeContext.joinReasons(reasons)
            );
        });

        checkTextFile(ctx, "files.proc.version", "/proc/version");

        // /proc/meminfo (first 5 lines)
        ctx.check("files.proc.meminfo", "files", () -> {
            List<String> lines = ProbeContext.readLines(new File("/proc/meminfo"), 5);
            String joined = joinLines(lines);
            String sw = ProbeContext.findSuspiciousWord(joined);
            return ProbeContext.Outcome.of(joined, sw != null, sw != null ? "contains '" + sw + "'" : null);
        });

        checkTextFile(ctx, "files.proc.self.mounts", "/proc/self/mounts");
        checkTextFile(ctx, "files.proc.self.mountinfo", "/proc/self/mountinfo");

        // /proc/self/maps (filtered)
        ctx.check("files.proc.self.maps", "files", () -> {
            List<String> lines = ProbeContext.readLines(new File("/proc/self/maps"), 0);
            JSONArray matches = new JSONArray();
            for (String line : lines) {
                if (MAPS_PATTERN.matcher(line).find()) {
                    matches.put(line);
                }
            }
            return ProbeContext.Outcome.of(
                    matches,
                    matches.length() > 0,
                    matches.length() > 0 ? matches.length() + " suspicious /proc/self/maps entries" : null
            );
        });

        // /proc/self/status (TracerPid line)
        ctx.check("files.proc.self.status.tracerpid", "files", () -> {
            List<String> lines = ProbeContext.readLines(new File("/proc/self/status"), 0);
            String tracerLine = null;
            for (String line : lines) {
                if (line.startsWith("TracerPid:")) {
                    tracerLine = line.trim();
                    break;
                }
            }
            boolean traced = false;
            if (tracerLine != null) {
                String[] parts = tracerLine.split(":");
                if (parts.length == 2) {
                    try {
                        traced = Integer.parseInt(parts[1].trim()) != 0;
                    } catch (NumberFormatException ignored) {
                        // Leave false.
                    }
                }
            }
            return ProbeContext.Outcome.of(tracerLine, traced, traced ? "non-zero TracerPid (" + tracerLine + ")" : null);
        });

        checkTextFile(ctx, "files.proc.tty.drivers", "/proc/tty/drivers");
        checkTextFile(ctx, "files.proc.partitions", "/proc/partitions");
        checkTextFile(ctx, "files.proc.cmdline", "/proc/cmdline");
        checkTextFile(ctx, "files.proc.bus.input.devices", "/proc/bus/input/devices");
        checkTextFile(ctx, "files.proc.net.route", "/proc/net/route");

        checkDirNames(ctx, "files.sys.class.thermal", "/sys/class/thermal", false);
        checkDirNames(ctx, "files.sys.class.power_supply", "/sys/class/power_supply", false);
        checkDirNames(ctx, "files.sys.block", "/sys/block", true);

        checkTextFile(ctx, "files.sys.cpu.possible", "/sys/devices/system/cpu/possible");

        // cpufreq directory check + cpuinfo_max_freq
        ctx.check("files.sys.cpu.cpufreq_dir", "files", () -> {
            File dir = new File("/sys/devices/system/cpu/cpu0/cpufreq");
            boolean exists = dir.exists() && dir.isDirectory();
            return ProbeContext.Outcome.of(exists, !exists, !exists ? "cpufreq directory missing" : null);
        });

        ctx.check("files.sys.cpu.cpufreq_max", "files", () -> {
            File dir = new File("/sys/devices/system/cpu/cpu0/cpufreq");
            File f = new File(dir, "cpuinfo_max_freq");
            if (!dir.exists()) {
                return ProbeContext.Outcome.flagged(null, "cpufreq directory missing");
            }
            String full = ProbeContext.readFileUpToBytes(f, 4096).trim();
            String sw = ProbeContext.findSuspiciousWord(full);
            return ProbeContext.Outcome.of(full, sw != null, sw != null ? "contains '" + sw + "'" : null);
        });

        checkTextFile(ctx, "files.sys.soc0.machine", "/sys/devices/soc0/machine");
        checkTextFile(ctx, "files.sys.soc0.soc_id", "/sys/devices/soc0/soc_id");
    }

    private static void checkTextFile(ProbeContext ctx, String id, String path) {
        ctx.check(id, "files", () -> {
            String full = ProbeContext.readFileUpToBytes(new File(path), 512 * 1024);
            String sw = ProbeContext.findSuspiciousWord(full);
            return ProbeContext.Outcome.of(
                    ProbeContext.truncate(full, ProbeContext.MAX_TEXT_CHARS),
                    sw != null,
                    sw != null ? "contains '" + sw + "'" : null
            );
        });
    }

    private static void checkDirNames(ProbeContext ctx, String id, String dirPath, boolean flagVirtioBlock) {
        ctx.check(id, "files", () -> {
            File dir = new File(dirPath);
            if (!dir.exists()) {
                return ProbeContext.Outcome.error("directory does not exist: " + dirPath);
            }
            String[] names = dir.list();
            if (names == null) {
                return ProbeContext.Outcome.error("cannot list directory: " + dirPath);
            }
            Arrays.sort(names);
            JSONArray arr = new JSONArray();
            List<String> reasons = new ArrayList<>();
            List<String> vdDevs = new ArrayList<>();
            for (String n : names) {
                arr.put(n);
                String sw = ProbeContext.findSuspiciousWord(n);
                if (sw != null) {
                    reasons.add("entry '" + n + "' contains '" + sw + "'");
                }
                if (flagVirtioBlock && n.startsWith("vd")) {
                    vdDevs.add(n);
                }
            }
            if (!vdDevs.isEmpty()) {
                reasons.add("contains virtio block devices: " + vdDevs);
            }
            return ProbeContext.Outcome.of(arr, !reasons.isEmpty(), ProbeContext.joinReasons(reasons));
        });
    }

    private static void runRootChecks(ProbeContext ctx) {
        // su in PATH + standard dirs
        ctx.check("root.su_paths", "root", () -> {
            Set<String> dirs = new LinkedHashSet<>();
            String envPath = System.getenv("PATH");
            if (envPath != null && !envPath.isEmpty()) {
                for (String p : envPath.split(":")) {
                    if (!p.isEmpty()) {
                        dirs.add(p);
                    }
                }
            }
            dirs.addAll(Arrays.asList(SU_DIRS));
            JSONArray found = new JSONArray();
            for (String d : dirs) {
                File su = new File(d, "su");
                if (su.exists()) {
                    found.put(su.getAbsolutePath());
                }
            }
            return ProbeContext.Outcome.of(
                    found,
                    found.length() > 0,
                    found.length() > 0 ? "su binary found (" + found.length() + " path(s))" : null
            );
        });

        // Runtime.exec("su -c id") with 2s timeout
        ctx.check("root.su_exec", "root", () -> {
            ProbeContext.ExecResult res = ProbeContext.execWithTimeout(new String[]{"su", "-c", "id"}, 2000);
            JSONObject obj = new JSONObject();
            obj.put("exitCode", res.exitCode == null ? JSONObject.NULL : res.exitCode);
            obj.put("output", ProbeContext.truncate(res.output == null ? "" : res.output.trim(), ProbeContext.MAX_TEXT_CHARS));
            obj.put("timedOut", res.timedOut);
            if (res.timedOut) {
                return ProbeContext.Outcome.withError(obj, true, "su -c id spawned and timed out", "timed out after 2000ms");
            }
            boolean executed = res.exitCode != null;
            String why = null;
            if (executed && res.exitCode == 0) {
                why = "su -c id succeeded";
            } else if (executed) {
                why = "su binary executed (exit=" + res.exitCode + ")";
            }
            return ProbeContext.Outcome.of(obj, executed, why);
        });

        // which su
        ctx.check("root.which_su", "root", () -> {
            ProbeContext.ExecResult res = ProbeContext.execWithTimeout(new String[]{"which", "su"}, 2000);
            if (res.timedOut) {
                return ProbeContext.Outcome.error("which su timed out");
            }
            String out = res.output == null ? "" : res.output.trim();
            boolean found = res.exitCode != null && res.exitCode == 0 && !out.isEmpty();
            return ProbeContext.Outcome.of(found ? out : null, found, found ? "which su found: " + out : null);
        });

        // Root / Magisk artifact files
        ctx.check("root.artifacts", "root", () -> {
            JSONObject map = new JSONObject();
            List<String> found = new ArrayList<>();
            for (String path : ROOT_ARTIFACTS) {
                boolean exists = new File(path).exists();
                map.put(path, exists);
                if (exists) {
                    found.add(path);
                }
            }
            return ProbeContext.Outcome.of(
                    map,
                    !found.isEmpty(),
                    !found.isEmpty() ? "root artifact paths exist: " + found : null
            );
        });

        // Mount lines containing magisk|/data/adb|KSU|APatch|overlay on /system or /vendor
        ctx.check("root.mounts", "root", () -> {
            Set<String> matches = new LinkedHashSet<>();
            String[] mountFiles = {"/proc/self/mounts", "/proc/self/mountinfo"};
            Exception lastErr = null;
            boolean readAny = false;
            for (String mf : mountFiles) {
                try {
                    List<String> lines = ProbeContext.readLines(new File(mf), 0);
                    readAny = true;
                    for (String line : lines) {
                        if (ROOT_MOUNT_KEYWORDS.matcher(line).find()) {
                            matches.add(line);
                        } else if (line.contains("overlay")
                                && (line.contains(" /system") || line.contains(" /vendor"))) {
                            matches.add(line);
                        }
                    }
                } catch (Exception e) {
                    lastErr = e;
                }
            }
            if (!readAny && lastErr != null) {
                throw lastErr;
            }
            JSONArray arr = new JSONArray();
            for (String m : matches) {
                arr.put(m);
            }
            return ProbeContext.Outcome.of(
                    arr,
                    arr.length() > 0,
                    arr.length() > 0 ? arr.length() + " suspicious root/overlay mount(s)" : null
            );
        });

        // Installed root/hooking packages
        ctx.check("root.packages", "root", () -> {
            PackageManager pm = ctx.appContext.getPackageManager();
            JSONArray found = new JSONArray();
            for (String pkg : ROOT_PACKAGES) {
                try {
                    pm.getPackageInfo(pkg, 0);
                    found.put(pkg);
                } catch (PackageManager.NameNotFoundException ignored) {
                    // Not installed.
                }
            }
            return ProbeContext.Outcome.of(
                    found,
                    found.length() > 0,
                    found.length() > 0 ? "root/hooking packages installed: " + found : null
            );
        });

        // SELinux via getenforce
        ctx.check("root.selinux.getenforce", "root", () -> {
            ProbeContext.ExecResult res = ProbeContext.execWithTimeout(new String[]{"getenforce"}, 2000);
            if (res.timedOut) {
                return ProbeContext.Outcome.error("getenforce timed out");
            }
            String out = res.output == null ? "" : res.output.trim();
            boolean permissive = "Permissive".equalsIgnoreCase(out);
            return ProbeContext.Outcome.of(out, permissive, permissive ? "SELinux is Permissive" : null);
        });

        // SELinux via /sys/fs/selinux/enforce
        ctx.check("root.selinux.enforce_file", "root", () -> {
            String val = ProbeContext.readFileUpToBytes(new File("/sys/fs/selinux/enforce"), 64).trim();
            boolean permissive = "0".equals(val);
            return ProbeContext.Outcome.of(val, permissive, permissive ? "/sys/fs/selinux/enforce is 0 (Permissive)" : null);
        });
    }

    private static String pathToId(String prefix, String path) {
        String p = path.startsWith("/") ? path.substring(1) : path;
        StringBuilder sb = new StringBuilder(prefix);
        for (int i = 0; i < p.length(); i++) {
            char c = Character.toLowerCase(p.charAt(i));
            if (c == '/') {
                sb.append('.');
            } else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_') {
                sb.append(c);
            } else {
                sb.append('_');
            }
        }
        return sb.toString();
    }

    private static String joinLines(List<String> lines) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < lines.size(); i++) {
            if (i > 0) {
                sb.append('\n');
            }
            sb.append(lines.get(i));
        }
        return sb.toString();
    }
}
