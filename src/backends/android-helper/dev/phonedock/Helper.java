package dev.phonedock;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.InputEvent;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityWindowInfo;
import android.content.res.AssetManager;
import android.content.res.Resources;
import android.content.res.XmlResourceParser;
import android.graphics.Point;
import android.graphics.Rect;
import android.view.Display;
import android.view.accessibility.AccessibilityNodeInfo;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.xmlpull.v1.XmlPullParser;

/** PhoneDock's on-device helper, run with app_process from /data/local/tmp (never installed as an app).
 *  ui [idleExitSec]   persistent; reads one command per line on stdin:
 *    dump <quietMs> <timeoutMs> [all] →"PDOK <bytes> <idle 0|1> <msSinceLastEvent>\n<xml>" or "PDERR <message>\n".
 *        The XML is the platform uiautomator.jar's (same as `uiautomator dump`), one top-level <node> per dumped
 *        window: the window with input focus and the top application window (getWindows(), interactive windows
 *        retrieved), then <pd-hints> (fields showing their hint) and <pd-windows> (every window on the default
 *        display: type, layer, focus, bounds, package, title, the index of its dumped root, a few texts).
 *    in <seq> <verb> <args…>     → "PDIN <seq> <sent|notsent|unknown> <ms> [detail]\n". Input injected through
 *        the input manager (UiAutomation if refused), each command exactly once: tap x y | dtap x y | press x y ms | swipe x1 y1 x2 y2 ms holdMs |
 *        key <KEYCODE_…|number> | text <base64 utf-8> (characters the virtual keyboard map can type; else notsent).
 *        notsent = nothing was injected; unknown = an injection failed after the first was attempted.
 *    Dumps and inputs run on separate threads (an input never waits behind a dump's quiet wait); replies to inputs
 *    are matched by <seq>, dump replies come in order.
 *  labels <apk>...    one-shot: prints "<apk>\t<label>" per APK (empty label when unknown). */
public final class Helper {
  private static final String ANDROID_NS = "http://schemas.android.com/apk/res/android";
  private static final int ATTR_LABEL = 0x01010001; // android.R.attr.label
  private static volatile long lastCommand = System.currentTimeMillis();
  private static final Object OUT_LOCK = new Object();
  private static OutputStream out;
  private static UiAutomation ua;
  private static Method inject3;          // injectInputEvent(InputEvent, boolean sync, boolean waitForAnimations), API 34+
  // The input manager's own injectInputEvent(InputEvent, int mode), as `cmd input` and scrcpy use it (the shell uid
  // holds INJECT_EVENTS; app_process code is not subject to hidden-API checks). UiAutomation's injection also syncs
  // window transactions before each DOWN and after each UP, which cost ~8 ms per event on the emulator, so it is
  // only the fallback.
  private static Object im;
  private static Method imInject;
  private static final int MODE_ASYNC = 0, MODE_WAIT_FOR_FINISH = 2;
  private static final long[] lastEvent = { 0 };

  public static void main(String[] args) throws Throwable {
    String mode = args.length > 0 ? args[0] : "";
    if (mode.equals("labels")) { labels(args); return; }
    if (mode.equals("ui")) { ui(args.length > 1 ? Integer.parseInt(args[1]) : 30); return; }
    System.err.println("usage: ui [idleExitSec] | labels <apk>...");
    System.exit(2);
  }

  // ── labels ──────────────────────────────────────────────────────────────────
  private static void labels(String[] args) {
    Resources sys = Resources.getSystem();
    StringBuilder sb = new StringBuilder();
    for (int i = 1; i < args.length; i++) {
      String label = "";
      try { label = labelOf(args[i], sys); } catch (Throwable t) { /* unknown */ }
      sb.append(args[i]).append('\t').append(label.replace('\t', ' ').replace('\n', ' ').replace('\r', ' ')).append('\n');
    }
    System.out.print(sb);
    System.out.flush();
  }

