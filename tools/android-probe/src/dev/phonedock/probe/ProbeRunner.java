package dev.phonedock.probe;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/**
 * Runs all probe groups on a background thread, writes report.json, and formats UI text.
 */
final class ProbeRunner {

    static final String TAG = "PDPROBE";

    static final class RunOutput {
        final int total;
        final int flagged;
        final String path;
        final String displayText;

        RunOutput(int total, int flagged, String path, String displayText) {
            this.total = total;
            this.flagged = flagged;
            this.path = path;
            this.displayText = displayText;
        }
    }

    private ProbeRunner() {}

    static RunOutput runAndWrite(Context context) {
        ProbeContext ctx = new ProbeContext(context);

        runGroup(ctx, "build_props", () -> BuildAndPropsChecks.runAll(ctx));
        runGroup(ctx, "files_root", () -> FilesAndRootChecks.runAll(ctx));
        runGroup(ctx, "hardware", () -> HardwareChecks.runAll(ctx));
        runGroup(ctx, "device_system", () -> DeviceAndSystemChecks.runAll(ctx));

        File outDir = ProbeContext.getReportDir(context);
        File outFile = new File(outDir, "report.json");
        int total = ctx.getTotalCount();
        int flagged = ctx.getFlaggedCount();
        String writeError = null;

        try {
            JSONObject report = ctx.buildReportJson();
            writeAtomic(outFile, report.toString(2));
        } catch (Throwable t) {
            writeError = ProbeContext.formatError(t);
        }

        String absPath = outFile.getAbsolutePath();
        // Log exactly one line for the probe run.
        Log.i(TAG, "done checks=" + total + " flagged=" + flagged + " path=" + absPath);

        String display = formatDisplayText(ctx, total, flagged, absPath, writeError);
        return new RunOutput(total, flagged, absPath, display);
    }

    private static void runGroup(ProbeContext ctx, String name, Runnable r) {
        try {
            r.run();
        } catch (Throwable t) {
            ctx.add("internal.group." + name, "system", ProbeContext.Outcome.error(ProbeContext.formatError(t)));
        }
    }

    static void writeAtomic(File target, String content) throws IOException {
        File parent = target.getParentFile();
        if (parent != null && !parent.exists()) {
            //noinspection ResultOfMethodCallIgnored
            parent.mkdirs();
        }
        File tmp = new File(parent, target.getName() + ".tmp");
        byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
        try (FileOutputStream fos = new FileOutputStream(tmp)) {
            fos.write(bytes);
            fos.getFD().sync();
        }
        if (!tmp.renameTo(target)) {
            // Fallback direct write if rename fails on certain FUSE/sdcardfs mounts.
            try (FileOutputStream fos = new FileOutputStream(target)) {
                fos.write(bytes);
                fos.getFD().sync();
            }
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
        }
    }

    private static String formatDisplayText(
            ProbeContext ctx, int total, int flagged, String path, String writeError) {
        StringBuilder sb = new StringBuilder(8192);
        sb.append("pd-probe: checks=").append(total)
                .append(" flagged=").append(flagged).append('\n')
                .append("report: ").append(path).append('\n');
        if (writeError != null) {
            sb.append("WRITE ERROR: ").append(writeError).append('\n');
        }

        sb.append("\n=== FLAGGED (").append(flagged).append(") ===\n");
        for (ProbeContext.CheckResult r : ctx.getResults()) {
            if (!r.flag) continue;
            appendLine(sb, r);
        }

        sb.append("\n=== OTHER (").append(total - flagged).append(") ===\n");
        for (ProbeContext.CheckResult r : ctx.getResults()) {
            if (r.flag) continue;
            appendLine(sb, r);
        }
        return sb.toString();
    }

    private static void appendLine(StringBuilder sb, ProbeContext.CheckResult r) {
        sb.append(r.id).append(" = ");
        if (r.value != null) {
            String s = r.value.toString().replace('\n', ' ');
            if (s.length() > 160) {
                s = s.substring(0, 160) + "...";
            }
            sb.append(s);
        } else {
            sb.append("null");
        }
        if (r.flag && r.why != null && !r.why.isEmpty()) {
            sb.append("  [WHY: ").append(r.why).append(']');
        }
        if (r.error != null && !r.error.isEmpty()) {
            sb.append("  [ERR: ").append(r.error).append(']');
        }
        sb.append('\n');
    }
}
