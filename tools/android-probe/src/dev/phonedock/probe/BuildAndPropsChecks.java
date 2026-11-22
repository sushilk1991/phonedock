package dev.phonedock.probe;

import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Checks for the 'build' and 'props' groups.
 */
final class BuildAndPropsChecks {

    private static final String[] TARGET_PROPS = {
            "ro.kernel.qemu",
            "ro.boot.qemu",
            "ro.kernel.qemu.gles",
            "ro.hardware",
            "ro.boot.hardware",
            "ro.product.board",
            "ro.board.platform",
            "ro.build.characteristics",
            "ro.bootloader",
            "ro.bootmode",
            "ro.secure",
            "ro.debuggable",
            "ro.adb.secure",
            "service.adb.root",
            "ro.boot.verifiedbootstate",
            "ro.boot.vbmeta.device_state",
            "ro.boot.flash.locked",
            "ro.build.tags",
            "ro.build.type",
            "ro.build.flavor",
            "ro.build.description",
            "ro.product.name",
            "ro.product.device",
            "ro.product.model",
            "ro.product.manufacturer",
            "ro.vendor.build.fingerprint",
            "ro.system.build.fingerprint",
            "ro.bootimage.build.fingerprint",
            "ro.odm.build.fingerprint",
            "ro.product.vendor.model",
            "ro.product.system.model",
            "gsm.version.baseband",
            "gsm.version.ril-impl",
            "gsm.operator.alpha",
            "gsm.sim.operator.alpha",
            "gsm.operator.numeric",
            "ro.serialno",
            "ro.boot.serialno",
            "init.svc.qemud",
            "init.svc.qemu-props",
            "init.svc.goldfish-logcat",
            "ro.hardware.egl",
            "ro.hardware.gralloc",
            "ro.hardware.vulkan",
            "ro.opengles.version",
            "ro.sf.lcd_density",
            "ro.zygote",
            "persist.sys.timezone",
            "ro.boot.selinux"
    };

    private BuildAndPropsChecks() {}

    static void runAll(ProbeContext ctx) {
        runBuildChecks(ctx);
        runPropsChecks(ctx);
    }

    private static void runBuildChecks(ProbeContext ctx) {
        checkBuildString(ctx, "build.fingerprint", Build.FINGERPRINT);
        checkBuildString(ctx, "build.model", Build.MODEL);
        checkBuildString(ctx, "build.manufacturer", Build.MANUFACTURER);
        checkBuildString(ctx, "build.brand", Build.BRAND);
        checkBuildString(ctx, "build.device", Build.DEVICE);
        checkBuildString(ctx, "build.product", Build.PRODUCT);
        checkBuildString(ctx, "build.hardware", Build.HARDWARE);
        checkBuildString(ctx, "build.board", Build.BOARD);

        ctx.check("build.bootloader", "build", () -> {
            String v = Build.BOOTLOADER;
            List<String> reasons = new ArrayList<>();
            if (v == null || v.isEmpty() || "unknown".equalsIgnoreCase(v)) {
                reasons.add("bootloader is empty or unknown");
            }
            String sw = ProbeContext.findSuspiciousWord(v);
            if (sw != null) {
                reasons.add("contains '" + sw + "'");
            }
            return ProbeContext.Outcome.of(v, !reasons.isEmpty(), ProbeContext.joinReasons(reasons));
        });

        ctx.check("build.tags", "build", () -> {
            String v = Build.TAGS;
            List<String> reasons = new ArrayList<>();
            if (v != null && (v.contains("test-keys") || v.contains("dev-keys"))) {
                reasons.add("tags contain test-keys or dev-keys");
            } else {
                String sw = ProbeContext.findSuspiciousWord(v);
                if (sw != null) {
                    reasons.add("contains '" + sw + "'");
                }
            }
            return ProbeContext.Outcome.of(v, !reasons.isEmpty(), ProbeContext.joinReasons(reasons));
        });

        ctx.check("build.type", "build", () -> {
            String v = Build.TYPE;
            List<String> reasons = new ArrayList<>();
            if (!"user".equals(v)) {
                reasons.add("build type is '" + v + "' (not 'user')");
            }
            String sw = ProbeContext.findSuspiciousWord(v);
            if (sw != null) {
                reasons.add("contains '" + sw + "'");
            }
            return ProbeContext.Outcome.of(v, !reasons.isEmpty(), ProbeContext.joinReasons(reasons));
        });

        checkBuildString(ctx, "build.host", Build.HOST);
        checkBuildString(ctx, "build.user", Build.USER);
        checkBuildString(ctx, "build.id", Build.ID);
        checkBuildString(ctx, "build.display", Build.DISPLAY);

        ctx.check("build.supported_abis", "build", () -> {
            JSONArray arr = new JSONArray();
            List<String> reasons = new ArrayList<>();
            if (Build.SUPPORTED_ABIS != null) {
                for (String abi : Build.SUPPORTED_ABIS) {
                    arr.put(abi);
                    String sw = ProbeContext.findSuspiciousWord(abi);
                    if (sw != null) {
                        reasons.add("abi contains '" + sw + "'");
                    }
                }
            }
            return ProbeContext.Outcome.of(arr, !reasons.isEmpty(), ProbeContext.joinReasons(reasons));
        });

        ctx.check("build.soc_manufacturer", "build", () -> {
            if (Build.VERSION.SDK_INT < 31) {
                return ProbeContext.Outcome.error("requires API 31 (current " + Build.VERSION.SDK_INT + ")");
            }
            String v = Build.SOC_MANUFACTURER;
            String sw = ProbeContext.findSuspiciousWord(v);
            return ProbeContext.Outcome.of(v, sw != null, sw != null ? "contains '" + sw + "'" : null);
        });

        ctx.check("build.soc_model", "build", () -> {
            if (Build.VERSION.SDK_INT < 31) {
                return ProbeContext.Outcome.error("requires API 31 (current " + Build.VERSION.SDK_INT + ")");
            }
            String v = Build.SOC_MODEL;
            String sw = ProbeContext.findSuspiciousWord(v);
            return ProbeContext.Outcome.of(v, sw != null, sw != null ? "contains '" + sw + "'" : null);
        });

        ctx.check("build.radio_version", "build", () -> {
            String v = Build.getRadioVersion();
            List<String> reasons = new ArrayList<>();
            if (v == null || v.isEmpty() || "unknown".equalsIgnoreCase(v)) {
                reasons.add("radio version is empty or unknown");
            }
            String sw = ProbeContext.findSuspiciousWord(v);
            if (sw != null) {
                reasons.add("contains '" + sw + "'");
            }
            return ProbeContext.Outcome.of(v, !reasons.isEmpty(), ProbeContext.joinReasons(reasons));
        });

        checkBuildString(ctx, "build.version.release", Build.VERSION.RELEASE);
        ctx.check("build.version.sdk_int", "build", () -> ProbeContext.Outcome.ok(Build.VERSION.SDK_INT));
        checkBuildString(ctx, "build.version.security_patch", Build.VERSION.SECURITY_PATCH);
        checkBuildString(ctx, "build.version.incremental", Build.VERSION.INCREMENTAL);
        checkBuildString(ctx, "build.version.codename", Build.VERSION.CODENAME);

        ctx.check("build.serial", "build", () -> {
            String v = Build.getSerial();
            String sw = ProbeContext.findSuspiciousWord(v);
            return ProbeContext.Outcome.of(v, sw != null, sw != null ? "contains '" + sw + "'" : null);
        });
    }