  private static String labelOf(String apk, Resources sys) throws Exception {
    AssetManager am = AssetManager.class.getDeclaredConstructor().newInstance();
    try {
      int cookie = (Integer) AssetManager.class.getMethod("addAssetPath", String.class).invoke(am, apk);
      if (cookie == 0) return "";
      Resources res = new Resources(am, sys.getDisplayMetrics(), sys.getConfiguration());
      XmlResourceParser p = am.openXmlResourceParser(cookie, "AndroidManifest.xml");
      try {
        for (int ev = p.next(); ev != XmlPullParser.END_DOCUMENT; ev = p.next()) {
          if (ev != XmlPullParser.START_TAG || !"application".equals(p.getName())) continue;
          for (int i = 0; i < p.getAttributeCount(); i++) {
            if (p.getAttributeNameResource(i) != ATTR_LABEL && !"label".equals(p.getAttributeName(i))) continue;
            int id = p.getAttributeResourceValue(i, 0);
            if (id != 0) { CharSequence cs = res.getText(id); return cs == null ? "" : cs.toString(); }
            String v = p.getAttributeValue(i);
            return v == null ? "" : v;
          }
          return "";
        }
      } finally { p.close(); }
    } finally { am.close(); }
    return "";
  }

  // ── ui ──────────────────────────────────────────────────────────────────────
  private static void ui(final int idleExitSec) throws Throwable {
    out = new FileOutputStream(FileDescriptor.out);
    Class<?> wc = Class.forName("com.android.uiautomator.core.UiAutomationShellWrapper");
    Object wrapper = wc.getDeclaredConstructor().newInstance();
    wc.getMethod("connect").invoke(wrapper);
    ExecutorService dumps = Executors.newSingleThreadExecutor();
    ExecutorService inputs = Executors.newSingleThreadExecutor();
    try {
      try { wc.getMethod("setCompressedLayoutHierarchy", boolean.class).invoke(wrapper, false); } catch (NoSuchMethodException e) { /* old */ }
      ua = (UiAutomation) wc.getMethod("getUiAutomation").invoke(wrapper);
      // Track accessibility events ourselves: the quiet wait must see every event (all types), and it must not
      // depend on UiAutomation.waitForIdle, which only counts events delivered to a listener on newer releases.
      // getWindows() needs the interactive windows flag.
      try {
        AccessibilityServiceInfo info = ua.getServiceInfo();
        info.eventTypes = AccessibilityEvent.TYPES_ALL_MASK;
        info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
        ua.setServiceInfo(info);
      } catch (Throwable t) { /* keep the defaults */ }
      try { inject3 = UiAutomation.class.getMethod("injectInputEvent", InputEvent.class, boolean.class, boolean.class); } catch (Throwable t) { inject3 = null; }
      try {
        Class<?> c;
        try { c = Class.forName("android.hardware.input.InputManagerGlobal"); }   // API 34+
        catch (ClassNotFoundException e) { c = Class.forName("android.hardware.input.InputManager"); }
        Method m = c.getMethod("injectInputEvent", InputEvent.class, int.class);
        im = c.getMethod("getInstance").invoke(null);
        imInject = im != null ? m : null;
      } catch (Throwable t) { im = null; imInject = null; }
      lastEvent[0] = SystemClock.uptimeMillis();
      ua.setOnAccessibilityEventListener(e -> {
        synchronized (lastEvent) { lastEvent[0] = SystemClock.uptimeMillis(); lastEvent.notifyAll(); }
      });
      Method dumpM = null;
      for (Method m : Class.forName("com.android.uiautomator.core.AccessibilityNodeInfoDumper").getMethods()) {
        if (m.getName().equals("dumpWindowToFile") && m.getParameterTypes().length == 5) dumpM = m;
      }
      if (dumpM == null) throw new IllegalStateException("AccessibilityNodeInfoDumper.dumpWindowToFile not found");
      final Method dump = dumpM;
      // Safety net: exit when nobody has asked for a while, even if the host side never closes stdin.
      Thread watchdog = new Thread(() -> {
        while (true) {
          try { Thread.sleep(1000); } catch (InterruptedException e) { return; }
          if (System.currentTimeMillis() - lastCommand > idleExitSec * 1000L) { System.exit(0); }
        }
      });
      watchdog.setDaemon(true);
      watchdog.start();
      final File tmp = new File("/data/local/tmp/phonedock-ui-" + android.os.Process.myPid() + ".xml");
      write("PDREADY\n".getBytes(StandardCharsets.UTF_8));
      BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
      String line;
      while ((line = in.readLine()) != null) {
        lastCommand = System.currentTimeMillis();
        final String[] a = line.trim().split("\\s+");
        if (a.length > 0 && a[0].equals("dump")) {
          final long quiet = a.length > 1 ? Long.parseLong(a[1]) : 1000, timeout = a.length > 2 ? Long.parseLong(a[2]) : 10000;
          final boolean every = a.length > 3 && a[3].equals("all");   // diagnostics: dump every window
          dumps.execute(() -> doDump(dump, tmp, quiet, timeout, every));
        } else if (a.length > 2 && a[0].equals("in")) {
          inputs.execute(() -> doInput(a));
        } else {
          write("PDERR unknown command\n".getBytes(StandardCharsets.UTF_8));
        }
      }
      // stdin closed: the host has gone. Inputs it queued and we never started are not sent at all.
      inputs.shutdownNow();
      dumps.shutdown();
      inputs.awaitTermination(5, TimeUnit.SECONDS);
      dumps.awaitTermination(5, TimeUnit.SECONDS);
    } finally {
      try { wc.getMethod("disconnect").invoke(wrapper); } catch (Throwable t) { /* exiting */ }
    }
    System.exit(0);
  }

