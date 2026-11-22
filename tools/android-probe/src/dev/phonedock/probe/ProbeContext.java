package dev.phonedock.probe;

import android.content.Context;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Shared probe state, check recording, suspicious-word matching, and bounded I/O helpers.
 */
final class ProbeContext {

    static final int MAX_TEXT_CHARS = 4000;

    static final Pattern SUSPICIOUS_PATTERN = Pattern.compile(
            "generic|sdk_gphone|emulator|goldfish|ranchu|qemu|virtio|vbox|genymotion|"
                    + "cuttlefish|vsoc|bluestacks|nox|android sdk built for|test-keys|"
                    + "dev-keys|swiftshader|llvmpipe|translator|gfxstream",
            Pattern.CASE_INSENSITIVE
    );

    interface CheckTask {
        Outcome run() throws Exception;
    }

    static final class Outcome {
        final Object value;
        final boolean flag;
        final String why;
        final String error;

        private Outcome(Object value, boolean flag, String why, String error) {
            this.value = value;
            this.flag = flag;
            this.why = why;
            this.error = error;
        }

        static Outcome ok(Object value) {
            return new Outcome(value, false, null, null);
        }

        static Outcome flagged(Object value, String why) {
            return new Outcome(value, true, why, null);
        }

        static Outcome of(Object value, boolean flag, String why) {
            return new Outcome(value, flag, flag ? why : null, null);
        }

        static Outcome withError(Object value, boolean flag, String why, String error) {
            return new Outcome(value, flag, flag ? why : null, error);
        }

        static Outcome error(String error) {
            return new Outcome(null, false, null, error);
        }
    }

    static final class CheckResult {
        final String id;
        final String group;
        final Object value;
        final boolean flag;
        final String why;
        final String error;

        CheckResult(String id, String group, Object value, boolean flag, String why, String error) {
            this.id = id;
            this.group = group;
            this.value = value;
            this.flag = flag;
            this.why = why;
            this.error = error;
        }

        JSONObject toJson() throws JSONException {
            JSONObject obj = new JSONObject();
            obj.put("id", id);
            obj.put("group", group);
            obj.put("value", value == null ? JSONObject.NULL : value);
            obj.put("flag", flag);
            if (flag && why != null && !why.isEmpty()) {
                obj.put("why", why);
            }
            if (error != null && !error.isEmpty()) {
                obj.put("error", error);
            }
            return obj;
        }
    }

    static final class ExecResult {
        final Integer exitCode;
        final String output;
        final boolean timedOut;

        ExecResult(Integer exitCode, String output, boolean timedOut) {
            this.exitCode = exitCode;
            this.output = output;
            this.timedOut = timedOut;
        }
    }

    final Context appContext;
    private final List<CheckResult> results = new ArrayList<>();

    ProbeContext(Context context) {
        this.appContext = context.getApplicationContext();
    }

    void check(String id, String group, CheckTask task) {
        try {
            Outcome out = task.run();
            if (out == null) {
                results.add(new CheckResult(id, group, null, false, null, null));
            } else {
                results.add(new CheckResult(id, group, out.value, out.flag, out.why, out.error));
            }
        } catch (Throwable t) {
            results.add(new CheckResult(id, group, null, false, null, formatError(t)));
        }
    }

    void add(String id, String group, Outcome out) {
        if (out == null) {
            results.add(new CheckResult(id, group, null, false, null, null));
        } else {
            results.add(new CheckResult(id, group, out.value, out.flag, out.why, out.error));
        }
    }

    List<CheckResult> getResults() {
        return results;
    }

    int getTotalCount() {
        return results.size();
    }

    int getFlaggedCount() {
        int count = 0;
        for (CheckResult r : results) {
            if (r.flag) {
                count++;
            }
        }
        return count;
    }

    JSONObject buildReportJson() throws JSONException {
        JSONObject root = new JSONObject();
        root.put("v", 1);

        SimpleDateFormat iso = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US);
        iso.setTimeZone(TimeZone.getTimeZone("UTC"));
        root.put("generatedAt", iso.format(new Date()));
        root.put("sdk", Build.VERSION.SDK_INT);

        JSONArray checksArr = new JSONArray();
        Map<String, int[]> byGroupCounts = new LinkedHashMap<>();
        int total = 0;
        int flagged = 0;

        for (CheckResult r : results) {
            checksArr.put(r.toJson());
            total++;
            if (r.flag) {
                flagged++;
            }
            int[] gc = byGroupCounts.get(r.group);
            if (gc == null) {
                gc = new int[2];
                byGroupCounts.put(r.group, gc);
            }
            gc[0]++;
            if (r.flag) {
                gc[1]++;
            }
        }
        root.put("checks", checksArr);

        JSONObject byGroupObj = new JSONObject();
        for (Map.Entry<String, int[]> entry : byGroupCounts.entrySet()) {
            JSONObject g = new JSONObject();
            g.put("total", entry.getValue()[0]);
            g.put("flagged", entry.getValue()[1]);
            byGroupObj.put(entry.getKey(), g);
        }

