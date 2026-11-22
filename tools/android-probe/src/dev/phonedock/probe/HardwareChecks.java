package dev.phonedock.probe;

import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.media.MediaDrm;
import android.opengl.EGL14;
import android.opengl.EGLConfig;
import android.opengl.EGLContext;
import android.opengl.EGLDisplay;
import android.opengl.EGLSurface;
import android.opengl.GLES20;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyInfo;
import android.security.keystore.KeyProperties;
import android.telephony.TelephonyManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.security.spec.ECGenParameterSpec;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Checks for 'telephony', 'sensors', 'gl', 'media', 'keystore', and 'battery' groups.
 */
final class HardwareChecks {

    private static final UUID WIDEVINE_UUID = UUID.fromString("edef8ba9-79d6-4ace-a3c8-27dcd51d21ed");
    private static final String ATTEST_ALIAS = "pd_probe_attest_ec256";

    private static final Pattern SENSOR_AOSP_PATTERN = Pattern.compile(
            "aosp|the android open source project",
            Pattern.CASE_INSENSITIVE
    );

    private static final Pattern GL_SUSPICIOUS_VENDOR = Pattern.compile(
            "android emulator|apple|angle|mesa|vmware|google",
            Pattern.CASE_INSENSITIVE
    );

    private HardwareChecks() {}

    static void runAll(ProbeContext ctx) {
        runTelephonyChecks(ctx);
        runSensorChecks(ctx);
        runGlChecks(ctx);
        runMediaChecks(ctx);
        runKeystoreChecks(ctx);
        runBatteryChecks(ctx);
    }

    // -------------------------------------------------------------------------
    // telephony
    // -------------------------------------------------------------------------

    @SuppressWarnings("deprecation")
    private static void runTelephonyChecks(ProbeContext ctx) {
        ctx.check("telephony.feature", "telephony", () -> {
            boolean has = ctx.appContext.getPackageManager()
                    .hasSystemFeature(PackageManager.FEATURE_TELEPHONY);
            return ProbeContext.Outcome.ok(has);
        });

        final TelephonyManager tm = (TelephonyManager) ctx.appContext.getSystemService(Context.TELEPHONY_SERVICE);
        if (tm == null) {
            ctx.add("telephony.service", "telephony", ProbeContext.Outcome.error("TelephonyManager is null"));
            return;
        }

        ctx.check("telephony.phone_type", "telephony", () -> ProbeContext.Outcome.ok(phoneTypeName(tm.getPhoneType())));

        ctx.check("telephony.sim_state", "telephony", () -> {
            int state = tm.getSimState();
            String name = simStateName(state);
            boolean absent = (state == TelephonyManager.SIM_STATE_ABSENT);
            return ProbeContext.Outcome.of(name, absent, absent ? "SIM state is ABSENT" : null);
        });

        ctx.check("telephony.network_operator_name", "telephony", () -> {
            String v = tm.getNetworkOperatorName();
            return evaluateOperatorName(v);
        });

        ctx.check("telephony.network_operator", "telephony", () -> {
            String v = tm.getNetworkOperator();
            boolean empty = v == null || v.isEmpty();
            return ProbeContext.Outcome.of(v, empty, empty ? "network operator numeric is empty" : null);
        });

        ctx.check("telephony.sim_operator_name", "telephony", () -> {
            String v = tm.getSimOperatorName();
            return evaluateOperatorName(v);
        });

        ctx.check("telephony.sim_operator", "telephony", () -> {
            String v = tm.getSimOperator();
            boolean empty = v == null || v.isEmpty();
            return ProbeContext.Outcome.of(v, empty, empty ? "SIM operator numeric is empty" : null);
        });

        ctx.check("telephony.network_country_iso", "telephony", () -> ProbeContext.Outcome.ok(tm.getNetworkCountryIso()));
        ctx.check("telephony.sim_country_iso", "telephony", () -> ProbeContext.Outcome.ok(tm.getSimCountryIso()));
        ctx.check("telephony.is_network_roaming", "telephony", () -> ProbeContext.Outcome.ok(tm.isNetworkRoaming()));
        ctx.check("telephony.data_state", "telephony", () -> ProbeContext.Outcome.ok(dataStateName(tm.getDataState())));

        ctx.check("telephony.phone_count", "telephony", () -> {
            int count = Build.VERSION.SDK_INT >= 30 ? tm.getActiveModemCount() : tm.getPhoneCount();
            return ProbeContext.Outcome.ok(count);
        });

        ctx.check("telephony.imei", "telephony", () -> {
            String v = tm.getImei();
            boolean zeros = ProbeContext.isAllZeros(v);
            return ProbeContext.Outcome.of(v, zeros, zeros ? "IMEI is all zeros" : null);
        });

        ctx.check("telephony.device_id", "telephony", () -> {
            String v = tm.getDeviceId();
            boolean zeros = ProbeContext.isAllZeros(v);
            return ProbeContext.Outcome.of(v, zeros, zeros ? "deviceId is all zeros" : null);
        });

        ctx.check("telephony.subscriber_id", "telephony", () -> {
            String v = tm.getSubscriberId();
            boolean zeros = ProbeContext.isAllZeros(v);
            return ProbeContext.Outcome.of(v, zeros, zeros ? "subscriberId is all zeros" : null);
        });

        ctx.check("telephony.sim_serial_number", "telephony", () -> ProbeContext.Outcome.ok(tm.getSimSerialNumber()));
        ctx.check("telephony.line1_number", "telephony", () -> ProbeContext.Outcome.ok(tm.getLine1Number()));

        ctx.check("telephony.meid", "telephony", () -> {
            String v = tm.getMeid();
            boolean zeros = ProbeContext.isAllZeros(v);
            return ProbeContext.Outcome.of(v, zeros, zeros ? "MEID is all zeros" : null);
        });
    }