  private static void doDump(Method dump, File tmp, long quiet, long timeout, boolean every) {
    try {
      boolean idle = waitQuiet(quiet, timeout);
      long sinceEvent;
      synchronized (lastEvent) { sinceEvent = SystemClock.uptimeMillis() - lastEvent[0]; }
      clearCache(ua);
      int rotation = 0, width = 0, height = 0;
      try {
        Class<?> dmg = Class.forName("android.hardware.display.DisplayManagerGlobal");
        Object g = dmg.getMethod("getInstance").invoke(null);
        Display d = (Display) dmg.getMethod("getRealDisplay", int.class).invoke(g, Display.DEFAULT_DISPLAY);
        Point size = new Point(); d.getRealSize(size);
        rotation = d.getRotation(); width = size.x; height = size.y;
      } catch (Throwable t) { /* rotation 0 */ }
      List<AccessibilityNodeInfo> roots = new ArrayList<>();
      StringBuilder wins = new StringBuilder();
      try { describeWindows(roots, wins, every); } catch (Throwable t) { roots.clear(); wins.setLength(0); }
      if (roots.isEmpty()) {
        AccessibilityNodeInfo r = ua.getRootInActiveWindow();
        if (r == null) { write("PDERR null root node\n".getBytes(StandardCharsets.UTF_8)); return; }
        roots.add(r);
        wins.setLength(0);   // without window roots the list can't say which root is which
      }
      String head = null; StringBuilder body = new StringBuilder(); StringBuilder hints = new StringBuilder("<pd-hints>");
      int got = 0;
      for (AccessibilityNodeInfo r : roots) {
        String s = "";
        try {
          dump.invoke(null, r, tmp, rotation, width, height);
          s = new String(readAll(tmp), StandardCharsets.UTF_8);
        } catch (Throwable t) { if (roots.size() == 1) throw t; }
        tmp.delete();
        int open = s.indexOf("<hierarchy"), openEnd = open < 0 ? -1 : s.indexOf('>', open), close = s.lastIndexOf("</hierarchy>");
        // one top-level <node> per root, always: the window list refers to roots by position
        if (open < 0 || openEnd < 0 || close < openEnd) { body.append("<node index=\"0\" bounds=\"[0,0][0,0]\"/>"); continue; }
        if (head == null) head = s.substring(0, openEnd + 1);
        body.append(s, openEnd + 1, close);
        collectHints(r, hints, 0);
        got++;
      }
      if (head == null || got == 0) { write("PDERR empty dump\n".getBytes(StandardCharsets.UTF_8)); return; }
      hints.append("</pd-hints>");
      String xmlStr = head + body + hints + (wins.length() > 0 ? "<pd-windows>" + wins + "</pd-windows>" : "") + "</hierarchy>";
      byte[] xml = xmlStr.getBytes(StandardCharsets.UTF_8);
      ByteArrayOutputStream msg = new ByteArrayOutputStream(xml.length + 32);
      msg.write(("PDOK " + xml.length + " " + (idle ? 1 : 0) + " " + sinceEvent + "\n").getBytes(StandardCharsets.UTF_8));
      msg.write(xml);
      write(msg.toByteArray());
    } catch (Throwable t) {
      Throwable c = t.getCause() != null ? t.getCause() : t;
      try { write(("PDERR " + String.valueOf(c).replace('\n', ' ') + "\n").getBytes(StandardCharsets.UTF_8)); } catch (Throwable t2) { /* host gone */ }
    }
  }

