package dev.phonedock.probe;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.ActivityManager;
import android.bluetooth.BluetoothAdapter;
import android.content.ContentResolver;
import android.content.Context;
import android.content.pm.FeatureInfo;
import android.content.pm.InstallSourceInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.graphics.ImageFormat;
import android.graphics.Point;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.hardware.display.DisplayManager;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.ProxyInfo;
import android.net.RouteInfo;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Debug;
import android.os.Environment;
import android.os.StatFs;
import android.os.SystemClock;
import android.provider.Settings;
import android.system.Os;
import android.system.StructUtsname;
import android.util.DisplayMetrics;
import android.util.Size;
import android.util.SizeF;
import android.view.Display;
import android.view.DisplayCutout;
import android.view.InputDevice;
import android.view.RoundedCorner;
import android.view.accessibility.AccessibilityManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.regex.Pattern;

/**
 * Checks for 'network', 'features', 'bluetooth', 'camera', 'display', 'input',
 * 'audio', 'packages', 'settings', and 'system' groups.
 */
final class DeviceAndSystemChecks {

    private static final Pattern SUSPICIOUS_PACKAGES = Pattern.compile(
            "genymotion|bluestacks|nox|andy|vphone|microvirt|com\\.android\\.emulator|"
                    + "com\\.google\\.android\\.sdksetup|ranchu|goldfish",
            Pattern.CASE_INSENSITIVE
    );

    private static final Pattern SUSPICIOUS_INPUT = Pattern.compile(
            "virtio|goldfish|qwerty2",
            Pattern.CASE_INSENSITIVE
    );

    private static final String[][] NAMED_FEATURES = {
            {"telephony", PackageManager.FEATURE_TELEPHONY, "0"},
            {"telephony.gsm", PackageManager.FEATURE_TELEPHONY_GSM, "0"},
            {"bluetooth", PackageManager.FEATURE_BLUETOOTH, "1"},
            {"bluetooth_le", PackageManager.FEATURE_BLUETOOTH_LE, "1"},
            {"nfc", PackageManager.FEATURE_NFC, "1"},
            {"fingerprint", PackageManager.FEATURE_FINGERPRINT, "1"},
            {"face", PackageManager.FEATURE_FACE, "0"},
            {"camera", PackageManager.FEATURE_CAMERA, "0"},
            {"camera.front", PackageManager.FEATURE_CAMERA_FRONT, "0"},
            {"camera.flash", PackageManager.FEATURE_CAMERA_FLASH, "1"},
            {"camera.autofocus", PackageManager.FEATURE_CAMERA_AUTOFOCUS, "0"},
            {"location.gps", PackageManager.FEATURE_LOCATION_GPS, "0"},
            {"wifi", PackageManager.FEATURE_WIFI, "0"},
            {"wifi.direct", PackageManager.FEATURE_WIFI_DIRECT, "0"},
            {"sensor.accelerometer", PackageManager.FEATURE_SENSOR_ACCELEROMETER, "0"},
            {"sensor.gyroscope", PackageManager.FEATURE_SENSOR_GYROSCOPE, "0"},
            {"sensor.compass", PackageManager.FEATURE_SENSOR_COMPASS, "0"},
            {"sensor.barometer", PackageManager.FEATURE_SENSOR_BAROMETER, "0"},
            {"sensor.proximity", PackageManager.FEATURE_SENSOR_PROXIMITY, "0"},
            {"sensor.light", PackageManager.FEATURE_SENSOR_LIGHT, "0"},
            {"sensor.stepcounter", PackageManager.FEATURE_SENSOR_STEP_COUNTER, "0"},
            {"sensor.heartrate", PackageManager.FEATURE_SENSOR_HEART_RATE, "0"},
            {"usb.host", PackageManager.FEATURE_USB_HOST, "0"},
            {"vulkan.hardware.level", PackageManager.FEATURE_VULKAN_HARDWARE_LEVEL, "0"},
            {"android.hardware.type.pc", "android.hardware.type.pc", "0"},
            {"android.software.leanback", "android.software.leanback", "0"}
    };

    private DeviceAndSystemChecks() {}

    static void runAll(ProbeContext ctx) {
        runNetworkChecks(ctx);
        runFeatureChecks(ctx);
        runBluetoothChecks(ctx);
        runCameraChecks(ctx);
        runDisplayChecks(ctx);
        runInputChecks(ctx);
        runAudioChecks(ctx);
        runPackageChecks(ctx);
        runSettingsChecks(ctx);
        runSystemChecks(ctx);
    }

    // -------------------------------------------------------------------------
    // network
    // -------------------------------------------------------------------------