    private static ProbeContext.Outcome evaluateOperatorName(String v) {
        List<String> reasons = new ArrayList<>();
        if (v == null || v.isEmpty()) {
            reasons.add("operator name is empty");
        } else if ("Android".equalsIgnoreCase(v)) {
            reasons.add("operator name is 'Android'");
        }
        String sw = ProbeContext.findSuspiciousWord(v);
        if (sw != null) {
            reasons.add("contains '" + sw + "'");
        }
        return ProbeContext.Outcome.of(v, !reasons.isEmpty(), ProbeContext.joinReasons(reasons));
    }

    @SuppressWarnings("deprecation")
    private static String phoneTypeName(int t) {
        switch (t) {
            case TelephonyManager.PHONE_TYPE_NONE: return "NONE";
            case TelephonyManager.PHONE_TYPE_GSM: return "GSM";
            case TelephonyManager.PHONE_TYPE_CDMA: return "CDMA";
            case TelephonyManager.PHONE_TYPE_SIP: return "SIP";
            default: return "UNKNOWN(" + t + ")";
        }
    }

    private static String simStateName(int s) {
        switch (s) {
            case TelephonyManager.SIM_STATE_UNKNOWN: return "UNKNOWN";
            case TelephonyManager.SIM_STATE_ABSENT: return "ABSENT";
            case TelephonyManager.SIM_STATE_PIN_REQUIRED: return "PIN_REQUIRED";
            case TelephonyManager.SIM_STATE_PUK_REQUIRED: return "PUK_REQUIRED";
            case TelephonyManager.SIM_STATE_NETWORK_LOCKED: return "NETWORK_LOCKED";
            case TelephonyManager.SIM_STATE_READY: return "READY";
            case TelephonyManager.SIM_STATE_NOT_READY: return "NOT_READY";
            case TelephonyManager.SIM_STATE_PERM_DISABLED: return "PERM_DISABLED";
            case TelephonyManager.SIM_STATE_CARD_IO_ERROR: return "CARD_IO_ERROR";
            case TelephonyManager.SIM_STATE_CARD_RESTRICTED: return "CARD_RESTRICTED";
            default: return "STATE(" + s + ")";
        }
    }

    private static String dataStateName(int s) {
        switch (s) {
            case TelephonyManager.DATA_DISCONNECTED: return "DISCONNECTED";
            case TelephonyManager.DATA_CONNECTING: return "CONNECTING";
            case TelephonyManager.DATA_CONNECTED: return "CONNECTED";
            case TelephonyManager.DATA_SUSPENDED: return "SUSPENDED";
            default: return "STATE(" + s + ")";
        }
    }

    // -------------------------------------------------------------------------
    // sensors
    // -------------------------------------------------------------------------

    private static final class AxisStats {
        int count = 0;
        double[] first;
        double[] min;
        double[] max;
        double[] mean;
        double[] m2;

        synchronized void add(float[] values) {
            if (values == null || values.length == 0) {
                return;
            }
            int dims = Math.min(values.length, 3);
            if (count == 0) {
                first = new double[dims];
                min = new double[dims];
                max = new double[dims];
                mean = new double[dims];
                m2 = new double[dims];
                for (int i = 0; i < dims; i++) {
                    double v = values[i];
                    first[i] = v;
                    min[i] = v;
                    max[i] = v;
                    mean[i] = v;
                    m2[i] = 0.0;
                }
                count = 1;
                return;
            }
            count++;
            int n = Math.min(dims, mean.length);
            for (int i = 0; i < n; i++) {
                double v = values[i];
                if (v < min[i]) min[i] = v;
                if (v > max[i]) max[i] = v;
                // Welford's algorithm keeps m2 == 0.0 exactly for constant signals.
                double delta = v - mean[i];
                mean[i] += delta / count;
                double delta2 = v - mean[i];
                m2[i] += delta * delta2;
            }
        }

        synchronized JSONObject toJson(boolean available) throws Exception {
            JSONObject obj = new JSONObject();
            obj.put("available", available);
            obj.put("sampleCount", count);
            if (count > 0 && first != null) {
                obj.put("first", toJsonArray(first));
                obj.put("min", toJsonArray(min));
                obj.put("max", toJsonArray(max));
                double[] stddev = computeStddev();
                obj.put("stddev", toJsonArray(stddev));
            } else {
                obj.put("first", JSONObject.NULL);
                obj.put("min", JSONObject.NULL);
                obj.put("max", JSONObject.NULL);
                obj.put("stddev", JSONObject.NULL);
            }
            return obj;
        }

        synchronized boolean isAllStddevZero() {
            if (count < 1 || min == null || max == null) {
                return false;
            }
            for (int i = 0; i < min.length; i++) {
                if (min[i] != max[i]) {
                    return false;
                }
            }
            return true;
        }