  /** Every window of the default display as <pd-window/> (top layer first), and the roots to dump: the window with
   *  input focus (unless it is the keyboard), the active one, and the top application window (not picture-in-picture).
   *  The host decides which of them is the screen the user is using. */
  private static void describeWindows(List<AccessibilityNodeInfo> roots, StringBuilder sb, boolean every) {
    List<AccessibilityWindowInfo> all = ua.getWindows();
    if (all == null || all.isEmpty()) return;
    List<AccessibilityWindowInfo> ws = new ArrayList<>(all);
    Collections.sort(ws, (p, q) -> Integer.compare(q.getLayer(), p.getLayer()));
    AccessibilityWindowInfo focused = null, active = null, topApp = null;
    for (AccessibilityWindowInfo w : ws) {
      if (w.isFocused() && focused == null) focused = w;
      if (w.isActive() && active == null) active = w;
      if (w.getType() == AccessibilityWindowInfo.TYPE_APPLICATION && topApp == null && !pip(w)) topApp = w;
    }
    LinkedHashSet<AccessibilityWindowInfo> pick = new LinkedHashSet<>();
    if (focused != null && focused.getType() != AccessibilityWindowInfo.TYPE_INPUT_METHOD) pick.add(focused);
    if (active != null && active.getType() != AccessibilityWindowInfo.TYPE_INPUT_METHOD) pick.add(active);
    if (topApp != null) pick.add(topApp);
    List<AccessibilityWindowInfo> order = new ArrayList<>(pick);
    for (AccessibilityWindowInfo w : ws) {
      AccessibilityNodeInfo root = null;
      try { root = w.getRoot(); } catch (Throwable t) { /* gone */ }
      int rootIdx = -1;
      if (root != null && (every || order.contains(w))) { rootIdx = roots.size(); roots.add(root); }
      Rect b = new Rect(); w.getBoundsInScreen(b);
      sb.append("<pd-window id=\"").append(w.getId()).append("\" type=\"").append(typeName(w.getType()))
        .append("\" layer=\"").append(w.getLayer()).append('"');
      if (w.isFocused()) sb.append(" focused=\"1\"");
      if (w.isActive()) sb.append(" active=\"1\"");
      if (pip(w)) sb.append(" pip=\"1\"");
      sb.append(" bounds=\"[").append(b.left).append(',').append(b.top).append("][").append(b.right).append(',').append(b.bottom).append("]\"");
      if (root != null && root.getPackageName() != null) sb.append(" pkg=\"").append(esc(root.getPackageName().toString())).append('"');
      if (android.os.Build.VERSION.SDK_INT >= 24 && w.getTitle() != null) sb.append(" title=\"").append(esc(w.getTitle().toString())).append('"');
      if (rootIdx >= 0) sb.append(" root=\"").append(rootIdx).append('"');
      // SystemUI's notification shade window: it also hosts heads-up notifications, and its tree then still holds the
      // collapsed quick settings (qs_frame, expanded_qs_scroll_view) marked visible. Its texts come from the
      // notification stack only, inside the window's bounds (the heads-up card), never from the tiles.
      AccessibilityNodeInfo textRoot = root;
      if (root != null && w.getType() == AccessibilityWindowInfo.TYPE_SYSTEM && root.getPackageName() != null) {
        String pkg = root.getPackageName().toString();
        AccessibilityNodeInfo stack = firstById(root, pkg + ":id/notification_stack_scroller");
        if (stack != null || firstById(root, pkg + ":id/qs_frame") != null) { sb.append(" shade=\"1\""); textRoot = stack; }
      }
      sb.append('>');
      // what a system window (notification, heads-up, dialog, panel) says, for the host's compact summary
      if (textRoot != null && w.getType() != AccessibilityWindowInfo.TYPE_APPLICATION && w.getType() != AccessibilityWindowInfo.TYPE_INPUT_METHOD) {
        for (String t : texts(textRoot, 6, b)) sb.append("<t>").append(esc(t)).append("</t>");
      }
      sb.append("</pd-window>");
    }
  }