    @SuppressWarnings("deprecation")
    private static void runNetworkChecks(ProbeContext ctx) {
        ctx.check("network.interfaces", "network", () -> {
            JSONArray arr = new JSONArray();
            List<String> reasons = new ArrayList<>();
            boolean hasEth0 = false;
            boolean hasWlan0 = false;
            boolean has1002 = false;

            Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
            while (ifaces != null && ifaces.hasMoreElements()) {
                NetworkInterface nif = ifaces.nextElement();
                String name = nif.getName();
                if ("eth0".equals(name)) hasEth0 = true;
                if ("wlan0".equals(name)) hasWlan0 = true;

                JSONObject o = new JSONObject();
                o.put("name", name);
                o.put("up", nif.isUp());
                o.put("mtu", nif.getMTU());

                JSONArray addrs = new JSONArray();
                Enumeration<InetAddress> inet = nif.getInetAddresses();
                while (inet.hasMoreElements()) {
                    String hostAddr = inet.nextElement().getHostAddress();
                    addrs.put(hostAddr);
                    if (hostAddr != null && hostAddr.startsWith("10.0.2.")) {
                        has1002 = true;
                    }
                }
                o.put("addresses", addrs);

                try {
                    byte[] hw = nif.getHardwareAddress();
                    o.put("hardwareAddress", formatMac(hw));
                } catch (Throwable t) {
                    o.put("hardwareAddress", "ERROR: " + ProbeContext.formatError(t));
                }
                arr.put(o);
            }

            if (hasEth0) reasons.add("interface eth0 present");
            if (has1002) reasons.add("emulator subnet address 10.0.2.* present");
            if (!hasWlan0) reasons.add("no wlan0 interface");
            return ProbeContext.Outcome.of(arr, !reasons.isEmpty(), ProbeContext.joinReasons(reasons));
        });

        final ConnectivityManager cm =
                (ConnectivityManager) ctx.appContext.getSystemService(Context.CONNECTIVITY_SERVICE);

        ctx.check("network.active", "network", () -> {
            if (cm == null) return ProbeContext.Outcome.error("ConnectivityManager is null");
            Network active = cm.getActiveNetwork();
            if (active == null) return ProbeContext.Outcome.ok(null);
            NetworkCapabilities caps = cm.getNetworkCapabilities(active);
            if (caps == null) return ProbeContext.Outcome.ok(null);

            JSONObject o = new JSONObject();
            JSONArray transports = new JSONArray();
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) transports.put("WIFI");
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) transports.put("CELLULAR");
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) transports.put("ETHERNET");
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_BLUETOOTH)) transports.put("BLUETOOTH");
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) transports.put("VPN");
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI_AWARE)) transports.put("WIFI_AWARE");
            o.put("transports", transports);

            JSONArray capList = new JSONArray();
            if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) capList.put("INTERNET");
            if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) capList.put("VALIDATED");
            if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)) capList.put("NOT_VPN");
            if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)) capList.put("NOT_METERED");
            if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_TRUSTED)) capList.put("TRUSTED");
            o.put("capabilities", capList);
            return ProbeContext.Outcome.ok(o);
        });

        ctx.check("network.vpn", "network", () -> {
            if (cm == null) return ProbeContext.Outcome.error("ConnectivityManager is null");
            Network active = cm.getActiveNetwork();
            if (active == null) return ProbeContext.Outcome.ok(false);
            NetworkCapabilities caps = cm.getNetworkCapabilities(active);
            boolean vpn = caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN);
            return ProbeContext.Outcome.ok(vpn);
        });

        ctx.check("network.link_properties", "network", () -> {
            if (cm == null) return ProbeContext.Outcome.error("ConnectivityManager is null");
            Network active = cm.getActiveNetwork();
            if (active == null) return ProbeContext.Outcome.ok(null);
            LinkProperties lp = cm.getLinkProperties(active);
            if (lp == null) return ProbeContext.Outcome.ok(null);

            List<String> reasons = new ArrayList<>();
            JSONObject o = new JSONObject();
            String iface = lp.getInterfaceName();
            o.put("interfaceName", iface == null ? JSONObject.NULL : iface);
            if ("eth0".equals(iface)) {
                reasons.add("active interface is eth0");
            }

            JSONArray addrs = new JSONArray();
            for (LinkAddress la : lp.getLinkAddresses()) {
                String a = la.getAddress() != null ? la.getAddress().getHostAddress() : la.toString();
                addrs.put(a);
                if (a != null && a.startsWith("10.0.2.")) {
                    reasons.add("active link address is " + a);
                }
            }
            o.put("addresses", addrs);

            JSONArray dns = new JSONArray();
            for (InetAddress d : lp.getDnsServers()) {
                String host = d.getHostAddress();
                dns.put(host);
                if ("10.0.2.3".equals(host)) {
                    reasons.add("DNS server is 10.0.2.3");
                }
            }
            o.put("dnsServers", dns);

            JSONArray routes = new JSONArray();
            for (RouteInfo r : lp.getRoutes()) {
                routes.put(r.toString());
            }
            o.put("routes", routes);
            return ProbeContext.Outcome.of(o, !reasons.isEmpty(), ProbeContext.joinReasons(reasons));
        });

        ctx.check("network.wifi", "network", () -> {
            WifiManager wm = (WifiManager) ctx.appContext.getSystemService(Context.WIFI_SERVICE);
            if (wm == null) return ProbeContext.Outcome.error("WifiManager is null");

            JSONObject o = new JSONObject();
            o.put("enabled", wm.isWifiEnabled());
            WifiInfo info = wm.getConnectionInfo();
            List<String> reasons = new ArrayList<>();
            if (info != null) {
                String ssid = info.getSSID();
                String bssid = info.getBSSID();
                int rssi = info.getRssi();
                int linkSpeed = info.getLinkSpeed();
                int freq = info.getFrequency();
                String mac = info.getMacAddress();

                o.put("ssid", ssid == null ? JSONObject.NULL : ssid);
                o.put("bssid", bssid == null ? JSONObject.NULL : bssid);
                o.put("rssi", rssi);
                o.put("linkSpeed", linkSpeed);
                o.put("frequency", freq);
                o.put("macAddress", mac == null ? JSONObject.NULL : mac);

                String unquotedSsid = unquote(ssid);
                if ("AndroidWifi".equalsIgnoreCase(unquotedSsid) || "WiredSSID".equalsIgnoreCase(unquotedSsid)) {
                    reasons.add("emulator Wi-Fi SSID '" + unquotedSsid + "'");
                }
                if (rssi == -50) {
                    reasons.add("Wi-Fi RSSI is exactly -50");
                }
                if ("00:13:10:85:fe:01".equalsIgnoreCase(bssid)) {
                    reasons.add("emulator default BSSID 00:13:10:85:fe:01");
                }
            }
            return ProbeContext.Outcome.of(o, !reasons.isEmpty(), ProbeContext.joinReasons(reasons));
        });

        ctx.check("network.proxy", "network", () -> {
            JSONObject o = new JSONObject();
            o.put("httpProxyHost", jsonOrNull(System.getProperty("http.proxyHost")));
            o.put("httpProxyPort", jsonOrNull(System.getProperty("http.proxyPort")));
            o.put("httpsProxyHost", jsonOrNull(System.getProperty("https.proxyHost")));
            o.put("httpsProxyPort", jsonOrNull(System.getProperty("https.proxyPort")));
            if (cm != null) {
                ProxyInfo pi = cm.getDefaultProxy();
                o.put("defaultProxy", pi == null ? JSONObject.NULL : pi.toString());
            }
            return ProbeContext.Outcome.ok(o);
        });
    }

    private static Object formatMac(byte[] hw) {
        if (hw == null || hw.length == 0) {
            return JSONObject.NULL;
        }
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < hw.length; i++) {
            if (i > 0) sb.append(':');
            sb.append(String.format(Locale.US, "%02x", hw[i] & 0xff));
        }
        return sb.toString();
    }

    private static String unquote(String s) {
        if (s == null) return null;
        if (s.length() >= 2 && s.startsWith("\"") && s.endsWith("\"")) {
            return s.substring(1, s.length() - 1);
        }
        return s;
    }

    // -------------------------------------------------------------------------
    // features
    // -------------------------------------------------------------------------

    private static void runFeatureChecks(ProbeContext ctx) {
        final PackageManager pm = ctx.appContext.getPackageManager();
        for (final String[] entry : NAMED_FEATURES) {
            final String shortId = entry[0];
            final String featureConst = entry[1];
            final boolean flagWhenMissing = "1".equals(entry[2]);
            ctx.check("features." + shortId, "features", () -> {
                boolean has = pm.hasSystemFeature(featureConst);
                boolean flag = flagWhenMissing && !has;
                return ProbeContext.Outcome.of(has, flag, flag ? "missing system feature " + featureConst : null);
            });
        }

        ctx.check("features.all", "features", () -> {
            FeatureInfo[] features = pm.getSystemAvailableFeatures();
            List<String> names = new ArrayList<>();
            if (features != null) {
                for (FeatureInfo fi : features) {
                    if (fi != null && fi.name != null) {
                        names.add(fi.name);
                    }
                }
            }
            Collections.sort(names);
            JSONArray arr = new JSONArray();
            for (String n : names) {
                arr.put(n);
            }
            return ProbeContext.Outcome.ok(arr);
        });
    }

    // -------------------------------------------------------------------------
    // bluetooth
    // -------------------------------------------------------------------------

    @SuppressWarnings("deprecation")
    private static void runBluetoothChecks(ProbeContext ctx) {
        ctx.check("bluetooth.adapter_present", "bluetooth", () -> {
            BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
            boolean present = adapter != null;
            return ProbeContext.Outcome.of(present, !present, !present ? "BluetoothAdapter.getDefaultAdapter() is null" : null);
        });
    }

    // -------------------------------------------------------------------------
    // camera
    // -------------------------------------------------------------------------

    private static void runCameraChecks(ProbeContext ctx) {
        final CameraManager cm = (CameraManager) ctx.appContext.getSystemService(Context.CAMERA_SERVICE);
        if (cm == null) {
            ctx.add("camera.count", "camera", ProbeContext.Outcome.error("CameraManager is null"));
            return;
        }

        String[] camIds = null;
        String camErr = null;
        try {
            camIds = cm.getCameraIdList();
        } catch (Throwable t) {
            camErr = ProbeContext.formatError(t);
        }

        final String[] finalIds = camIds;
        final String finalErr = camErr;

        ctx.check("camera.count", "camera", () -> {
            if (finalErr != null) return ProbeContext.Outcome.error(finalErr);
            int count = finalIds.length;
            boolean flag = (count == 0 || count == 1);
            String why = count == 0 ? "zero cameras" : (count == 1 ? "single camera" : null);
            return ProbeContext.Outcome.of(count, flag, why);
        });

        ctx.check("camera.list", "camera", () -> {
            if (finalErr != null) return ProbeContext.Outcome.error(finalErr);
            JSONArray arr = new JSONArray();
            List<String> reasons = new ArrayList<>();
            for (String id : finalIds) {
                JSONObject o = new JSONObject();
                o.put("id", id);
                try {
                    CameraCharacteristics cc = cm.getCameraCharacteristics(id);
                    Integer facing = cc.get(CameraCharacteristics.LENS_FACING);
                    Integer hwLevel = cc.get(CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL);
                    Boolean flash = cc.get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
                    Size pixelArray = cc.get(CameraCharacteristics.SENSOR_INFO_PIXEL_ARRAY_SIZE);
                    SizeF physSize = cc.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE);
                    float[] focals = cc.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS);
                    StreamConfigurationMap map = cc.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);

                    String hwLevelName = cameraHwLevelName(hwLevel);
                    String pixelStr = pixelArray != null
                            ? (pixelArray.getWidth() + "x" + pixelArray.getHeight()) : null;
                    String physStr = physSize != null
                            ? String.format(Locale.US, "%.2fx%.2f", physSize.getWidth(), physSize.getHeight()) : null;

                    JSONArray focalArr = new JSONArray();
                    if (focals != null) {
                        for (float f : focals) {
                            focalArr.put(ProbeContext.safeNumber(f));
                        }
                    }

                    String maxJpeg = null;
                    if (map != null) {
                        Size[] jpegSizes = map.getOutputSizes(ImageFormat.JPEG);
                        if (jpegSizes != null && jpegSizes.length > 0) {
                            Size best = jpegSizes[0];
                            long bestArea = (long) best.getWidth() * best.getHeight();
                            for (Size s : jpegSizes) {
                                long area = (long) s.getWidth() * s.getHeight();
                                if (area > bestArea) {
                                    best = s;
                                    bestArea = area;
                                }
                            }
                            maxJpeg = best.getWidth() + "x" + best.getHeight();
                        }
                    }

                    o.put("facing", cameraFacingName(facing));
                    o.put("hardwareLevel", hwLevelName);
                    o.put("flashAvailable", flash == null ? JSONObject.NULL : flash);
                    o.put("sensorPixelArraySize", jsonOrNull(pixelStr));
                    o.put("physicalSensorSize", jsonOrNull(physStr));
                    o.put("availableFocalLengths", focalArr);
                    o.put("maxJpegSize", jsonOrNull(maxJpeg));

                    if ("640x480".equals(pixelStr)) {
                        reasons.add("camera " + id + " pixel array is 640x480");
                    }
                    if ("EXTERNAL".equals(hwLevelName)) {
                        reasons.add("camera " + id + " hardware level is EXTERNAL");
                    }
                } catch (Throwable t) {
                    o.put("error", ProbeContext.formatError(t));
                }
                arr.put(o);
            }
            return ProbeContext.Outcome.of(arr, !reasons.isEmpty(), ProbeContext.joinReasons(reasons));
        });
    }

    private static String cameraFacingName(Integer f) {
        if (f == null) return "UNKNOWN";
        switch (f) {
            case CameraCharacteristics.LENS_FACING_FRONT: return "FRONT";
            case CameraCharacteristics.LENS_FACING_BACK: return "BACK";
            case CameraCharacteristics.LENS_FACING_EXTERNAL: return "EXTERNAL";
            default: return "FACING(" + f + ")";
        }
    }

    private static String cameraHwLevelName(Integer l) {
        if (l == null) return "UNKNOWN";
        switch (l) {
            case CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_LIMITED: return "LIMITED";
            case CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_FULL: return "FULL";
            case CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_LEGACY: return "LEGACY";
            case CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_3: return "LEVEL_3";
            case CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_EXTERNAL: return "EXTERNAL";
            default: return "LEVEL(" + l + ")";
        }
    }

    // -------------------------------------------------------------------------
    // display
    // -------------------------------------------------------------------------

    @SuppressWarnings("deprecation")
    private static void runDisplayChecks(ProbeContext ctx) {
        final DisplayManager dmgr = (DisplayManager) ctx.appContext.getSystemService(Context.DISPLAY_SERVICE);
        final Display display = dmgr != null ? dmgr.getDisplay(Display.DEFAULT_DISPLAY) : null;
        if (display == null) {
            ctx.add("display.default", "display", ProbeContext.Outcome.error("default Display is null"));
            return;
        }

        ctx.check("display.name", "display", () -> {
            String name = display.getName();
            String sw = ProbeContext.findSuspiciousWord(name);
            return ProbeContext.Outcome.of(name, sw != null, sw != null ? "contains '" + sw + "'" : null);
        });

        ctx.check("display.size", "display", () -> {
            Point p = new Point();
            display.getRealSize(p);
            JSONObject o = new JSONObject();
            o.put("width", p.x);
            o.put("height", p.y);
            return ProbeContext.Outcome.ok(o);
        });

        ctx.check("display.refresh_rate", "display", () ->
                ProbeContext.Outcome.ok(ProbeContext.safeNumber(display.getRefreshRate())));

        Display.Mode[] modesTmp = null;
        String modesErrTmp = null;
        try {
            modesTmp = display.getSupportedModes();
        } catch (Throwable t) {
            modesErrTmp = ProbeContext.formatError(t);
        }
        final Display.Mode[] modes = modesTmp;
        final String modesErr = modesErrTmp;
        ctx.check("display.supported_modes", "display", () -> {
            if (modesErr != null) return ProbeContext.Outcome.error(modesErr);
            JSONArray arr = new JSONArray();
            if (modes != null) {
                for (Display.Mode m : modes) {
                    JSONObject o = new JSONObject();
                    o.put("modeId", m.getModeId());
                    o.put("width", m.getPhysicalWidth());
                    o.put("height", m.getPhysicalHeight());
                    o.put("refreshRate", ProbeContext.safeNumber(m.getRefreshRate()));
                    arr.put(o);
                }
            }
            return ProbeContext.Outcome.ok(arr);
        });

        ctx.check("display.hdr_capabilities", "display", () -> {
            Display.HdrCapabilities hdr = display.getHdrCapabilities();
            if (hdr == null) return ProbeContext.Outcome.ok(null);
            JSONObject o = new JSONObject();
            JSONArray types = new JSONArray();
            for (int t : hdr.getSupportedHdrTypes()) {
                types.put(hdrTypeName(t));
            }
            o.put("supportedTypes", types);
            o.put("maxLuminance", ProbeContext.safeNumber(hdr.getDesiredMaxLuminance()));
            o.put("maxAverageLuminance", ProbeContext.safeNumber(hdr.getDesiredMaxAverageLuminance()));
            o.put("minLuminance", ProbeContext.safeNumber(hdr.getDesiredMinLuminance()));
            return ProbeContext.Outcome.ok(o);
        });

        final DisplayMetrics metrics = new DisplayMetrics();
        String metricsErrTmp = null;
        try {
            display.getRealMetrics(metrics);
        } catch (Throwable t) {
            metricsErrTmp = ProbeContext.formatError(t);
        }
        final String metricsErr = metricsErrTmp;

        ctx.check("display.metrics", "display", () -> {
            if (metricsErr != null) return ProbeContext.Outcome.error(metricsErr);
            JSONObject o = new JSONObject();
            o.put("xdpi", ProbeContext.safeNumber(metrics.xdpi));
            o.put("ydpi", ProbeContext.safeNumber(metrics.ydpi));
            o.put("densityDpi", metrics.densityDpi);
            o.put("density", ProbeContext.safeNumber(metrics.density));
            return ProbeContext.Outcome.ok(o);
        });

        Boolean cutoutPresentVal = null;
        if (Build.VERSION.SDK_INT >= 29) {
            try {
                DisplayCutout cutout = display.getCutout();
                cutoutPresentVal = (cutout != null);
            } catch (Throwable ignored) {
                cutoutPresentVal = null;
            }
        }
        final Boolean finalCutoutPresent = cutoutPresentVal;

        ctx.check("display.cutout_present", "display", () -> {
            if (Build.VERSION.SDK_INT < 29) {
                return ProbeContext.Outcome.error("Display.getCutout() requires API 29");
            }
            return ProbeContext.Outcome.ok(finalCutoutPresent);
        });

        ctx.check("display.rounded_corners", "display", () -> {
            if (Build.VERSION.SDK_INT < 31) {
                return ProbeContext.Outcome.error("Display.getRoundedCorner() requires API 31");
            }
            int tl = cornerRadius(display.getRoundedCorner(RoundedCorner.POSITION_TOP_LEFT));
            int tr = cornerRadius(display.getRoundedCorner(RoundedCorner.POSITION_TOP_RIGHT));
            int br = cornerRadius(display.getRoundedCorner(RoundedCorner.POSITION_BOTTOM_RIGHT));
            int bl = cornerRadius(display.getRoundedCorner(RoundedCorner.POSITION_BOTTOM_LEFT));
            JSONObject o = new JSONObject();
            o.put("topLeft", tl);
            o.put("topRight", tr);
            o.put("bottomRight", br);
            o.put("bottomLeft", bl);
            o.put("hasRoundedCorners", (tl > 0 || tr > 0 || br > 0 || bl > 0));
            return ProbeContext.Outcome.ok(o);
        });

        final boolean xdpiEqualsDensity = (metricsErr == null && metrics.xdpi == (float) metrics.densityDpi);
        final boolean noCutout = (finalCutoutPresent != null && !finalCutoutPresent);
        final boolean single60Hz = (modesErr == null && modes != null && modes.length == 1
                && Math.abs(modes[0].getRefreshRate() - 60.0f) < 0.5f);

        ctx.check("display.xdpi_equals_density_dpi", "display", () ->
                metricsErr != null ? ProbeContext.Outcome.error(metricsErr) : ProbeContext.Outcome.ok(xdpiEqualsDensity));
        ctx.check("display.no_cutout", "display", () ->
                Build.VERSION.SDK_INT < 29 ? ProbeContext.Outcome.error("Display.getCutout() requires API 29")
                        : ProbeContext.Outcome.ok(noCutout));
        ctx.check("display.single_60hz_mode", "display", () ->
                modesErr != null ? ProbeContext.Outcome.error(modesErr) : ProbeContext.Outcome.ok(single60Hz));
        ctx.check("display.emulator_profile", "display", () -> {
            boolean emu = xdpiEqualsDensity && noCutout && single60Hz;
            return ProbeContext.Outcome.of(
                    emu,
                    emu,
                    emu ? "xdpi equals densityDpi exactly, no cutout, and single 60 Hz mode" : null
            );
        });
    }

    private static int cornerRadius(RoundedCorner rc) {
        if (Build.VERSION.SDK_INT >= 31 && rc != null) {
            return rc.getRadius();
        }
        return 0;
    }

    private static String hdrTypeName(int t) {
        switch (t) {
            case Display.HdrCapabilities.HDR_TYPE_DOLBY_VISION: return "DOLBY_VISION";
            case Display.HdrCapabilities.HDR_TYPE_HDR10: return "HDR10";
            case Display.HdrCapabilities.HDR_TYPE_HLG: return "HLG";
            case Display.HdrCapabilities.HDR_TYPE_HDR10_PLUS: return "HDR10_PLUS";
            default: return "HDR(" + t + ")";
        }
    }

    // -------------------------------------------------------------------------
    // input
    // -------------------------------------------------------------------------

    private static void runInputChecks(ProbeContext ctx) {
        ctx.check("input.devices", "input", () -> {
            int[] ids = InputDevice.getDeviceIds();
            JSONArray arr = new JSONArray();
            List<String> reasons = new ArrayList<>();
            for (int id : ids) {
                InputDevice dev = InputDevice.getDevice(id);
                if (dev == null) continue;
                JSONObject o = new JSONObject();
                String name = dev.getName();
                o.put("id", dev.getId());
                o.put("name", jsonOrNull(name));
                o.put("descriptor", jsonOrNull(dev.getDescriptor()));
                o.put("vendorId", dev.getVendorId());
                o.put("productId", dev.getProductId());
                o.put("sources", String.format(Locale.US, "0x%x", dev.getSources()));
                o.put("isVirtual", dev.isVirtual());
                if (Build.VERSION.SDK_INT >= 29) {
                    o.put("isExternal", dev.isExternal());
                } else {
                    o.put("isExternal", JSONObject.NULL);
                }
                int kbType = dev.getKeyboardType();
                o.put("keyboardType", keyboardTypeName(kbType));
                arr.put(o);

                if (name != null) {
                    String sw = ProbeContext.findSuspiciousWord(name);
                    if (sw != null) {
                        reasons.add("input device '" + name + "' contains '" + sw + "'");
                    } else if (SUSPICIOUS_INPUT.matcher(name).find()) {
                        reasons.add("input device '" + name + "' matches emulator input name");
                    }
                }
                if (!dev.isVirtual() && kbType == InputDevice.KEYBOARD_TYPE_ALPHABETIC) {
                    reasons.add("physical alphabetic keyboard present: '" + name + "'");
                }
            }
            return ProbeContext.Outcome.of(arr, !reasons.isEmpty(), ProbeContext.joinReasons(reasons));
        });
    }

    private static String keyboardTypeName(int k) {
        switch (k) {
            case InputDevice.KEYBOARD_TYPE_NONE: return "NONE";
            case InputDevice.KEYBOARD_TYPE_NON_ALPHABETIC: return "NON_ALPHABETIC";
            case InputDevice.KEYBOARD_TYPE_ALPHABETIC: return "ALPHABETIC";
            default: return "KEYBOARD(" + k + ")";
        }
    }

    // -------------------------------------------------------------------------
    // audio
    // -------------------------------------------------------------------------

    private static void runAudioChecks(ProbeContext ctx) {
        ctx.check("audio.devices", "audio", () -> {
            AudioManager am = (AudioManager) ctx.appContext.getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return ProbeContext.Outcome.error("AudioManager is null");
            AudioDeviceInfo[] devs = am.getDevices(AudioManager.GET_DEVICES_ALL);
            JSONArray arr = new JSONArray();
            List<String> reasons = new ArrayList<>();
            for (AudioDeviceInfo d : devs) {
                JSONObject o = new JSONObject();
                String product = d.getProductName() != null ? d.getProductName().toString() : null;
                String addr = Build.VERSION.SDK_INT >= 28 ? d.getAddress() : null;
                o.put("type", d.getType());
                o.put("typeName", audioDeviceTypeName(d.getType()));
                o.put("productName", jsonOrNull(product));
                o.put("address", jsonOrNull(addr));
                o.put("isSink", d.isSink());
                arr.put(o);

                String sw = ProbeContext.findSuspiciousWord(product);
                if (sw != null) {
                    reasons.add("audio product '" + product + "' contains '" + sw + "'");
                }
                String swa = ProbeContext.findSuspiciousWord(addr);
                if (swa != null) {
                    reasons.add("audio address '" + addr + "' contains '" + swa + "'");
                }
            }
            return ProbeContext.Outcome.of(arr, !reasons.isEmpty(), ProbeContext.joinReasons(reasons));
        });
    }

    private static String audioDeviceTypeName(int t) {
        switch (t) {
            case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE: return "BUILTIN_EARPIECE";
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER: return "BUILTIN_SPEAKER";
            case AudioDeviceInfo.TYPE_WIRED_HEADSET: return "WIRED_HEADSET";
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES: return "WIRED_HEADPHONES";
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO: return "BLUETOOTH_SCO";
            case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP: return "BLUETOOTH_A2DP";
            case AudioDeviceInfo.TYPE_HDMI: return "HDMI";
            case AudioDeviceInfo.TYPE_BUILTIN_MIC: return "BUILTIN_MIC";
            case AudioDeviceInfo.TYPE_TELEPHONY: return "TELEPHONY";
            case AudioDeviceInfo.TYPE_USB_DEVICE: return "USB_DEVICE";
            case AudioDeviceInfo.TYPE_USB_HEADSET: return "USB_HEADSET";
            case AudioDeviceInfo.TYPE_REMOTE_SUBMIX: return "REMOTE_SUBMIX";
            default: return "TYPE(" + t + ")";
        }
    }

    // -------------------------------------------------------------------------
    // packages
    // -------------------------------------------------------------------------

    @SuppressWarnings("deprecation")
    private static void runPackageChecks(ProbeContext ctx) {
        final PackageManager pm = ctx.appContext.getPackageManager();
        List<PackageInfo> installed = null;
        String pkgErr = null;
        try {
            installed = pm.getInstalledPackages(0);
        } catch (Throwable t) {
            pkgErr = ProbeContext.formatError(t);
        }

        final List<PackageInfo> finalInstalled = installed;
        final String finalErr = pkgErr;

        ctx.check("packages.suspicious", "packages", () -> {
            if (finalErr != null) return ProbeContext.Outcome.error(finalErr);
            JSONArray matches = new JSONArray();
            for (PackageInfo pi : finalInstalled) {
                if (pi.packageName != null && SUSPICIOUS_PACKAGES.matcher(pi.packageName).find()) {
                    matches.put(pi.packageName);
                }
            }
            return ProbeContext.Outcome.of(
                    matches,
                    matches.length() > 0,
                    matches.length() > 0 ? "suspicious emulator package(s) installed: " + matches : null
            );
        });

        ctx.check("packages.count", "packages", () -> {
            if (finalErr != null) return ProbeContext.Outcome.error(finalErr);
            int count = finalInstalled.size();
            boolean low = count < 80;
            return ProbeContext.Outcome.of(count, low, low ? "fewer than 80 installed packages (" + count + ")" : null);
        });

        ctx.check("packages.vending", "packages", () -> checkSpecificPackage(pm, "com.android.vending"));
        ctx.check("packages.gms", "packages", () -> checkSpecificPackage(pm, "com.google.android.gms"));

        ctx.check("packages.installer", "packages", () -> {
            String myPkg = ctx.appContext.getPackageName();
            String installer;
            if (Build.VERSION.SDK_INT >= 30) {
                InstallSourceInfo src = pm.getInstallSourceInfo(myPkg);
                installer = src != null ? src.getInstallingPackageName() : null;
            } else {
                installer = pm.getInstallerPackageName(myPkg);
            }
            return ProbeContext.Outcome.ok(installer);
        });
    }

    private static ProbeContext.Outcome checkSpecificPackage(PackageManager pm, String pkg) throws Exception {
        JSONObject o = new JSONObject();
        try {
            PackageInfo pi = pm.getPackageInfo(pkg, 0);
            o.put("installed", true);
            o.put("versionName", jsonOrNull(pi.versionName));
        } catch (PackageManager.NameNotFoundException e) {
            o.put("installed", false);
            o.put("versionName", JSONObject.NULL);
        }
        return ProbeContext.Outcome.ok(o);
    }

    // -------------------------------------------------------------------------
    // settings
    // -------------------------------------------------------------------------

    @SuppressWarnings("deprecation")
    private static void runSettingsChecks(ProbeContext ctx) {
        final ContentResolver cr = ctx.appContext.getContentResolver();

        ctx.check("settings.global.adb_enabled", "settings", () -> {
            String v = Settings.Global.getString(cr, Settings.Global.ADB_ENABLED);
            boolean on = "1".equals(v);
            return ProbeContext.Outcome.of(v, on, on ? "adb_enabled is 1" : null);
        });

        ctx.check("settings.global.development_settings_enabled", "settings", () -> {
            String v = Settings.Global.getString(cr, Settings.Global.DEVELOPMENT_SETTINGS_ENABLED);
            boolean on = "1".equals(v);
            return ProbeContext.Outcome.of(v, on, on ? "development_settings_enabled is 1" : null);
        });

        ctx.check("settings.global.device_name", "settings", () -> {
            String v = Settings.Global.getString(cr, Settings.Global.DEVICE_NAME);
            String sw = ProbeContext.findSuspiciousWord(v);
            return ProbeContext.Outcome.of(v, sw != null, sw != null ? "contains '" + sw + "'" : null);
        });

        ctx.check("settings.global.airplane_mode_on", "settings", () ->
                ProbeContext.Outcome.ok(Settings.Global.getString(cr, Settings.Global.AIRPLANE_MODE_ON)));
        ctx.check("settings.global.stay_on_while_plugged_in", "settings", () ->
                ProbeContext.Outcome.ok(Settings.Global.getString(cr, Settings.Global.STAY_ON_WHILE_PLUGGED_IN)));
        ctx.check("settings.global.auto_time", "settings", () ->
                ProbeContext.Outcome.ok(Settings.Global.getString(cr, Settings.Global.AUTO_TIME)));

        ctx.check("settings.secure.android_id", "settings", () -> {
            String v = Settings.Secure.getString(cr, Settings.Secure.ANDROID_ID);
            List<String> reasons = new ArrayList<>();
            if (ProbeContext.isAllZeros(v)) {
                reasons.add("android_id is all zeros");
            }
            if ("9774d56d682e549c".equalsIgnoreCase(v)) {
                reasons.add("android_id is known emulator constant 9774d56d682e549c");
            }
            return ProbeContext.Outcome.of(v, !reasons.isEmpty(), ProbeContext.joinReasons(reasons));
        });

        ctx.check("settings.secure.bluetooth_name", "settings", () -> {
            String v = Settings.Secure.getString(cr, "bluetooth_name");
            String sw = ProbeContext.findSuspiciousWord(v);
            return ProbeContext.Outcome.of(v, sw != null, sw != null ? "contains '" + sw + "'" : null);
        });

        ctx.check("settings.secure.mock_location", "settings", () ->
                ProbeContext.Outcome.ok(Settings.Secure.getString(cr, Settings.Secure.ALLOW_MOCK_LOCATION)));

        ctx.check("settings.secure.enabled_accessibility_services", "settings", () -> {
            String v = Settings.Secure.getString(cr, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            boolean nonEmpty = v != null && !v.trim().isEmpty();
            return ProbeContext.Outcome.of(v, nonEmpty, nonEmpty ? "accessibility services enabled: " + v : null);
        });

        ctx.check("settings.secure.accessibility_enabled", "settings", () -> {
            String v = Settings.Secure.getString(cr, Settings.Secure.ACCESSIBILITY_ENABLED);
            boolean on = "1".equals(v);
            return ProbeContext.Outcome.of(v, on, on ? "accessibility_enabled is 1" : null);
        });

        ctx.check("settings.secure.default_input_method", "settings", () ->
                ProbeContext.Outcome.ok(Settings.Secure.getString(cr, Settings.Secure.DEFAULT_INPUT_METHOD)));

        final AccessibilityManager am =
                (AccessibilityManager) ctx.appContext.getSystemService(Context.ACCESSIBILITY_SERVICE);

        ctx.check("settings.accessibility.enabled", "settings", () -> {
            if (am == null) return ProbeContext.Outcome.error("AccessibilityManager is null");
            boolean enabled = am.isEnabled();
            return ProbeContext.Outcome.of(enabled, enabled, enabled ? "AccessibilityManager.isEnabled() is true" : null);
        });

        ctx.check("settings.accessibility.touch_exploration", "settings", () -> {
            if (am == null) return ProbeContext.Outcome.error("AccessibilityManager is null");
            return ProbeContext.Outcome.ok(am.isTouchExplorationEnabled());
        });

        ctx.check("settings.accessibility.enabled_services", "settings", () -> {
            if (am == null) return ProbeContext.Outcome.error("AccessibilityManager is null");
            List<AccessibilityServiceInfo> list =
                    am.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK);
            JSONArray arr = new JSONArray();
            if (list != null) {
                for (AccessibilityServiceInfo info : list) {
                    if (info != null && info.getId() != null) {
                        arr.put(info.getId());
                    }
                }
            }
            return ProbeContext.Outcome.of(
                    arr,
                    arr.length() > 0,
                    arr.length() > 0 ? arr.length() + " enabled accessibility service(s)" : null
            );
        });

        ctx.check("settings.activity.is_user_a_monkey", "settings", () -> {
            boolean v = ActivityManager.isUserAMonkey();
            return ProbeContext.Outcome.of(v, v, v ? "isUserAMonkey() is true" : null);
        });

        ctx.check("settings.activity.is_running_in_test_harness", "settings", () -> {
            boolean v = ActivityManager.isRunningInTestHarness();
            return ProbeContext.Outcome.of(v, v, v ? "isRunningInTestHarness() is true" : null);
        });

        ctx.check("settings.activity.is_running_in_user_test_harness", "settings", () -> {
            if (Build.VERSION.SDK_INT < 29) {
                return ProbeContext.Outcome.error("requires API 29");
            }
            boolean v = ActivityManager.isRunningInUserTestHarness();
            return ProbeContext.Outcome.of(v, v, v ? "isRunningInUserTestHarness() is true" : null);
        });

        ctx.check("settings.debug.is_debugger_connected", "settings", () -> {
            boolean v = Debug.isDebuggerConnected();
            return ProbeContext.Outcome.of(v, v, v ? "debugger is connected" : null);
        });

        ctx.check("settings.debug.waiting_for_debugger", "settings", () -> {
            boolean v = Debug.waitingForDebugger();
            return ProbeContext.Outcome.of(v, v, v ? "waitingForDebugger is true" : null);
        });
    }

    // -------------------------------------------------------------------------
    // system
    // -------------------------------------------------------------------------

    private static void runSystemChecks(ProbeContext ctx) {
        // Record uptime honestly without flagging fresh boots (any physical phone has <3 min uptime right after reboot).
        ctx.check("system.elapsed_realtime_ms", "system", () -> ProbeContext.Outcome.ok(SystemClock.elapsedRealtime()));

        ctx.check("system.uptime_millis", "system", () -> ProbeContext.Outcome.ok(SystemClock.uptimeMillis()));

        ctx.check("system.timezone", "system", () -> ProbeContext.Outcome.ok(TimeZone.getDefault().getID()));
        ctx.check("system.locale", "system", () -> ProbeContext.Outcome.ok(Locale.getDefault().toLanguageTag()));
        ctx.check("system.os_arch", "system", () -> ProbeContext.Outcome.ok(System.getProperty("os.arch")));

        ctx.check("system.os_version", "system", () -> {
            String v = System.getProperty("os.version");
            String sw = ProbeContext.findSuspiciousWord(v);
            return ProbeContext.Outcome.of(v, sw != null, sw != null ? "kernel version contains '" + sw + "'" : null);
        });

        ctx.check("system.java_vm_version", "system", () -> ProbeContext.Outcome.ok(System.getProperty("java.vm.version")));

        ctx.check("system.total_ram_bytes", "system", () -> {
            ActivityManager am = (ActivityManager) ctx.appContext.getSystemService(Context.ACTIVITY_SERVICE);
            if (am == null) return ProbeContext.Outcome.error("ActivityManager is null");
            ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
            am.getMemoryInfo(mi);
            return ProbeContext.Outcome.ok(mi.totalMem);
        });

        ctx.check("system.internal_storage", "system", () -> {
            StatFs sf = new StatFs(Environment.getDataDirectory().getPath());
            JSONObject o = new JSONObject();
            o.put("totalBytes", sf.getTotalBytes());
            o.put("freeBytes", sf.getFreeBytes());
            o.put("availableBytes", sf.getAvailableBytes());
            return ProbeContext.Outcome.ok(o);
        });

        ctx.check("system.cpu_cores", "system", () ->
                ProbeContext.Outcome.ok(Runtime.getRuntime().availableProcessors()));

        ctx.check("system.uname", "system", () -> {
            StructUtsname u = Os.uname();
            JSONObject o = new JSONObject();
            o.put("sysname", u.sysname);
            o.put("nodename", u.nodename);
            o.put("release", u.release);
            o.put("version", u.version);
            o.put("machine", u.machine);

            List<String> reasons = new ArrayList<>();
            String swr = ProbeContext.findSuspiciousWord(u.release);
            if (swr != null) reasons.add("uname release contains '" + swr + "'");
            String swv = ProbeContext.findSuspiciousWord(u.version);
            if (swv != null) reasons.add("uname version contains '" + swv + "'");
            return ProbeContext.Outcome.of(o, !reasons.isEmpty(), ProbeContext.joinReasons(reasons));
        });
    }

    private static Object jsonOrNull(Object v) {
        return v == null ? JSONObject.NULL : v;
    }
}