        private double[] computeStddev() {
            double[] sd = new double[mean.length];
            for (int i = 0; i < mean.length; i++) {
                if (count < 2 || min[i] == max[i]) {
                    sd[i] = 0.0;
                } else {
                    sd[i] = Math.sqrt(Math.max(0.0, m2[i] / count));
                }
            }
            return sd;
        }

        private static JSONArray toJsonArray(double[] arr) throws Exception {
            JSONArray out = new JSONArray();
            for (double v : arr) {
                out.put(ProbeContext.safeNumber(v));
            }
            return out;
        }
    }

    private static void runSensorChecks(ProbeContext ctx) {
        final SensorManager sm = (SensorManager) ctx.appContext.getSystemService(Context.SENSOR_SERVICE);
        if (sm == null) {
            ctx.add("sensors.list", "sensors", ProbeContext.Outcome.error("SensorManager is null"));
            return;
        }

        ctx.check("sensors.list", "sensors", () -> {
            List<Sensor> list = sm.getSensorList(Sensor.TYPE_ALL);
            JSONArray arr = new JSONArray();
            List<String> reasons = new ArrayList<>();
            for (Sensor s : list) {
                JSONObject o = new JSONObject();
                o.put("name", s.getName());
                o.put("vendor", s.getVendor());
                o.put("type", s.getType());
                o.put("stringType", s.getStringType());
                o.put("version", s.getVersion());
                o.put("maxRange", ProbeContext.safeNumber(s.getMaximumRange()));
                o.put("resolution", ProbeContext.safeNumber(s.getResolution()));
                o.put("power", ProbeContext.safeNumber(s.getPower()));
                o.put("minDelay", s.getMinDelay());
                arr.put(o);

                String sw = findSuspiciousSensorText(s.getName());
                if (sw != null && reasons.size() < 5) {
                    reasons.add("sensor name '" + s.getName() + "' matches '" + sw + "'");
                }
                String swv = findSuspiciousSensorText(s.getVendor());
                if (swv != null && reasons.size() < 5) {
                    reasons.add("sensor vendor '" + s.getVendor() + "' matches '" + swv + "'");
                }
            }
            return ProbeContext.Outcome.of(arr, !reasons.isEmpty(), ProbeContext.joinReasons(reasons));
        });

        ctx.check("sensors.count", "sensors", () -> {
            int count = sm.getSensorList(Sensor.TYPE_ALL).size();
            boolean low = count < 8;
            return ProbeContext.Outcome.of(count, low, low ? "fewer than 8 sensors (" + count + ")" : null);
        });

        Sensor accelTmp = null;
        Sensor gyroTmp = null;
        Sensor magTmp = null;
        try {
            accelTmp = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
            gyroTmp = sm.getDefaultSensor(Sensor.TYPE_GYROSCOPE);
            magTmp = sm.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD);
        } catch (Throwable ignored) {
            // Handled below as unavailable.
        }
        final Sensor accel = accelTmp;
        final Sensor gyro = gyroTmp;
        final Sensor mag = magTmp;

        ctx.check("sensors.has_accelerometer", "sensors", () -> {
            boolean has = accel != null;
            return ProbeContext.Outcome.of(has, !has, !has ? "no accelerometer" : null);
        });

        // Sample all three concurrently for 1.5 s under a 3 s hard timeout.
        final AxisStats accelStats = new AxisStats();
        final AxisStats gyroStats = new AxisStats();
        final AxisStats magStats = new AxisStats();
        String samplingError = null;

        try {
            ProbeContext.runWithTimeout(3000, () -> {
                HandlerThread ht = new HandlerThread("pdprobe-sensors");
                ht.start();
                Handler handler = new Handler(ht.getLooper());
                List<SensorEventListener> listeners = new ArrayList<>();
                try {
                    registerSampler(sm, accel, accelStats, handler, listeners);
                    registerSampler(sm, gyro, gyroStats, handler, listeners);
                    registerSampler(sm, mag, magStats, handler, listeners);
                    if (!listeners.isEmpty()) {
                        CountDownLatch latch = new CountDownLatch(1);
                        latch.await(1500, TimeUnit.MILLISECONDS);
                    }
                } finally {
                    for (SensorEventListener l : listeners) {
                        try {
                            sm.unregisterListener(l);
                        } catch (Throwable ignored) {
                            // Best-effort cleanup.
                        }
                    }
                    ht.quitSafely();
                }
                return null;
            });
        } catch (Throwable t) {
            samplingError = ProbeContext.formatError(t);
        }