    private static void checkBuildString(ProbeContext ctx, String id, String value) {
        ctx.check(id, "build", () -> {
            String sw = ProbeContext.findSuspiciousWord(value);
            return ProbeContext.Outcome.of(value, sw != null, sw != null ? "contains '" + sw + "'" : null);
        });
    }

    private static void runPropsChecks(ProbeContext ctx) {
        // Prepare SystemProperties.get reflection handle once
        Method sysPropGet = null;
        String sysPropError = null;
        try {
            Class<?> spClass = Class.forName("android.os.SystemProperties");
            sysPropGet = spClass.getMethod("get", String.class);
        } catch (Throwable t) {
            sysPropError = ProbeContext.formatError(t);
        }

        // Run getprop once with timeout
        Map<String, String> getpropMap = new LinkedHashMap<>();
        String getpropError = null;
        try {
            ProbeContext.ExecResult res = ProbeContext.execWithTimeout(new String[]{"getprop"}, 3000);
            if (res.timedOut) {
                getpropError = "getprop timed out";
            } else if (res.exitCode == null || res.exitCode != 0) {
                getpropError = "getprop exit=" + res.exitCode + ": " + ProbeContext.truncate(res.output, 200);
            } else {
                parseGetprop(res.output, getpropMap);
            }
        } catch (Throwable t) {
            getpropError = ProbeContext.formatError(t);
        }

        final Method finalSysPropGet = sysPropGet;
        final String finalSysPropError = sysPropError;
        final String finalGetpropError = getpropError;

        for (final String prop : TARGET_PROPS) {
            ctx.check("props." + prop, "props", () -> {
                String spVal = null;
                String spErr = finalSysPropError;
                if (finalSysPropGet != null) {
                    try {
                        Object raw = finalSysPropGet.invoke(null, prop);
                        spVal = raw == null ? "" : raw.toString();
                    } catch (Throwable t) {
                        spErr = ProbeContext.formatError(t);
                    }
                }

                boolean gpHas = finalGetpropError == null && getpropMap.containsKey(prop);
                String gpVal = gpHas ? getpropMap.get(prop) : null;

                JSONObject valObj = new JSONObject();
                valObj.put("sysprop", spVal == null ? JSONObject.NULL : spVal);
                valObj.put("getprop", gpVal == null ? JSONObject.NULL : gpVal);
                if (spErr != null) {
                    valObj.put("syspropError", spErr);
                }
                if (finalGetpropError != null) {
                    valObj.put("getpropError", finalGetpropError);
                }

                List<String> reasons = new ArrayList<>();
                if (spErr == null && finalGetpropError == null) {
                    String normSp = spVal == null ? "" : spVal;
                    String normGp = gpVal == null ? "" : gpVal;
                    if (!normSp.equals(normGp)) {
                        reasons.add("SystemProperties ('" + normSp + "') differs from getprop ('" + normGp + "')");
                    }
                }

                String effective = (spVal != null && !spVal.isEmpty()) ? spVal : (gpVal != null ? gpVal : "");
                evaluatePropReasons(prop, effective, reasons);

                String combinedErr = null;
                if (spErr != null && finalGetpropError != null) {
                    combinedErr = "sysprop: " + spErr + "; getprop: " + finalGetpropError;
                }
                return ProbeContext.Outcome.withError(
                        valObj, !reasons.isEmpty(), ProbeContext.joinReasons(reasons), combinedErr);
            });
        }

        ctx.check("props.suspicious", "props", () -> {
            if (finalGetpropError != null) {
                return ProbeContext.Outcome.error(finalGetpropError);
            }
            JSONArray matches = new JSONArray();
            for (Map.Entry<String, String> entry : getpropMap.entrySet()) {
                String k = entry.getKey();
                String v = entry.getValue();
                if (ProbeContext.findSuspiciousWord(k) != null || ProbeContext.findSuspiciousWord(v) != null) {
                    matches.put(k + "=" + v);
                }
            }
            return ProbeContext.Outcome.of(
                    matches,
                    matches.length() > 0,
                    matches.length() > 0 ? matches.length() + " suspicious properties in getprop" : null
            );
        });

        ctx.check("props.count", "props", () -> {
            if (finalGetpropError != null) {
                return ProbeContext.Outcome.error(finalGetpropError);
            }
            return ProbeContext.Outcome.ok(getpropMap.size());
        });
    }

