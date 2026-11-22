package dev.phonedock.probe;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Typeface;
import android.os.Bundle;
import android.util.Log;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Main launcher activity: runs all device probes on a background thread and records touch/key events.
 */
public final class ProbeActivity extends Activity {

    private static final int MAX_TOUCH_EVENTS = 400;

    private TextView reportView;

    private final ExecutorService probeExecutor = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "pdprobe-runner");
        t.setDaemon(true);
        return t;
    });

    private final ExecutorService touchWriterExecutor = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "pdprobe-touch-writer");
        t.setDaemon(true);
        return t;
    });

    private final Object touchLock = new Object();
    private final List<JSONObject> recordedEvents = new ArrayList<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        ScrollView scroll = new ScrollView(this);
        reportView = new TextView(this);
        reportView.setTypeface(Typeface.MONOSPACE);
        reportView.setTextSize(12f);
        int pad = Math.round(12f * getResources().getDisplayMetrics().density);
        reportView.setPadding(pad, pad, pad, pad);
        reportView.setTextIsSelectable(true);
        reportView.setText("pd-probe: running checks...");
        scroll.addView(reportView);
        setContentView(scroll);

        triggerProbeRun();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (reportView != null) {
            reportView.setText("pd-probe: re-running checks...");
        }
        triggerProbeRun();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        probeExecutor.shutdownNow();
        touchWriterExecutor.shutdown();
    }

    private void triggerProbeRun() {
        probeExecutor.execute(() -> {
            final ProbeRunner.RunOutput output = ProbeRunner.runAndWrite(getApplicationContext());
            runOnUiThread(() -> {
                if (!isFinishing() && !isDestroyed() && reportView != null) {
                    reportView.setText(output.displayText);
                }
            });
        });
    }

    @Override
    public boolean dispatchTouchEvent(MotionEvent ev) {
        if (ev != null) {
            recordMotionEvent(ev);
        }
        return super.dispatchTouchEvent(ev);
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event != null) {
            recordKeyEvent(event);
        }
        return super.dispatchKeyEvent(event);
    }

    private void recordMotionEvent(MotionEvent ev) {
        try {
            JSONObject obj = new JSONObject();
            obj.put("kind", "motion");
            obj.put("action", MotionEvent.actionToString(ev.getAction()));
            obj.put("x", ProbeContext.safeNumber(ev.getX()));
            obj.put("y", ProbeContext.safeNumber(ev.getY()));
            obj.put("pressure", ProbeContext.safeNumber(ev.getPressure()));
            obj.put("size", ProbeContext.safeNumber(ev.getSize()));
            obj.put("touchMajor", ProbeContext.safeNumber(ev.getTouchMajor()));
            int toolType = ev.getPointerCount() > 0 ? ev.getToolType(0) : MotionEvent.TOOL_TYPE_UNKNOWN;
            obj.put("toolType", toolTypeName(toolType));
            obj.put("source", String.format(Locale.US, "0x%x", ev.getSource()));
            int devId = ev.getDeviceId();
            obj.put("deviceId", devId);
            InputDevice dev = InputDevice.getDevice(devId);
            obj.put("deviceName", dev != null ? dev.getName() : JSONObject.NULL);
            obj.put("flags", String.format(Locale.US, "0x%x", ev.getFlags()));
            obj.put("buttonState", ev.getButtonState());
            obj.put("durationMs", ev.getEventTime() - ev.getDownTime());

            int masked = ev.getActionMasked();
            boolean shouldFlush = (masked == MotionEvent.ACTION_UP || masked == MotionEvent.ACTION_CANCEL);
            appendAndMaybeFlush(obj, shouldFlush);
        } catch (Throwable ignored) {
            // Never crash on touch recording.
        }
    }

    private void recordKeyEvent(KeyEvent event) {
        try {
            JSONObject obj = new JSONObject();
            obj.put("kind", "key");
            obj.put("action", keyActionName(event.getAction()));
            obj.put("keyCode", event.getKeyCode());
            obj.put("keyName", KeyEvent.keyCodeToString(event.getKeyCode()));
            obj.put("scanCode", event.getScanCode());
            int devId = event.getDeviceId();
            obj.put("deviceId", devId);
            InputDevice dev = InputDevice.getDevice(devId);
            obj.put("deviceName", dev != null ? dev.getName() : JSONObject.NULL);
            obj.put("source", String.format(Locale.US, "0x%x", event.getSource()));
            obj.put("flags", String.format(Locale.US, "0x%x", event.getFlags()));

            boolean shouldFlush = (event.getAction() == KeyEvent.ACTION_UP);
            appendAndMaybeFlush(obj, shouldFlush);
        } catch (Throwable ignored) {
            // Never crash on key recording.
        }
    }

    private void appendAndMaybeFlush(JSONObject eventObj, boolean shouldFlush) {
        final List<JSONObject> snapshot;
        final int count;
        synchronized (touchLock) {
            if (recordedEvents.size() >= MAX_TOUCH_EVENTS) {
                recordedEvents.remove(0);
            }
            recordedEvents.add(eventObj);
            if (!shouldFlush) {
                return;
            }
            count = recordedEvents.size();
            snapshot = new ArrayList<>(recordedEvents);
        }

        final File outFile = new File(ProbeContext.getReportDir(getApplicationContext()), "touch.json");
        touchWriterExecutor.execute(() -> {
            try {
                JSONObject root = new JSONObject();
                root.put("v", 1);
                root.put("count", count);
                JSONArray arr = new JSONArray();
                for (JSONObject item : snapshot) {
                    arr.put(item);
                }
                root.put("events", arr);
                ProbeRunner.writeAtomic(outFile, root.toString(2));
                Log.i(ProbeRunner.TAG, "touch events=" + count);
            } catch (Throwable ignored) {
                // Never crash on background write.
            }
        });
    }

    private static String toolTypeName(int toolType) {
        switch (toolType) {
            case MotionEvent.TOOL_TYPE_FINGER: return "FINGER";
            case MotionEvent.TOOL_TYPE_STYLUS: return "STYLUS";
            case MotionEvent.TOOL_TYPE_MOUSE: return "MOUSE";
            case MotionEvent.TOOL_TYPE_ERASER: return "ERASER";
            case MotionEvent.TOOL_TYPE_UNKNOWN: return "UNKNOWN";
            default: return "TOOL(" + toolType + ")";
        }
    }

    @SuppressWarnings("deprecation")
    private static String keyActionName(int action) {
        switch (action) {
            case KeyEvent.ACTION_DOWN: return "ACTION_DOWN";
            case KeyEvent.ACTION_UP: return "ACTION_UP";
            case KeyEvent.ACTION_MULTIPLE: return "ACTION_MULTIPLE";
            default: return "ACTION(" + action + ")";
        }
    }
}