  private static boolean pip(AccessibilityWindowInfo w) {
    try { return android.os.Build.VERSION.SDK_INT >= 26 && w.isInPictureInPictureMode(); } catch (Throwable t) { return false; }
  }

  private static String typeName(int t) {
    switch (t) {
      case AccessibilityWindowInfo.TYPE_APPLICATION: return "app";
      case AccessibilityWindowInfo.TYPE_INPUT_METHOD: return "ime";
      case AccessibilityWindowInfo.TYPE_SYSTEM: return "system";
      case AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY: return "a11y";
      case AccessibilityWindowInfo.TYPE_SPLIT_SCREEN_DIVIDER: return "divider";
      default: return "other";
    }
  }

  private static AccessibilityNodeInfo firstById(AccessibilityNodeInfo root, String id) {
    try {
      List<AccessibilityNodeInfo> l = root.findAccessibilityNodeInfosByViewId(id);
      return l == null || l.isEmpty() ? null : l.get(0);
    } catch (Throwable t) { return null; }
  }

  /** Up to `max` distinct visible texts of a window inside `within`, in tree order: node texts, or content
   *  descriptions when no node has text. */
  private static List<String> texts(AccessibilityNodeInfo root, int max, Rect within) {
    List<String> outList = texts(root, max, within, false);
    return outList.isEmpty() ? texts(root, max, within, true) : outList;
  }

  private static List<String> texts(AccessibilityNodeInfo root, int max, Rect within, boolean desc) {
    List<String> outList = new ArrayList<>();
    ArrayDeque<AccessibilityNodeInfo> q = new ArrayDeque<>();
    q.add(root);
    int seen = 0;
    Rect r = new Rect();
    while (!q.isEmpty() && outList.size() < max && seen < 300) {
      AccessibilityNodeInfo n = q.removeFirst(); seen++;
      if (n == null) continue;
      n.getBoundsInScreen(r);
      if (n.isVisibleToUser() && Rect.intersects(r, within)) {
        CharSequence cs = desc ? n.getContentDescription() : n.getText();
        if (cs != null) {
          String s = cs.toString().replace('\n', ' ').trim();
          if (s.length() > 80) s = s.substring(0, 79) + "…";
          if (!s.isEmpty() && !outList.contains(s)) outList.add(s);
        }
      }
      for (int i = 0; i < n.getChildCount(); i++) q.add(n.getChild(i));
    }
    return outList;
  }