    private static void evaluatePropReasons(String prop, String val, List<String> reasons) {
        String sw = ProbeContext.findSuspiciousWord(val);
        if (sw != null) {
            reasons.add("contains '" + sw + "'");
        }
        switch (prop) {
            case "ro.kernel.qemu":
            case "ro.boot.qemu":
            case "ro.kernel.qemu.gles":
            case "ro.debuggable":
            case "service.adb.root":
                if ("1".equals(val)) {
                    reasons.add(prop + " is 1");
                }
                break;
            case "ro.secure":
            case "ro.adb.secure":
            case "ro.boot.flash.locked":
                if ("0".equals(val)) {
                    reasons.add(prop + " is 0");
                }
                break;
            case "ro.boot.vbmeta.device_state":
                if ("unlocked".equalsIgnoreCase(val)) {
                    reasons.add("vbmeta device_state is unlocked");
                }
                break;
            case "ro.boot.verifiedbootstate":
                if (!val.isEmpty() && !"green".equalsIgnoreCase(val)) {
                    reasons.add("verifiedbootstate is '" + val + "'");
                }
                break;
            case "ro.boot.selinux":
                if ("permissive".equalsIgnoreCase(val)) {
                    reasons.add("selinux boot prop is permissive");
                }
                break;
            case "ro.build.type":
                if (!val.isEmpty() && !"user".equals(val)) {
                    reasons.add("ro.build.type is '" + val + "'");
                }
                break;
            case "ro.bootloader":
                if (val.isEmpty() || "unknown".equalsIgnoreCase(val)) {
                    reasons.add("ro.bootloader is empty or unknown");
                }
                break;
            case "init.svc.qemud":
            case "init.svc.qemu-props":
            case "init.svc.goldfish-logcat":
                if (!val.isEmpty()) {
                    reasons.add("emulator init service property present: " + val);
                }
                break;
            default:
                break;
        }
    }

    private static void parseGetprop(String output, Map<String, String> out) {
        if (output == null || output.isEmpty()) {
            return;
        }
        String[] lines = output.split("\n");
        String pendingKey = null;
        StringBuilder pendingVal = null;

        for (String rawLine : lines) {
            String line = rawLine.endsWith("\r") ? rawLine.substring(0, rawLine.length() - 1) : rawLine;
            if (pendingKey != null) {
                if (line.endsWith("]")) {
                    pendingVal.append('\n').append(line, 0, line.length() - 1);
                    out.put(pendingKey, pendingVal.toString());
                    pendingKey = null;
                    pendingVal = null;
                } else {
                    pendingVal.append('\n').append(line);
                }
                continue;
            }
            if (!line.startsWith("[")) {
                continue;
            }
            int sep = line.indexOf("]: [");
            if (sep <= 1) {
                continue;
            }
            String key = line.substring(1, sep);
            String rest = line.substring(sep + 4);
            if (rest.endsWith("]")) {
                out.put(key, rest.substring(0, rest.length() - 1));
            } else {
                pendingKey = key;
                pendingVal = new StringBuilder(rest);
            }
        }
        if (pendingKey != null) {
            out.put(pendingKey, pendingVal.toString());
        }
    }
}