        final String finalSamplingError = samplingError;
        recordSensorSample(ctx, "sensors.sample.accelerometer", accel != null, accelStats, true, finalSamplingError);
        recordSensorSample(ctx, "sensors.sample.gyroscope", gyro != null, gyroStats, false, finalSamplingError);
        recordSensorSample(ctx, "sensors.sample.magnetometer", mag != null, magStats, false, finalSamplingError);
    }

    private static void registerSampler(
            SensorManager sm, Sensor sensor, AxisStats stats, Handler handler, List<SensorEventListener> out) {
        if (sensor == null) {
            return;
        }
        SensorEventListener listener = new SensorEventListener() {
            @Override
            public void onSensorChanged(SensorEvent event) {
                stats.add(event.values);
            }

            @Override
            public void onAccuracyChanged(Sensor sensor, int accuracy) {}
        };
        if (sm.registerListener(listener, sensor, SensorManager.SENSOR_DELAY_GAME, handler)) {
            out.add(listener);
        }
    }

    private static void recordSensorSample(
            ProbeContext ctx,
            String id,
            boolean available,
            AxisStats stats,
            boolean flagIfMissing,
            String samplingError) {
        ctx.check(id, "sensors", () -> {
            JSONObject obj = stats.toJson(available);
            List<String> reasons = new ArrayList<>();
            if (!available && flagIfMissing) {
                reasons.add("no accelerometer");
            }
            if (stats.isAllStddevZero()) {
                reasons.add("standard deviation is 0 on every axis (static sensor)");
            }
            return ProbeContext.Outcome.withError(
                    obj, !reasons.isEmpty(), ProbeContext.joinReasons(reasons), samplingError);
        });
    }

    private static String findSuspiciousSensorText(String s) {
        if (s == null || s.isEmpty()) {
            return null;
        }
        String sw = ProbeContext.findSuspiciousWord(s);
        if (sw != null) {
            return sw;
        }
        Matcher m = SENSOR_AOSP_PATTERN.matcher(s);
        return m.find() ? m.group() : null;
    }

    // -------------------------------------------------------------------------
    // gl
    // -------------------------------------------------------------------------

    private static final class GlSnapshot {
        String vendor;
        String renderer;
        String version;
        String shadingLanguageVersion;
        int extensionCount;
        String eglVendor;
        String eglVersion;
    }

    private static void runGlChecks(ProbeContext ctx) {
        GlSnapshot snap = null;
        String glError = null;
        try {
            snap = ProbeContext.runWithTimeout(3000, HardwareChecks::probeGlContext);
        } catch (Throwable t) {
            glError = ProbeContext.formatError(t);
        }

        final GlSnapshot finalSnap = snap;
        final String finalErr = glError;

        checkGlString(ctx, "gl.vendor", finalSnap != null ? finalSnap.vendor : null, true, finalErr);
        checkGlString(ctx, "gl.renderer", finalSnap != null ? finalSnap.renderer : null, true, finalErr);
        checkGlString(ctx, "gl.version", finalSnap != null ? finalSnap.version : null, false, finalErr);
        checkGlString(ctx, "gl.shading_language_version",
                finalSnap != null ? finalSnap.shadingLanguageVersion : null, false, finalErr);

        ctx.check("gl.extension_count", "gl", () -> {
            if (finalErr != null) {
                return ProbeContext.Outcome.error(finalErr);
            }
            return ProbeContext.Outcome.ok(finalSnap.extensionCount);
        });

        checkGlString(ctx, "gl.egl_vendor", finalSnap != null ? finalSnap.eglVendor : null, true, finalErr);
        checkGlString(ctx, "gl.egl_version", finalSnap != null ? finalSnap.eglVersion : null, false, finalErr);
    }

    private static void checkGlString(
            ProbeContext ctx, String id, String value, boolean checkVendorList, String err) {
        ctx.check(id, "gl", () -> {
            if (err != null) {
                return ProbeContext.Outcome.error(err);
            }
            List<String> reasons = new ArrayList<>();
            String sw = ProbeContext.findSuspiciousWord(value);
            if (sw != null) {
                reasons.add("contains '" + sw + "'");
            }
            if (checkVendorList && value != null) {
                Matcher m = GL_SUSPICIOUS_VENDOR.matcher(value);
                if (m.find()) {
                    reasons.add("matches suspicious GL string '" + m.group() + "'");
                }
            }
            return ProbeContext.Outcome.of(value, !reasons.isEmpty(), ProbeContext.joinReasons(reasons));
        });
    }

    private static GlSnapshot probeGlContext() {
        EGLDisplay display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);
        if (display == null || display == EGL14.EGL_NO_DISPLAY) {
            throw new IllegalStateException("eglGetDisplay failed");
        }
        int[] version = new int[2];
        if (!EGL14.eglInitialize(display, version, 0, version, 1)) {
            throw new IllegalStateException("eglInitialize failed: 0x" + Integer.toHexString(EGL14.eglGetError()));
        }

        EGLSurface surface = EGL14.EGL_NO_SURFACE;
        EGLContext context = EGL14.EGL_NO_CONTEXT;
        try {
            GlSnapshot snap = new GlSnapshot();
            snap.eglVendor = EGL14.eglQueryString(display, EGL14.EGL_VENDOR);
            snap.eglVersion = EGL14.eglQueryString(display, EGL14.EGL_VERSION);

            int[] configAttribs = {
                    EGL14.EGL_SURFACE_TYPE, EGL14.EGL_PBUFFER_BIT,
                    EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
                    EGL14.EGL_RED_SIZE, 8,
                    EGL14.EGL_GREEN_SIZE, 8,
                    EGL14.EGL_BLUE_SIZE, 8,
                    EGL14.EGL_ALPHA_SIZE, 8,
                    EGL14.EGL_NONE
            };
            EGLConfig[] configs = new EGLConfig[1];
            int[] numConfigs = new int[1];
            if (!EGL14.eglChooseConfig(display, configAttribs, 0, configs, 0, 1, numConfigs, 0)
                    || numConfigs[0] == 0) {
                throw new IllegalStateException("eglChooseConfig failed");
            }
            EGLConfig config = configs[0];

            int[] pbufferAttribs = {
                    EGL14.EGL_WIDTH, 1,
                    EGL14.EGL_HEIGHT, 1,
                    EGL14.EGL_NONE
            };
            surface = EGL14.eglCreatePbufferSurface(display, config, pbufferAttribs, 0);
            if (surface == null || surface == EGL14.EGL_NO_SURFACE) {
                throw new IllegalStateException("eglCreatePbufferSurface failed");
            }

            // Try ES 3 first, then ES 2.
            int[] ctx3Attribs = {EGL14.EGL_CONTEXT_CLIENT_VERSION, 3, EGL14.EGL_NONE};
            context = EGL14.eglCreateContext(display, config, EGL14.EGL_NO_CONTEXT, ctx3Attribs, 0);
            if (context == null || context == EGL14.EGL_NO_CONTEXT) {
                int[] ctx2Attribs = {EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE};
                context = EGL14.eglCreateContext(display, config, EGL14.EGL_NO_CONTEXT, ctx2Attribs, 0);
            }
            if (context == null || context == EGL14.EGL_NO_CONTEXT) {
                throw new IllegalStateException("eglCreateContext failed (ES 3 and ES 2)");
            }

            if (!EGL14.eglMakeCurrent(display, surface, surface, context)) {
                throw new IllegalStateException("eglMakeCurrent failed");
            }

            snap.vendor = GLES20.glGetString(GLES20.GL_VENDOR);
            snap.renderer = GLES20.glGetString(GLES20.GL_RENDERER);
            snap.version = GLES20.glGetString(GLES20.GL_VERSION);
            snap.shadingLanguageVersion = GLES20.glGetString(GLES20.GL_SHADING_LANGUAGE_VERSION);
            String exts = GLES20.glGetString(GLES20.GL_EXTENSIONS);
            if (exts != null && !exts.trim().isEmpty()) {
                snap.extensionCount = exts.trim().split("\\s+").length;
            } else {
                snap.extensionCount = 0;
            }
            return snap;
        } finally {
            EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT);
            if (context != null && context != EGL14.EGL_NO_CONTEXT) {
                EGL14.eglDestroyContext(display, context);
            }
            if (surface != null && surface != EGL14.EGL_NO_SURFACE) {
                EGL14.eglDestroySurface(display, surface);
            }
            EGL14.eglTerminate(display);
        }
    }

    // -------------------------------------------------------------------------
    // media
    // -------------------------------------------------------------------------

    @SuppressWarnings("deprecation")
    private static void runMediaChecks(ProbeContext ctx) {
        MediaCodecInfo[] codecInfos = null;
        String codecErr = null;
        try {
            MediaCodecList list = new MediaCodecList(MediaCodecList.ALL_CODECS);
            codecInfos = list.getCodecInfos();
        } catch (Throwable t) {
            codecErr = ProbeContext.formatError(t);
        }

        final MediaCodecInfo[] infos = codecInfos;
        final String finalCodecErr = codecErr;

        ctx.check("media.codecs", "media", () -> {
            if (finalCodecErr != null) {
                return ProbeContext.Outcome.error(finalCodecErr);
            }
            JSONArray arr = new JSONArray();
            List<String> suspiciousNames = new ArrayList<>();
            for (MediaCodecInfo info : infos) {
                JSONObject o = new JSONObject();
                String name = info.getName();
                o.put("name", name);
                o.put("isEncoder", info.isEncoder());
                JSONArray types = new JSONArray();
                for (String t : info.getSupportedTypes()) {
                    types.put(t);
                }
                o.put("types", types);
                if (Build.VERSION.SDK_INT >= 29) {
                    o.put("hardwareAccelerated", info.isHardwareAccelerated());
                    o.put("softwareOnly", info.isSoftwareOnly());
                    o.put("vendor", info.isVendor());
                } else {
                    o.put("hardwareAccelerated", JSONObject.NULL);
                    o.put("softwareOnly", JSONObject.NULL);
                    o.put("vendor", JSONObject.NULL);
                }
                arr.put(o);

                String lower = name == null ? "" : name.toLowerCase(Locale.US);
                if (lower.contains("goldfish") || lower.contains("ranchu")
                        || ProbeContext.findSuspiciousWord(name) != null) {
                    suspiciousNames.add(name);
                }
            }
            return ProbeContext.Outcome.of(
                    arr,
                    !suspiciousNames.isEmpty(),
                    !suspiciousNames.isEmpty() ? "suspicious codec(s): " + suspiciousNames : null
            );
        });

        ctx.check("media.hw_decoders_count", "media", () -> {
            if (finalCodecErr != null) {
                return ProbeContext.Outcome.error(finalCodecErr);
            }
            if (Build.VERSION.SDK_INT < 29) {
                return ProbeContext.Outcome.error("requires API 29 for isHardwareAccelerated()");
            }
            int count = 0;
            for (MediaCodecInfo info : infos) {
                if (!info.isEncoder() && info.isHardwareAccelerated()) {
                    count++;
                }
            }
            return ProbeContext.Outcome.ok(count);
        });

        ctx.check("media.hw_encoders_count", "media", () -> {
            if (finalCodecErr != null) {
                return ProbeContext.Outcome.error(finalCodecErr);
            }
            if (Build.VERSION.SDK_INT < 29) {
                return ProbeContext.Outcome.error("requires API 29 for isHardwareAccelerated()");
            }
            int count = 0;
            for (MediaCodecInfo info : infos) {
                if (info.isEncoder() && info.isHardwareAccelerated()) {
                    count++;
                }
            }
            return ProbeContext.Outcome.ok(count);
        });

        ctx.check("media.hw_video_codecs_count", "media", () -> {
            if (finalCodecErr != null) {
                return ProbeContext.Outcome.error(finalCodecErr);
            }
            if (Build.VERSION.SDK_INT < 29) {
                return ProbeContext.Outcome.error("requires API 29 for isHardwareAccelerated()");
            }
            int count = 0;
            for (MediaCodecInfo info : infos) {
                if (info.isHardwareAccelerated() && hasVideoType(info)) {
                    count++;
                }
            }
            return ProbeContext.Outcome.of(count, count == 0, count == 0 ? "zero hardware-accelerated video codecs" : null);
        });

        ctx.check("media.video_avc_encoders", "media", () -> {
            if (finalCodecErr != null) {
                return ProbeContext.Outcome.error(finalCodecErr);
            }
            return findEncodersForMime(infos, "video/avc");
        });

        ctx.check("media.video_hevc_encoders", "media", () -> {
            if (finalCodecErr != null) {
                return ProbeContext.Outcome.error(finalCodecErr);
            }
            return findEncodersForMime(infos, "video/hevc");
        });

        // MediaDrm Widevine with 3s timeout
        ctx.check("media.drm.widevine", "media", () -> ProbeContext.runWithTimeout(3000, () -> {
            MediaDrm drm = new MediaDrm(WIDEVINE_UUID);
            try {
                JSONObject o = new JSONObject();
                String vendor = safeDrmProp(drm, MediaDrm.PROPERTY_VENDOR);
                String version = safeDrmProp(drm, MediaDrm.PROPERTY_VERSION);
                String securityLevel = safeDrmProp(drm, "securityLevel");
                String systemId = safeDrmProp(drm, "systemId");
                o.put("vendor", vendor == null ? JSONObject.NULL : vendor);
                o.put("version", version == null ? JSONObject.NULL : version);
                o.put("securityLevel", securityLevel == null ? JSONObject.NULL : securityLevel);
                o.put("systemId", systemId == null ? JSONObject.NULL : systemId);
                boolean isL3 = "L3".equalsIgnoreCase(securityLevel);
                return ProbeContext.Outcome.of(o, isL3, isL3 ? "Widevine securityLevel is L3" : null);
            } finally {
                if (Build.VERSION.SDK_INT >= 28) {
                    drm.close();
                } else {
                    drm.release();
                }
            }
        }));
    }

    private static boolean hasVideoType(MediaCodecInfo info) {
        for (String t : info.getSupportedTypes()) {
            if (t != null && t.toLowerCase(Locale.US).startsWith("video/")) {
                return true;
            }
        }
        return false;
    }

    private static ProbeContext.Outcome findEncodersForMime(MediaCodecInfo[] infos, String mime) throws Exception {
        JSONArray names = new JSONArray();
        for (MediaCodecInfo info : infos) {
            if (!info.isEncoder()) {
                continue;
            }
            for (String t : info.getSupportedTypes()) {
                if (mime.equalsIgnoreCase(t)) {
                    names.put(info.getName());
                    break;
                }
            }
        }
        JSONObject o = new JSONObject();
        o.put("exists", names.length() > 0);
        o.put("names", names);
        return ProbeContext.Outcome.ok(o);
    }

    private static String safeDrmProp(MediaDrm drm, String key) {
        try {
            return drm.getPropertyString(key);
        } catch (Throwable t) {
            return "ERROR: " + ProbeContext.formatError(t);
        }
    }

    // -------------------------------------------------------------------------
    // keystore
    // -------------------------------------------------------------------------

    private static final class KeystoreSnapshot {
        boolean succeeded;
        int chainLength;
        String rootSubject;
        String rootSha256;
        String securityLevel;
        boolean softwareBacked;
        String error;
    }

    @SuppressWarnings("deprecation")
    private static void runKeystoreChecks(ProbeContext ctx) {
        KeystoreSnapshot snap;
        try {
            snap = ProbeContext.runWithTimeout(3000, HardwareChecks::probeKeystoreAttestation);
        } catch (Throwable t) {
            snap = new KeystoreSnapshot();
            snap.succeeded = false;
            snap.error = ProbeContext.formatError(t);
        }

        final KeystoreSnapshot s = snap;

        ctx.check("keystore.attestation.succeeded", "keystore", () -> {
            if (!s.succeeded) {
                return ProbeContext.Outcome.withError(
                        false,
                        true,
                        "key attestation generation failed" + (s.error != null ? ": " + s.error : ""),
                        s.error
                );
            }
            return ProbeContext.Outcome.ok(true);
        });

        ctx.check("keystore.attestation.chain_length", "keystore", () -> {
            if (!s.succeeded) {
                return ProbeContext.Outcome.error(s.error);
            }
            boolean shortChain = s.chainLength < 2;
            return ProbeContext.Outcome.of(
                    s.chainLength,
                    shortChain,
                    shortChain ? "certificate chain length < 2 (" + s.chainLength + ")" : null
            );
        });

        ctx.check("keystore.attestation.root_subject", "keystore", () -> {
            if (!s.succeeded) {
                return ProbeContext.Outcome.error(s.error);
            }
            return ProbeContext.Outcome.ok(s.rootSubject);
        });

        ctx.check("keystore.attestation.root_sha256", "keystore", () -> {
            if (!s.succeeded) {
                return ProbeContext.Outcome.error(s.error);
            }
            return ProbeContext.Outcome.ok(s.rootSha256);
        });

        ctx.check("keystore.attestation.security_level", "keystore", () -> {
            if (!s.succeeded) {
                return ProbeContext.Outcome.error(s.error);
            }
            return ProbeContext.Outcome.of(
                    s.securityLevel,
                    s.softwareBacked,
                    s.softwareBacked ? "key is software-backed (" + s.securityLevel + ")" : null
            );
        });
    }

    @SuppressWarnings("deprecation")
    private static KeystoreSnapshot probeKeystoreAttestation() throws Exception {
        KeystoreSnapshot snap = new KeystoreSnapshot();
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        try {
            if (ks.containsAlias(ATTEST_ALIAS)) {
                ks.deleteEntry(ATTEST_ALIAS);
            }
            KeyPairGenerator kpg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
            KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
                    ATTEST_ALIAS,
                    KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY
            )
                    .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    .setAttestationChallenge("pd-probe-challenge".getBytes(StandardCharsets.UTF_8))
                    .build();
            kpg.initialize(spec);
            KeyPair kp = kpg.generateKeyPair();
            snap.succeeded = true;

            Certificate[] chain = ks.getCertificateChain(ATTEST_ALIAS);
            if (chain != null && chain.length > 0) {
                snap.chainLength = chain.length;
                Certificate root = chain[chain.length - 1];
                if (root instanceof X509Certificate) {
                    snap.rootSubject = ((X509Certificate) root).getSubjectX500Principal().getName();
                }
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                byte[] digest = md.digest(root.getEncoded());
                snap.rootSha256 = toHex(digest);
            }

            PrivateKey priv = kp.getPrivate();
            KeyFactory kf = KeyFactory.getInstance(priv.getAlgorithm(), "AndroidKeyStore");
            KeyInfo keyInfo = kf.getKeySpec(priv, KeyInfo.class);
            if (Build.VERSION.SDK_INT >= 31) {
                int level = keyInfo.getSecurityLevel();
                snap.securityLevel = securityLevelName(level);
                snap.softwareBacked = (level == KeyProperties.SECURITY_LEVEL_SOFTWARE);
            } else {
                boolean hw = keyInfo.isInsideSecureHardware();
                snap.securityLevel = hw ? "SECURE_HARDWARE" : "SOFTWARE";
                snap.softwareBacked = !hw;
            }
            return snap;
        } finally {
            try {
                if (ks.containsAlias(ATTEST_ALIAS)) {
                    ks.deleteEntry(ATTEST_ALIAS);
                }
            } catch (Throwable ignored) {
                // Best-effort delete.
            }
        }
    }

    private static String securityLevelName(int level) {
        if (Build.VERSION.SDK_INT >= 31) {
            switch (level) {
                case KeyProperties.SECURITY_LEVEL_SOFTWARE: return "SOFTWARE";
                case KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT: return "TRUSTED_ENVIRONMENT";
                case KeyProperties.SECURITY_LEVEL_STRONGBOX: return "STRONGBOX";
                case KeyProperties.SECURITY_LEVEL_UNKNOWN_SECURE: return "UNKNOWN_SECURE";
                case KeyProperties.SECURITY_LEVEL_UNKNOWN: return "UNKNOWN";
                default: return "LEVEL(" + level + ")";
            }
        }
        return "LEVEL(" + level + ")";
    }

    private static String toHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(String.format(Locale.US, "%02x", b & 0xff));
        }
        return sb.toString();
    }

    // -------------------------------------------------------------------------
    // battery
    // -------------------------------------------------------------------------

    private static void runBatteryChecks(ProbeContext ctx) {
        Intent sticky = null;
        String stickyErr = null;
        int levelTmp = -1;
        int scaleTmp = -1;
        int statusTmp = -1;
        int pluggedTmp = -1;
        int healthTmp = -1;
        int tempTmp = Integer.MIN_VALUE;
        int voltageTmp = Integer.MIN_VALUE;
        String techTmp = null;
        boolean presentTmp = false;
        try {
            sticky = ctx.appContext.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (sticky != null) {
                levelTmp = sticky.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
                scaleTmp = sticky.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
                statusTmp = sticky.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
                pluggedTmp = sticky.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1);
                healthTmp = sticky.getIntExtra(BatteryManager.EXTRA_HEALTH, -1);
                tempTmp = sticky.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Integer.MIN_VALUE);
                voltageTmp = sticky.getIntExtra(BatteryManager.EXTRA_VOLTAGE, Integer.MIN_VALUE);
                techTmp = sticky.getStringExtra(BatteryManager.EXTRA_TECHNOLOGY);
                presentTmp = sticky.getBooleanExtra(BatteryManager.EXTRA_PRESENT, false);
            } else {
                stickyErr = "sticky ACTION_BATTERY_CHANGED intent is null";
            }
        } catch (Throwable t) {
            stickyErr = ProbeContext.formatError(t);
        }

        final String err = stickyErr;
        final int level = levelTmp;
        final int scale = scaleTmp;
        final int status = statusTmp;
        final int plugged = pluggedTmp;
        final int health = healthTmp;
        final int temp = tempTmp;
        final int voltage = voltageTmp;
        final String tech = techTmp;
        final boolean present = presentTmp;

        ctx.check("battery.level", "battery", () -> err != null ? ProbeContext.Outcome.error(err) : ProbeContext.Outcome.ok(level));
        ctx.check("battery.scale", "battery", () -> err != null ? ProbeContext.Outcome.error(err) : ProbeContext.Outcome.ok(scale));
        ctx.check("battery.status", "battery", () -> err != null ? ProbeContext.Outcome.error(err) : ProbeContext.Outcome.ok(batteryStatusName(status)));
        ctx.check("battery.plugged", "battery", () -> err != null ? ProbeContext.Outcome.error(err) : ProbeContext.Outcome.ok(batteryPluggedName(plugged)));
        ctx.check("battery.health", "battery", () -> err != null ? ProbeContext.Outcome.error(err) : ProbeContext.Outcome.ok(batteryHealthName(health)));

        ctx.check("battery.temperature", "battery", () -> {
            if (err != null) return ProbeContext.Outcome.error(err);
            boolean flag = (temp == 0);
            return ProbeContext.Outcome.of(temp, flag, flag ? "battery temperature is 0" : null);
        });

        ctx.check("battery.voltage", "battery", () -> {
            if (err != null) return ProbeContext.Outcome.error(err);
            boolean flag = (voltage == 0 || voltage == 5000);
            String why = voltage == 0 ? "battery voltage is 0" : (voltage == 5000 ? "battery voltage is exactly 5000 mV" : null);
            return ProbeContext.Outcome.of(voltage, flag, why);
        });

        ctx.check("battery.technology", "battery", () -> {
            if (err != null) return ProbeContext.Outcome.error(err);
            boolean flag = (tech == null || tech.isEmpty() || "Unknown".equalsIgnoreCase(tech));
            return ProbeContext.Outcome.of(tech, flag, flag ? "battery technology is empty or Unknown" : null);
        });

        ctx.check("battery.present", "battery", () -> err != null ? ProbeContext.Outcome.error(err) : ProbeContext.Outcome.ok(present));

        ctx.check("battery.ac_full_unknown_health", "battery", () -> {
            if (err != null) return ProbeContext.Outcome.error(err);
            int pct = (scale > 0 && level >= 0) ? (level * 100 / scale) : level;
            boolean match = (pct == 100)
                    && (plugged == BatteryManager.BATTERY_PLUGGED_AC)
                    && (health == BatteryManager.BATTERY_HEALTH_UNKNOWN);
            JSONObject o = new JSONObject();
            o.put("level", level);
            o.put("scale", scale);
            o.put("plugged", batteryPluggedName(plugged));
            o.put("health", batteryHealthName(health));
            return ProbeContext.Outcome.of(o, match, match ? "level 100 while AC-plugged with unknown health" : null);
        });

        final BatteryManager bm = (BatteryManager) ctx.appContext.getSystemService(Context.BATTERY_SERVICE);
        if (bm == null) {
            ctx.add("battery.manager", "battery", ProbeContext.Outcome.error("BatteryManager is null"));
            return;
        }

        ctx.check("battery.prop.capacity", "battery", () ->
                ProbeContext.Outcome.ok(bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)));
        ctx.check("battery.prop.charge_counter", "battery", () ->
                ProbeContext.Outcome.ok(bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER)));
        ctx.check("battery.prop.current_now", "battery", () -> {
            int cur = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW);
            boolean zero = (cur == 0);
            return ProbeContext.Outcome.of(cur, zero, zero ? "battery current_now is exactly 0" : null);
        });
        ctx.check("battery.prop.current_average", "battery", () ->
                ProbeContext.Outcome.ok(bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_AVERAGE)));
    }

    private static String batteryStatusName(int s) {
        switch (s) {
            case BatteryManager.BATTERY_STATUS_CHARGING: return "CHARGING";
            case BatteryManager.BATTERY_STATUS_DISCHARGING: return "DISCHARGING";
            case BatteryManager.BATTERY_STATUS_FULL: return "FULL";
            case BatteryManager.BATTERY_STATUS_NOT_CHARGING: return "NOT_CHARGING";
            case BatteryManager.BATTERY_STATUS_UNKNOWN: return "UNKNOWN";
            default: return "STATUS(" + s + ")";
        }
    }

    private static String batteryPluggedName(int p) {
        switch (p) {
            case 0: return "NONE";
            case BatteryManager.BATTERY_PLUGGED_AC: return "AC";
            case BatteryManager.BATTERY_PLUGGED_USB: return "USB";
            case BatteryManager.BATTERY_PLUGGED_WIRELESS: return "WIRELESS";
            default: return "PLUGGED(" + p + ")";
        }
    }

    private static String batteryHealthName(int h) {
        switch (h) {
            case BatteryManager.BATTERY_HEALTH_GOOD: return "GOOD";
            case BatteryManager.BATTERY_HEALTH_OVERHEAT: return "OVERHEAT";
            case BatteryManager.BATTERY_HEALTH_DEAD: return "DEAD";
            case BatteryManager.BATTERY_HEALTH_OVER_VOLTAGE: return "OVER_VOLTAGE";
            case BatteryManager.BATTERY_HEALTH_UNSPECIFIED_FAILURE: return "UNSPECIFIED_FAILURE";
            case BatteryManager.BATTERY_HEALTH_COLD: return "COLD";
            case BatteryManager.BATTERY_HEALTH_UNKNOWN: return "UNKNOWN";
            default: return "HEALTH(" + h + ")";
        }
    }
}