  private static String esc(String s) {
    StringBuilder b = new StringBuilder(s.length());
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      switch (c) {
        case '&': b.append("&amp;"); break;
        case '<': b.append("&lt;"); break;
        case '>': b.append("&gt;"); break;
        case '"': b.append("&quot;"); break;
        default: if (c >= 0x20 || c == '\t') b.append(c); else b.append(' ');
      }
    }
    return b.toString();
  }

  // ── input ───────────────────────────────────────────────────────────────────
  /** Counts injections: `tried` = calls that returned (true or false), `ok` = calls that returned true. */
  private static final class Sent { int tried, ok; }

  private static void doInput(String[] a) {
    String seq = a[1], verb = a[2];
    long t0 = SystemClock.uptimeMillis();
    Sent s = new Sent();
    String detail = "";
    try {
      switch (verb) {
        case "tap": { float x = f(a, 3), y = f(a, 4); tapAt(s, x, y); break; }
        case "dtap": { float x = f(a, 3), y = f(a, 4); tapAt(s, x, y); SystemClock.sleep(80); tapAt(s, x, y); break; }
        case "press": { float x = f(a, 3), y = f(a, 4); long ms = (long) f(a, 5); press(s, x, y, ms); break; }
        case "swipe": { swipe(s, f(a, 3), f(a, 4), f(a, 5), f(a, 6), (long) f(a, 7), a.length > 8 ? (long) f(a, 8) : 0); break; }
        case "key": {
          int code = keyCode(a.length > 3 ? a[3] : "");
          if (code <= 0) { detail = "unknown key"; break; }
          long now = SystemClock.uptimeMillis();
          if (inject(s, new KeyEvent(now, now, KeyEvent.ACTION_DOWN, code, 0, 0, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD))) {
            now = SystemClock.uptimeMillis();
          }
          inject(s, new KeyEvent(now, now, KeyEvent.ACTION_UP, code, 0, 0, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD));
          break;
        }
        case "text": {
          String text = a.length > 3 ? new String(android.util.Base64.decode(a[3], android.util.Base64.DEFAULT), StandardCharsets.UTF_8) : "";
          KeyEvent[] evs = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD).getEvents(text.toCharArray());
          if (evs == null) { detail = "not typeable with key events"; break; }
          for (KeyEvent e : evs) {
            KeyEvent k = KeyEvent.changeTimeRepeat(e, SystemClock.uptimeMillis(), 0);
            k.setSource(InputDevice.SOURCE_KEYBOARD);
            if (!inject(s, k)) break;   // never type past a key that may not have gone in
          }
          break;
        }
        default: detail = "unknown input " + verb;
      }
    } catch (Throwable t) {
      Throwable c = t instanceof InvocationTargetException && t.getCause() != null ? t.getCause() : t;
      detail = String.valueOf(c).replace('\n', ' ');
    }
    String state = s.tried == 0 ? "notsent" : s.ok == s.tried ? "sent" : "unknown";
    try {
      write(("PDIN " + seq + " " + state + " " + (SystemClock.uptimeMillis() - t0) + (detail.isEmpty() ? "" : " " + detail) + "\n").getBytes(StandardCharsets.UTF_8));
    } catch (Throwable t) { /* host gone */ }
  }

  private static float f(String[] a, int i) {
    if (i >= a.length) throw new IllegalArgumentException("missing argument " + i);
    float v = Float.parseFloat(a[i]);
    if (Float.isNaN(v) || Float.isInfinite(v)) throw new IllegalArgumentException("bad number " + a[i]);
    return v;
  }

  private static int keyCode(String k) {
    if (k.matches("\\d+")) return Integer.parseInt(k);
    return KeyEvent.keyCodeFromString(k.startsWith("KEYCODE_") ? k : "KEYCODE_" + k);
  }

  private static MotionEvent touch(long down, int action, float x, float y) {
    MotionEvent e = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, x, y, action == MotionEvent.ACTION_UP ? 0f : 1f, 1f, 0, 1f, 1f, 0, 0);
    e.setSource(InputDevice.SOURCE_TOUCHSCREEN);
    return e;
  }

  /** DOWN then UP at once, like `input tap`. The UP goes out even when the DOWN failed, so no finger stays down. */
  private static void tapAt(Sent s, float x, float y) throws Exception {
    long down = SystemClock.uptimeMillis();
    inject(s, touch(down, MotionEvent.ACTION_DOWN, x, y));
    inject(s, touch(down, MotionEvent.ACTION_UP, x, y));
  }

  private static void press(Sent s, float x, float y, long ms) throws Exception {
    long down = SystemClock.uptimeMillis();
    boolean ok = inject(s, touch(down, MotionEvent.ACTION_DOWN, x, y));
    if (ok) SystemClock.sleep(Math.max(0, ms));
    inject(s, touch(down, MotionEvent.ACTION_UP, x, y));
  }

  /** A drag over `ms` with a MOVE about every 16 ms (one per frame). holdMs > 0: the finger rests at the end before
   *  lifting, so the list stops where the finger stopped (no fling). The MOVEs are queued without waiting for each
   *  to be handled: a waited-for MOVE returns only once a frame has consumed it, which stretched a 600 ms drag past
   *  1 s on a busy emulator. DOWN, the MOVE after the hold and UP are waited for (in order behind the queued MOVEs). */
  private static void swipe(Sent s, float x1, float y1, float x2, float y2, long ms, long holdMs) throws Exception {
    long down = SystemClock.uptimeMillis();
    boolean ok = inject(s, touch(down, MotionEvent.ACTION_DOWN, x1, y1));
    long dur = Math.max(10, ms);
    int steps = (int) Math.max(2, Math.min(200, dur / 16));
    for (int i = 1; ok && i <= steps; i++) {
      long at = down + dur * i / steps;
      long wait = at - SystemClock.uptimeMillis();
      if (wait > 0) SystemClock.sleep(wait);
      ok = inject(s, touch(down, MotionEvent.ACTION_MOVE, x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps), false);
    }
    if (ok && holdMs > 0) { SystemClock.sleep(holdMs); inject(s, touch(down, MotionEvent.ACTION_MOVE, x2, y2)); }
    inject(s, touch(down, MotionEvent.ACTION_UP, x2, y2));
  }

  private static boolean inject(Sent s, InputEvent e) throws Exception { return inject(s, e, true); }

  /** Inject; `sync`: wait until it was handled (not for animations). An exception thrown before the event reached
   *  the input system (bad event, no permission) does not count as tried. The input manager first; when it refuses
   *  (SecurityException, a missing method: nothing was injected) UiAutomation from then on. */
  private static boolean inject(Sent s, InputEvent e, boolean sync) throws Exception {
    if (imInject != null) {
      try {
        boolean ok = (Boolean) imInject.invoke(im, e, sync ? MODE_WAIT_FOR_FINISH : MODE_ASYNC);
        s.tried++;
        if (ok) s.ok++;
        return ok;
      } catch (InvocationTargetException ite) {
        if (!(ite.getCause() instanceof SecurityException)) { s.tried++; return false; }   // it may have gone in
        imInject = null;   // not allowed here: nothing was injected; use UiAutomation for this and later events
      } catch (IllegalAccessException | IllegalArgumentException ex) {
        imInject = null;
      }
    }
    boolean ok;
    try {
      ok = inject3 != null ? (Boolean) inject3.invoke(ua, e, sync, false) : ua.injectInputEvent(e, sync);
    } catch (InvocationTargetException ite) {
      Throwable c = ite.getCause();
      if (c instanceof SecurityException || c instanceof IllegalArgumentException) { if (s.tried == 0) throw (Exception) c; ok = false; }
      else ok = false;
    } catch (SecurityException | IllegalArgumentException ex) {
      if (s.tried == 0) throw ex;
      ok = false;
    }
    s.tried++;
    if (ok) s.ok++;
    return ok;
  }

  /** Wait until no accessibility event has arrived for `quiet` ms (true), or `timeout` ms have passed (false). */
  private static boolean waitQuiet(long quiet, long timeout) {
    long start = SystemClock.uptimeMillis();
    synchronized (lastEvent) {
      while (true) {
        long now = SystemClock.uptimeMillis();
        long idleFor = now - lastEvent[0];
        if (idleFor >= quiet) return true;
        long left = timeout - (now - start);
        if (left <= 0) return false;
        try { lastEvent.wait(Math.max(1, Math.min(quiet - idleFor, left))); } catch (InterruptedException e) { return false; }
      }
    }
  }

  /** `<pd-hint bounds="[l,t][r,b]"/>` for each node showing its hint text (an empty field reports its hint as its
   *  text; the dump alone can't tell that from typed text). */
  private static void collectHints(AccessibilityNodeInfo n, StringBuilder sb, int depth) {
    if (n == null || depth > 150) return;
    if (android.os.Build.VERSION.SDK_INT >= 26 && n.isShowingHintText()) {
      Rect r = new Rect();
      n.getBoundsInScreen(r);
      sb.append("<pd-hint bounds=\"[").append(r.left).append(',').append(r.top).append("][")
        .append(r.right).append(',').append(r.bottom).append("]\"/>");
    }
    for (int i = 0; i < n.getChildCount(); i++) collectHints(n.getChild(i), sb, depth + 1);
  }

  /** Drop cached nodes so every dump reads the live hierarchy, like a fresh `uiautomator dump` process does. */
  private static void clearCache(UiAutomation u) {
    try { UiAutomation.class.getMethod("clearCache").invoke(u); return; } catch (Throwable t) { /* API < 34 */ }
    try {
      Class<?> c = Class.forName("android.view.accessibility.AccessibilityInteractionClient");
      Object client = c.getMethod("getInstance").invoke(null);
      c.getMethod("clearCache").invoke(client);
    } catch (Throwable t) { /* best effort */ }
  }

  private static void write(byte[] b) throws java.io.IOException {
    synchronized (OUT_LOCK) { out.write(b); out.flush(); }
  }

  private static byte[] readAll(File f) throws java.io.IOException {
    try (FileInputStream in = new FileInputStream(f)) {
      ByteArrayOutputStream bo = new ByteArrayOutputStream((int) Math.max(1024, f.length()));
      byte[] buf = new byte[65536];
      for (int n; (n = in.read(buf)) > 0; ) bo.write(buf, 0, n);
      return bo.toByteArray();
    }
  }
}