        JSONObject summary = new JSONObject();
        summary.put("total", total);
        summary.put("flagged", flagged);
        summary.put("byGroup", byGroupObj);
        root.put("summary", summary);

        return root;
    }

    static String findSuspiciousWord(String text) {
        if (text == null || text.isEmpty()) {
            return null;
        }
        Matcher m = SUSPICIOUS_PATTERN.matcher(text);
        if (m.find()) {
            return m.group();
        }
        return null;
    }

    static String formatError(Throwable t) {
        if (t == null) {
            return "unknown error";
        }
        Throwable cause = t;
        if (t instanceof ExecutionException && t.getCause() != null) {
            cause = t.getCause();
        }
        String msg = cause.getMessage();
        String name = cause.getClass().getSimpleName();
        return (msg == null || msg.isEmpty()) ? name : (name + ": " + msg);
    }

    static Object safeNumber(double v) {
        if (Double.isNaN(v) || Double.isInfinite(v)) {
            return JSONObject.NULL;
        }
        return v;
    }

    static Object safeNumber(float v) {
        if (Float.isNaN(v) || Float.isInfinite(v)) {
            return JSONObject.NULL;
        }
        return (double) v;
    }

    static String truncate(String s, int maxChars) {
        if (s == null || s.length() <= maxChars) {
            return s;
        }
        return s.substring(0, maxChars);
    }

    static String joinReasons(List<String> reasons) {
        if (reasons == null || reasons.isEmpty()) {
            return null;
        }
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < reasons.size(); i++) {
            if (i > 0) {
                sb.append("; ");
            }
            sb.append(reasons.get(i));
        }
        return sb.toString();
    }

    static boolean isAllZeros(String s) {
        if (s == null || s.isEmpty()) {
            return false;
        }
        for (int i = 0; i < s.length(); i++) {
            if (s.charAt(i) != '0') {
                return false;
            }
        }
        return true;
    }

    static <T> T runWithTimeout(long timeoutMs, Callable<T> task) throws Exception {
        ExecutorService exec = Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "pdprobe-timeout");
            t.setDaemon(true);
            return t;
        });
        Future<T> future = exec.submit(task);
        try {
            return future.get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            future.cancel(true);
            throw new TimeoutException("timed out after " + timeoutMs + "ms");
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof Exception) {
                throw (Exception) cause;
            }
            if (cause instanceof Error) {
                throw (Error) cause;
            }
            throw e;
        } finally {
            exec.shutdownNow();
        }
    }

    static ExecResult execWithTimeout(String[] cmd, long timeoutMs) throws IOException, InterruptedException {
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.redirectErrorStream(true);
        final Process proc = pb.start();
        final ByteArrayOutputStream baos = new ByteArrayOutputStream();
        final int maxBytes = 2 * 1024 * 1024;

        Thread reader = new Thread(() -> {
            try (InputStream is = proc.getInputStream()) {
                byte[] buf = new byte[4096];
                int n;
                int total = 0;
                while ((n = is.read(buf)) != -1) {
                    if (total < maxBytes) {
                        int toWrite = Math.min(n, maxBytes - total);
                        baos.write(buf, 0, toWrite);
                        total += toWrite;
                    }
                }
            } catch (IOException ignored) {
                // Process destroyed or stream closed.
            }
        }, "pdprobe-proc-read");
        reader.setDaemon(true);
        reader.start();

        boolean finished = proc.waitFor(timeoutMs, TimeUnit.MILLISECONDS);
        if (!finished) {
            proc.destroyForcibly();
            reader.join(250);
            String out = new String(baos.toByteArray(), StandardCharsets.UTF_8);
            return new ExecResult(null, out, true);
        }
        reader.join(500);
        String out = new String(baos.toByteArray(), StandardCharsets.UTF_8);
        return new ExecResult(proc.exitValue(), out, false);
    }

    static String readFileUpToBytes(File file, int maxBytes) throws IOException {
        try (FileInputStream fis = new FileInputStream(file)) {
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            int total = 0;
            while ((n = fis.read(buf)) != -1) {
                int toWrite = Math.min(n, maxBytes - total);
                if (toWrite > 0) {
                    baos.write(buf, 0, toWrite);
                    total += toWrite;
                }
                if (total >= maxBytes) {
                    break;
                }
            }
            return new String(baos.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    static List<String> readLines(File file, int maxLines) throws IOException {
        List<String> lines = new ArrayList<>();
        try (BufferedReader br = new BufferedReader(
                new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8))) {
            String line;
            while ((line = br.readLine()) != null) {
                lines.add(line);
                if (maxLines > 0 && lines.size() >= maxLines) {
                    break;
                }
            }
        }
        return lines;
    }

    static File getReportDir(Context context) {
        File dir = context.getExternalFilesDir(null);
        if (dir == null) {
            dir = context.getFilesDir();
        }
        if (!dir.exists()) {
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
        }
        return dir;
    }
}
