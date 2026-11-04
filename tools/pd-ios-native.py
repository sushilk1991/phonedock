#!/usr/bin/env python3
"""pd-ios-native: PhoneDock's sidecar for driving a real iPhone on iOS 27+ without WebDriverAgent.

Runs with the Python of the installed pymobiledevice3 (>= 11.49) in isolated mode:

    <pymobiledevice3 venv>/bin/python -I -u tools/pd-ios-native.py [--udid UDID] [--transport auto|usb|wifi|native]

One process per device. Transports, in `auto` order:
  native  Apple's own tunnel, borrowed from remoted via remotepairingd (pymobiledevice3 NativeRemotedTunnel). No root,
          kernel-routed, works for phones paired in Xcode/devicectl over USB or Wi-Fi, and is not subject to macOS
          Local Network privacy. remoted and we evict each other's RSD *control* connection; service connections
          survive that, and a failed call reconnects once.
  usb     usbmuxd -> lockdown -> CoreDeviceProxy -> in-process userspace tunnel (PyTCP).
  wifi    usbmuxd "Network" device the same way, else a RemotePairing (pair-host) record over the LAN.
On top: RemoteServiceDiscovery -> RemoteXPC/DTX services, a persistent iOS 27 remote-accessibility session for the UI
tree, and (only if input commands are used) a HID session whose display media stream stays open (iOS only honours
injected touches while a media stream runs: the "auth gate"; the stream is kept alive with RTCP receiver reports).

Protocol: JSON lines on stdin/stdout.
  request   {"id": 1, "cmd": "tap", "args": {"x": 100, "y": 200}}
  response  {"id": 1, "ok": true, "result": {...}}
            {"id": 1, "ok": false, "error": {"code": "not_paired", "message": "...", "hints": [...]}}
  event     {"event": "ready" | "progress" | "pair_code" | "pair_waiting" | "reconnecting", "id"?: <request id>, ...}
Everything else (pymobiledevice3 logging, stray prints) goes to stderr.

Commands: ping, connect, disconnect, status, devices, screenshot, tap, double_tap, long_press, swipe, pinch, type,
key, button, launch, terminate, open_url, apps, rotate, clipboard_get, clipboard_set, appearance, ui, pair_wifi,
mount_ddi, shutdown.
Coordinates are device screenshot pixels; the sidecar normalises them to the HID range 0..65535.

Error codes: not_paired, no_device, developer_mode_off, ui_automation_off, ios_too_old, locked, ddi_missing,
local_network_denied, stream_busy, stream_failed, connection_lost, device_timeout, not_supported, bad_request,
unknown_command, pair_timeout, pair_failed, usbmuxd_unavailable, internal.

Hardware status (2026-11-03, iPhone17,2 on iOS 27.0, Wi-Fi paired, native transport): connect, status, screenshot,
apps and ui were run read-only on a real phone. Input (tap/swipe/type/key/button/pinch), launch/terminate/open_url,
rotate, clipboard, appearance, DDI mounting, the usb/wifi userspace transports and pair_wifi are UNTESTED on hardware.
The pure helpers (coordinates, gestures, text, rotation, NSKeyedArchive + AX tree parsing) and the protocol are
unit-tested.
Test-only knobs: PD_IOS_NATIVE_FAKE=WxH[@scale] swaps the device for an in-memory fake that records HID reports;
PD_IOS_NATIVE_DEBUG=1 enables the _sleep/_crash/_fake_log debug commands.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import contextvars
import datetime
import errno
import json
import logging
import math
import os
import platform
import re
import signal
import struct
import sys
import time
import traceback
import uuid
import zlib
from typing import Any, Awaitable, Callable, NamedTuple, Optional

SIDECAR_VERSION = "0.1.0"
MIN_PYMD3 = (11, 49)
MIN_IOS_MAJOR = 27
HID_MAX = 65535
LAN_ERRNOS = {errno.EHOSTUNREACH, errno.ENETUNREACH}

# mainTouchscreen contact states (identical to pymobiledevice3.remote.core_device.hid_service; asserted in tests)
TOUCH_CONTACT = 0xC2
TOUCH_RELEASE = 0x02

# HID services that come with the developer disk image; their presence in the RSD handshake = DDI usable
DDI_SERVICES = ("com.apple.coredevice.appservice", "com.apple.coredevice.deviceinfo")
SVC_UHID = "com.apple.coredevice.hid.universalhidservice"
SVC_INDIGO = "com.apple.coredevice.hid.indigo"
SVC_SCREENCAP = "com.apple.coredevice.screencaptureservice"
SVC_DISPLAY = "com.apple.coredevice.displayservice"
SVC_REMOTE_AX = "com.apple.accessibility.axAuditDaemon.remoteAXService"  # iOS 27+, DTX
SERVICES_OF_INTEREST = (
    SVC_UHID, SVC_INDIGO, SVC_SCREENCAP, SVC_DISPLAY, SVC_REMOTE_AX,
    "com.apple.coredevice.appservice", "com.apple.coredevice.deviceinfo", "com.apple.coredevice.devicecontrol",
    "com.apple.coredevice.configuration", "com.apple.coredevice.pasteboardservice",
    "com.apple.instruments.dtservicehub", "com.apple.accessibility.axAuditDaemon.remoteserver.shim.remote",
    "com.apple.security.cryptexd.remote",
)

log = logging.getLogger("pd-ios-native")
REQ_ID: contextvars.ContextVar[Any] = contextvars.ContextVar("req_id", default=None)


# ═════════════════════════════════════════════════════════════════════════════════════════════════
# Errors
# ═════════════════════════════════════════════════════════════════════════════════════════════════

HINTS: dict[str, list[str]] = {
    "not_paired": [
        "Wi-Fi, no cable (iOS 27+): start pairing from PhoneDock, then on the iPhone open Settings > Developer > "
        "Paired Macs > Other Devices, tap this Mac and enter the 6-digit code it shows",
        "USB: plug the iPhone in, unlock it and tap Trust (connect with trustTimeoutSec to wait for the prompt)",
    ],
    "no_device": [
        "USB: check the cable and unlock the iPhone",
        "Wi-Fi: the iPhone must be awake, unlocked once since boot and on the same Wi-Fi network as this Mac",
    ],
    "developer_mode_off": [
        "On the iPhone: Settings > Privacy & Security > Developer Mode > On, then restart the phone",
        "If the switch is missing, connect by USB once and run: pymobiledevice3 amfi reveal-developer-mode",
    ],
    "ui_automation_off": ["On the iPhone: Settings > Developer > Enable UI Automation > On"],
    "ios_too_old": [
        "Native control needs iOS 27 or later; older phones use the WebDriverAgent path (phonedock ios wda-setup)",
    ],
    "locked": [
        "Unlock the iPhone (Face ID or passcode) and retry",
        "For long sessions: Settings > Display & Brightness > Auto-Lock > Never",
    ],
    "ddi_missing": [
        "Mount the developer disk image: pymobiledevice3 mounter auto-mount (needs internet for Apple's signing server)",
        "Developer Mode must be on",
    ],
    "local_network_denied": [
        "macOS Local Network privacy blocks LAN access for this process. Run PhoneDock from PhoneDock.app and allow it "
        "in System Settings > Privacy & Security > Local Network",
        "Processes started from a terminal inherit the terminal app's permission; allow the terminal there, or use USB",
    ],
    "stream_busy": [
        "Another app owns the iPhone's screen stream: stop mirroring in Xcode (Device Hub / Devices window) and "
        "iPhone Mirroring, then retry",
        "iOS does not share the screen during a phone or FaceTime call, while the camera or microphone is in use, "
        "or while Siri is active",
    ],
    "stream_failed": ["The iPhone's media-stream daemon may be wedged: restart the iPhone and retry"],
    "connection_lost": [
        "The tunnel to the iPhone dropped; the next command reconnects. Keep the phone awake and connected",
    ],
    "device_timeout": ["The iPhone did not answer in time; keep it awake and unlocked and retry"],
    "pair_timeout": [
        "Open Settings > Developer > Paired Macs on the iPhone while pairing runs: the phone only looks for Macs "
        "while that screen is open",
        "The Mac and the iPhone must be on the same Wi-Fi network",
        "If this Mac was paired before and its record was deleted here, retry pairing with fresh: true",
    ],
    "usbmuxd_unavailable": ["usbmuxd is not running (it ships with macOS); reconnect the phone or restart the Mac"],
}


class SidecarError(Exception):
    def __init__(self, code: str, message: str, hints: Optional[list[str]] = None, **details: Any) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.hints = list(hints) if hints is not None else list(HINTS.get(code, []))
        self.details = {k: v for k, v in details.items() if v is not None}

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"code": self.code, "message": self.message, "hints": self.hints}
        if self.details:
            out["details"] = self.details
        return out


def bad_request(message: str) -> SidecarError:
    return SidecarError("bad_request", message, [])


def _exc_chain(e: BaseException) -> list[BaseException]:
    out: list[BaseException] = []
    stack = [e]
    while stack and len(out) < 32:
        cur = stack.pop()
        if cur in out:
            continue
        out.append(cur)
        for nxt in (cur.__cause__, cur.__context__):
            if nxt is not None:
                stack.append(nxt)
        if isinstance(cur, BaseExceptionGroup):
            stack.extend(cur.exceptions)
    return out


def map_exception(e: BaseException, wifi: bool = False) -> SidecarError:
    """Translate a pymobiledevice3 / OS exception into a sidecar error code. Pure name-based matching, so it
    works without importing pymobiledevice3 (and is unit-testable)."""
    if isinstance(e, SidecarError):
        return e
    chain = _exc_chain(e)
    names = {type(x).__name__ for x in chain for _ in [0]} | {
        base.__name__ for x in chain for base in type(x).__mro__
    }
    text = " | ".join(f"{type(x).__name__}: {x}" for x in chain)[:1500]
    msg = str(e) or type(e).__name__

    for x in chain:
        if isinstance(x, OSError) and x.errno in LAN_ERRNOS and wifi:
            return SidecarError("local_network_denied", f"LAN access denied ({os.strerror(x.errno)}): {msg}")
    for x in chain:
        if isinstance(x, OSError) and x.errno in LAN_ERRNOS | {errno.EADDRNOTAVAIL, errno.ENETDOWN}:
            # Through remoted's / usbmuxd's tunnel this means the tunnel moved (phone slept or Wi-Fi roamed and the
            # tunnel came back on a new address). Without a reconnect every later call failed instantly.
            return SidecarError("connection_lost", f"The tunnel to the iPhone went away ({os.strerror(x.errno)}): {msg}")
    if "ConnectionFailedToUsbmuxdError" in names:
        return SidecarError("usbmuxd_unavailable", f"Cannot reach usbmuxd: {msg}")
    if names & {"PairingDialogResponsePendingError"}:
        return SidecarError("not_paired", "Waiting for Trust on the iPhone: unlock it and tap Trust", [
            "Unlock the iPhone and tap Trust, then retry (or connect with trustTimeoutSec to wait)"])
    if names & {"UserDeniedPairingError"}:
        return SidecarError("not_paired", "The iPhone declined pairing (Don't Trust was tapped)", [
            "Unplug and replug the cable to get the Trust prompt again, or reset it in Settings > Developer > Clear "
            "Trusted Computers"])
    if names & {"PasswordRequiredError", "PasscodeRequiredError"}:
        return SidecarError("locked", f"The iPhone is locked: {msg}")
    if names & {"NotPairedError", "InvalidHostIDError", "FatalPairingError", "NotTrustedError"}:
        return SidecarError("not_paired", f"This Mac is not paired with the iPhone: {msg}")
    if names & {"NoDeviceConnectedError", "DeviceNotFoundError"}:
        return SidecarError("no_device", f"iPhone not found: {msg}")
    if names & {"_RemotePairingError"}:
        if "Pairing with the device failed" in text:
            return SidecarError("not_paired", f"remotepairingd: {msg}")
        return SidecarError("no_device", f"Apple's tunnel to the iPhone is not available: {msg}", [
            "Wake and unlock the iPhone; `xcrun devicectl list devices` should show it as available (paired)",
            "Same Wi-Fi network as this Mac (or connect the cable)"])
    if names & {"DeveloperModeIsNotEnabledError", "DeveloperModeError"}:
        return SidecarError("developer_mode_off", f"Developer Mode is off: {msg}")
    if names & {"DeveloperDiskImageNotFoundError", "NotMountedError"}:
        return SidecarError("ddi_missing", f"Developer disk image not mounted: {msg}")
    if names & {"DeviceVersionNotSupportedError"}:
        return SidecarError("ios_too_old", msg)
    for x in chain:
        if type(x).__name__ == "CoreDeviceError" and getattr(x, "code", None) == 9022:
            return SidecarError("stream_busy", "The iPhone's camera or microphone is in use, so iOS refuses to share "
                                "the screen (input needs a screen stream)")
    if re.search(r"ui ?automation", text, re.I):
        return SidecarError("ui_automation_off", f"UI Automation appears to be disabled: {msg}")
    if names & {"DeviceFeatureNotSupportedError"}:
        return SidecarError("not_supported", msg, [])
    if names & {"ConnectionTerminatedError", "StreamClosedError", "ConnectionResetError", "BrokenPipeError",
                "IncompleteReadError", "NotConnectedError", "ConnectionAbortedError", "ChannelClosedError"}:
        return SidecarError("connection_lost", f"Connection to the iPhone was lost: {msg}")
    if names & {"TimeoutError", "RemoteXPCHandshakeTimeoutError"}:
        return SidecarError("device_timeout", f"The iPhone did not answer in time: {msg}")
    if names & {"PskCipherNotSupportedError"}:
        return SidecarError("internal", msg, ["Use an OpenSSL-based Python for pymobiledevice3 (e.g. Homebrew's)"])
    for x in chain:
        if isinstance(x, ConnectionError) or (isinstance(x, OSError) and x.errno in (errno.ECONNREFUSED, errno.EPIPE)):
            return SidecarError("connection_lost", f"Connection to the iPhone failed: {msg}")
    return SidecarError("internal", f"{type(e).__name__}: {msg}", [], trace=text)


# ═════════════════════════════════════════════════════════════════════════════════════════════════
# Pure helpers (no pymobiledevice3, unit-tested)
# ═════════════════════════════════════════════════════════════════════════════════════════════════

def parse_version(v: Any) -> tuple[int, ...]:
    parts = re.findall(r"\d+", str(v or ""))
    return tuple(int(p) for p in parts[:3]) if parts else (0,)


def png_size(data: bytes) -> tuple[int, int]:
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        raise ValueError("not a PNG")
    return struct.unpack(">II", data[16:24])


def make_png(width: int, height: int, rgb: tuple[int, int, int] = (40, 120, 200)) -> bytes:
    """Solid-colour PNG (fake mode)."""
    row = b"\x00" + bytes(rgb) * width
    raw = zlib.compress(row * height, 6)

    def chunk(tag: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", raw) + chunk(b"IEND", b""))


def num(args: dict[str, Any], key: str, default: Optional[float] = None, *, lo: Optional[float] = None,
        hi: Optional[float] = None) -> float:
    v = args.get(key, default)
    if v is None:
        raise bad_request(f"missing argument: {key}")
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        try:
            v = float(v)
        except (TypeError, ValueError):
            raise bad_request(f"argument {key} must be a number, got {v!r}") from None
    v = float(v)
    if not math.isfinite(v):
        raise bad_request(f"argument {key} must be finite")
    if lo is not None and v < lo:
        raise bad_request(f"argument {key} must be >= {lo}, got {v:g}")
    if hi is not None and v > hi:
        raise bad_request(f"argument {key} must be <= {hi}, got {v:g}")
    return v


def text_arg(args: dict[str, Any], key: str, *, allow_empty: bool = False) -> str:
    v = args.get(key)
    if not isinstance(v, str) or (not v and not allow_empty):
        raise bad_request(f"argument {key} must be a non-empty string")
    return v


def to_hid(x: float, y: float, width: int, height: int) -> tuple[int, int]:
    """Screenshot pixel -> HID 0..65535 per axis: pixel / size * 65535 (verified on an iPhone 16 Pro Max, 1320x2868).
    A pixel of slack is tolerated and clamped."""
    if width < 2 or height < 2:
        raise bad_request(f"unknown screen size {width}x{height}")
    for name, v, lim in (("x", x, width), ("y", y, height)):
        if not math.isfinite(v) or v < -1 or v > lim + 1:
            raise bad_request(f"{name}={v:g} is outside the screen ({width}x{height} screenshot pixels)")
    hx = round(min(max(x, 0.0), float(width)) * HID_MAX / width)
    hy = round(min(max(y, 0.0), float(height)) * HID_MAX / height)
    return min(hx, HID_MAX), min(hy, HID_MAX)


class Contact(NamedTuple):
    identity: int
    x: int
    y: int
    touching: bool = True


# A gesture is a list of steps: ("t1", state, hx, hy) single-contact report (the shape Xcode sends),
# ("mt", [Contact...]) multi-contact report, ("sleep", seconds).
Step = tuple


def rtcp_receiver_report(our_ssrc: int, device_ssrc: int, ext_seq: int) -> bytes:
    """RTCP RR + empty-CNAME SDES compound (RFC 3550), byte-compatible with pymobiledevice3's screen streamer."""
    rr = struct.pack("!BBHII BBBB IIII", 0x81, 0xC9, 7, our_ssrc & 0xFFFFFFFF, device_ssrc & 0xFFFFFFFF, 0, 0, 0, 0,
                     ext_seq & 0xFFFFFFFF, 0, 0, 0)
    return rr + struct.pack("!BBHI BBBB", 0x81, 0xCA, 2, our_ssrc & 0xFFFFFFFF, 1, 0, 0, 0)


def gesture_tap(hx: int, hy: int, hold: float = 0.05) -> list[Step]:
    return [("t1", TOUCH_CONTACT, hx, hy), ("sleep", hold), ("t1", TOUCH_RELEASE, hx, hy)]


def gesture_double_tap(hx: int, hy: int, gap: float = 0.08) -> list[Step]:
    return gesture_tap(hx, hy) + [("sleep", gap)] + gesture_tap(hx, hy)


def gesture_long_press(hx: int, hy: int, ms: float) -> list[Step]:
    # Real digitizers keep reporting a held finger; resend the contact every ~100 ms while holding.
    n = max(1, round(ms / 100))
    steps: list[Step] = [("t1", TOUCH_CONTACT, hx, hy)]
    for _ in range(n):
        steps += [("sleep", ms / 1000 / n), ("t1", TOUCH_CONTACT, hx, hy)]
    return steps + [("t1", TOUCH_RELEASE, hx, hy)]


def _frames(ms: float) -> int:
    return int(min(120, max(5, round(ms / 16))))


def gesture_drag(h1: tuple[int, int], h2: tuple[int, int], ms: float) -> list[Step]:
    """Streaming CONTACT samples from h1 to h2 then RELEASE (pymobiledevice3's `_do_drag` shape)."""
    n = _frames(ms)
    dt = ms / 1000 / n
    (x1, y1), (x2, y2) = h1, h2
    steps: list[Step] = []
    for i in range(n):
        t = i / n
        steps += [("t1", TOUCH_CONTACT, round(x1 + (x2 - x1) * t), round(y1 + (y2 - y1) * t)), ("sleep", dt)]
    return steps + [("t1", TOUCH_CONTACT, x2, y2), ("t1", TOUCH_RELEASE, x2, y2)]


def gesture_multi_drag(paths: list[tuple[int, int, int, int]], ms: float) -> list[Step]:
    """All fingers down, move together, lift together (pymobiledevice3's `multi_drag` shape)."""
    if not 1 <= len(paths) <= 5:
        raise bad_request("need 1..5 fingers")
    n = _frames(ms)

    def frame(t: float, touching: bool = True) -> list[Contact]:
        return [Contact(i, round(a + (c - a) * t), round(b + (d - b) * t), touching)
                for i, (a, b, c, d) in enumerate(paths)]

    steps: list[Step] = [("mt", frame(0))]
    for i in range(1, n + 1):
        steps += [("sleep", ms / 1000 / n), ("mt", frame(i / n))]
    return steps + [("mt", frame(1, touching=False))]


def pinch_paths(cx: float, cy: float, scale: float, width: int, height: int) -> list[tuple[float, float, float, float]]:
    """Two fingers on a diagonal through (cx, cy). scale > 1 spreads them (zoom in), < 1 brings them together.
    Returns per-finger (x1, y1, x2, y2) in screenshot pixels, clamped to the screen."""
    if scale <= 0:
        raise bad_request("scale must be > 0")
    m = min(width, height)
    big, small = 0.7 * m, 0.08 * m
    if scale >= 1:
        d1 = big
        d0 = max(small, d1 / scale)
    else:
        d0 = big
        d1 = max(small, d0 * scale)
    ux = uy = math.sqrt(0.5)

    def clamp(x: float, y: float) -> tuple[float, float]:
        return min(max(x, 0.0), width - 1.0), min(max(y, 0.0), height - 1.0)

    out = []
    for sign in (-1, 1):
        a = clamp(cx + sign * d0 / 2 * ux, cy + sign * d0 / 2 * uy)
        b = clamp(cx + sign * d1 / 2 * ux, cy + sign * d1 / 2 * uy)
        out.append((a[0], a[1], b[0], b[1]))
    return out


# HID keyboard usages (page 0x07)
KEY_USAGES: dict[str, int] = {
    "enter": 0x28, "return": 0x28, "escape": 0x29, "esc": 0x29, "delete": 0x2A, "backspace": 0x2A, "tab": 0x2B,
    "space": 0x2C, "forward_delete": 0x4C, "right": 0x4F, "left": 0x50, "down": 0x51, "up": 0x52,
    "home_key": 0x4A, "end": 0x4D, "page_up": 0x4B, "page_down": 0x4E,
    **{f"f{i}": 0x3A + i - 1 for i in range(1, 13)},
}
MODIFIERS: dict[str, int] = {
    "cmd": 0xE3, "command": 0xE3, "gui": 0xE3, "meta": 0xE3, "shift": 0xE1, "ctrl": 0xE0, "control": 0xE0,
    "alt": 0xE2, "option": 0xE2, "opt": 0xE2,
}
KEY_LEFT_SHIFT, KEY_LEFT_GUI, KEY_V = 0xE1, 0xE3, 0x19


def ascii_map() -> dict[str, tuple[int, bool]]:
    from pymobiledevice3.remote.core_device.hid_service import ASCII_TO_HID
    return ASCII_TO_HID


def parse_key_combo(name: str) -> tuple[list[int], int]:
    """'enter', 'cmd+a', 'shift+tab', 'A' -> (modifier usages, key usage)."""
    raw = name.strip()
    parts = [p for p in re.split(r"\s*\+\s*", raw) if p] if len(raw) > 1 else [raw]
    if not parts:
        raise bad_request("empty key name")
    mods: list[int] = []
    for p in parts[:-1]:
        u = MODIFIERS.get(p.lower())
        if u is None:
            raise bad_request(f"unknown modifier {p!r} (cmd, shift, ctrl, alt)")
        mods.append(u)
    key = parts[-1]
    usage = KEY_USAGES.get(key.lower().replace("-", "_"))
    if usage is None and len(key) == 1:
        mapped = ascii_map().get(key)
        if mapped is not None:
            usage, shifted = mapped
            if shifted and KEY_LEFT_SHIFT not in mods:
                mods.append(KEY_LEFT_SHIFT)
    if usage is None:
        raise bad_request(f"unknown key {key!r}; known: {', '.join(sorted(set(KEY_USAGES)))} or a single character")
    return mods, usage


def plan_text(text: str) -> list[tuple[str, Any]]:
    """Split text into ('key', (mods, usage)) presses for US-ASCII and ('paste', str) runs for everything else."""
    amap = ascii_map()
    out: list[tuple[str, Any]] = []
    pending = ""
    for ch in text.replace("\r\n", "\n"):
        m = amap.get(ch)
        if m is None:
            pending += ch
            continue
        if pending:
            out.append(("paste", pending))
            pending = ""
        usage, shifted = m
        out.append(("key", ([KEY_LEFT_SHIFT] if shifted else [], usage)))
    if pending:
        out.append(("paste", pending))
    return out


# Named hardware buttons -> (usage page, usage, hold seconds); values from pymobiledevice3's `hid button` CLI
BUTTONS: dict[str, tuple[int, int, float]] = {
    "home": (0x0C, 0x40, 0.05),
    "lock": (0x0C, 0x30, 0.5),
    "power": (0x0C, 0x30, 0.5),
    "volume_up": (0x0C, 0xE9, 0.05),
    "volume_down": (0x0C, 0xEA, 0.05),
    "mute": (0x0C, 0xE2, 0.05),
    "siri": (0x0C, 0xCF, 1.0),
}
BUTTON_ALIASES = {"side": "lock", "sleep": "lock", "volume-up": "volume_up", "volume-down": "volume_down",
                  "volumeup": "volume_up", "volumedown": "volume_down", "app-switch": "app_switch"}

ORIENTATIONS = ["portrait", "landscapeLeft", "portraitUpsideDown", "landscapeRight"]  # one 'left' (CCW) step = +1


def orientation_goal(target: str) -> set[str]:
    t = target.strip()
    if t.lower() == "portrait":
        return {"portrait"}
    if t.lower() == "landscape":
        return {"landscapeLeft", "landscapeRight"}
    for o in ORIENTATIONS:
        if o.lower() == t.lower().replace("_", "").replace("-", ""):
            return {o}
    raise bad_request(f"unknown orientation {target!r} (portrait, landscape, landscapeLeft, landscapeRight, "
                      "portraitUpsideDown)")


def plan_rotation(current: Optional[str], goal: set[str]) -> list[str]:
    """Shortest list of 'left'/'right' 90 degree steps from `current` into `goal`. Unknown current -> one probing
    'left' step (the caller re-plans from the reported orientation)."""
    if current not in ORIENTATIONS:
        return ["left"]
    if current in goal:
        return []
    i = ORIENTATIONS.index(current)
    if ORIENTATIONS[(i + 1) % 4] in goal:
        return ["left"]
    if ORIENTATIONS[(i - 1) % 4] in goal:
        return ["right"]
    return ["left", "left"]


def find_size(obj: Any, depth: int = 0) -> Optional[tuple[int, int]]:
    """Best-effort pixel size from CoreDevice display info (shape not documented): prefer a 'currentMode' size."""
    if depth > 8:
        return None
    if isinstance(obj, dict):
        for key in ("currentMode", "nativeMode", "size", "pixelSize", "resolution"):
            if key in obj:
                got = find_size(obj[key], depth + 1)
                if got:
                    return got
        w = obj.get("width", obj.get("Width", obj.get("pixelWidth")))
        h = obj.get("height", obj.get("Height", obj.get("pixelHeight")))
        if isinstance(w, (int, float)) and isinstance(h, (int, float)) and w > 100 and h > 100:
            return int(w), int(h)
        for v in obj.values():
            got = find_size(v, depth + 1)
            if got:
                return got
    elif isinstance(obj, (list, tuple)):
        if len(obj) == 2 and all(isinstance(v, (int, float)) and v > 100 for v in obj):
            return int(obj[0]), int(obj[1])
        for v in obj:
            got = find_size(v, depth + 1)
            if got:
                return got
    elif isinstance(obj, str):
        m = re.fullmatch(r"\{?\s*(\d{3,5})\s*[,x ]\s*(\d{3,5})\s*\}?", obj.strip())
        if m:
            return int(m.group(1)), int(m.group(2))
    return None


def find_scale(obj: Any, depth: int = 0) -> Optional[float]:
    if depth > 8:
        return None
    if isinstance(obj, dict):
        for k, v in obj.items():
            if str(k).lower() in ("scale", "pointscale", "displayscale", "nativescale", "screenscale") and \
                    isinstance(v, (int, float)) and not isinstance(v, bool) and 1 <= v <= 4:
                return float(v)
        for v in obj.values():
            got = find_scale(v, depth + 1)
            if got:
                return got
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            got = find_scale(v, depth + 1)
            if got:
                return got
    return None


def estimate_scale(width: int, height: int) -> float:
    """iPhones: @3x from 1080 px on the short side, else @2x (iPads are @2x)."""
    return 3.0 if min(width, height) >= 1080 and max(width, height) / max(1, min(width, height)) > 1.6 else 2.0


def find_bool(obj: Any, keys: set[str], depth: int = 0) -> Optional[bool]:
    if depth > 6:
        return None
    if isinstance(obj, dict):
        for k, v in obj.items():
            if str(k).lower() in keys and isinstance(v, bool):
                return v
        for v in obj.values():
            got = find_bool(v, keys, depth + 1)
            if got is not None:
                return got
    return None


def find_int(obj: Any, key: str, depth: int = 0) -> Optional[int]:
    if depth > 8:
        return None
    if isinstance(obj, dict):
        v = obj.get(key)
        if isinstance(v, int) and not isinstance(v, bool):
            return v
        for v in obj.values():
            got = find_int(v, key, depth + 1)
            if got is not None:
                return got
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            got = find_int(v, key, depth + 1)
            if got is not None:
                return got
    return None


def app_entry(a: dict[str, Any]) -> dict[str, Any]:
    bid = a.get("bundleIdentifier") or a.get("bundleID") or a.get("CFBundleIdentifier")
    name = a.get("name") or a.get("displayName") or a.get("CFBundleDisplayName") or a.get("CFBundleName")
    version = a.get("version") or a.get("bundleShortVersion") or a.get("CFBundleShortVersionString")
    removable = a.get("isRemovable", a.get("removable"))
    first_party = a.get("isFirstParty", a.get("firstParty"))
    system = bool(first_party) if first_party is not None else (removable is False if removable is not None else
                                                               bool(bid and str(bid).startswith("com.apple.")))
    out = {"bundleId": bid, "name": name, "version": version, "system": system}
    for k in ("isHidden", "isAppClip", "isDeveloperApp", "path", "url"):
        if k in a and isinstance(a[k], (str, bool, int)):
            out[k] = a[k]
    return out


def json_default(o: Any) -> Any:
    if isinstance(o, (bytes, bytearray, memoryview)):
        return base64.b64encode(bytes(o)).decode()
    if isinstance(o, (datetime.datetime, datetime.date)):
        return o.isoformat()
    if isinstance(o, uuid.UUID):
        return str(o)
    if isinstance(o, (set, frozenset, tuple)):
        return list(o)
    if hasattr(o, "_asdict"):
        return o._asdict()
    if isinstance(o, int):
        return int(o)
    if hasattr(o, "data") and isinstance(getattr(o, "data"), (int, str)):  # plistlib.UID and friends
        return o.data
    return repr(o)


# ── iOS 27 remote accessibility tree ─────────────────────────────────────────────────────────────
# com.apple.accessibility.axAuditDaemon.remoteAXService speaks DTX. After the control-channel call
# `clientNeedsAccessibility:` YES the phone pushes `processDataFromRemoteDevice:` messages whose argument is an
# NSKeyedArchive of AXPTranslatorResponse. A "treeDump" response (treeDumpType AXPTreeDumpTypeInitialDump, then
# AXPTreeDumpTypeAdditionalData ~0.3 s later with more attributes) describes the frontmost app: request type 4 = the
# application object, request type 5 = an attribute map for one AXPTranslationObject {objectID, pid}. Other pushes
# are change notifications. Every `clientNeedsAccessibility:` YES yields a fresh dump (~1.0-1.3 s); NO ends the
# session (the phone closes the connection). Attribute numbers below were mapped from live dumps (iOS 27.0).
AX_LABEL, AX_TITLE, AX_HINT, AX_VALUE, AX_ID = 3, 33, 23, 53, 86
AX_CHILDREN, AX_CHILDREN_ALT, AX_FRAME, AX_FRAME_ALT = 9, 8, 21, 48
AX_ROLE, AX_TYPE, AX_TRAITS, AX_TRAIT_NAMES, AX_HOST_PID = 45, 61, 77, 78, 65
AX_ROLE_APP, AX_ROLE_CONTAINER = 1, 4

# XCUIElementType raw values (AX_TYPE carries them: 9 Button, 20 Key, 48 StaticText, 75 Cell were observed)
XCUI_TYPES = (
    "Any Other Application Group Window Sheet Drawer Alert Dialog Button RadioButton RadioGroup CheckBox "
    "DisclosureTriangle PopUpButton ComboBox MenuButton ToolbarButton Popover Keyboard Key NavigationBar TabBar "
    "TabGroup Toolbar StatusBar Table TableRow TableColumn Outline OutlineRow Browser CollectionView Slider "
    "PageIndicator ProgressIndicator ActivityIndicator SegmentedControl Picker PickerWheel Switch Toggle Link Image "
    "Icon SearchField ScrollView ScrollBar StaticText TextField SecureTextField DatePicker TextView Menu MenuItem "
    "MenuBar MenuBarItem Map WebView IncrementArrow DecrementArrow Timeline RatingIndicator ValueIndicator SplitGroup "
    "Splitter RelevanceIndicator ColorWell HelpTag Matte DockItem Ruler RulerMarker Grid LevelIndicator Cell "
    "LayoutArea LayoutItem Handle Stepper Tab TouchBar StatusItem"
).split()

# UIAccessibilityTraits bits (public ones plus textEntry, which UIKit sets on text inputs)
TRAIT_BITS = [(0, "Button"), (1, "Link"), (2, "Image"), (3, "Selected"), (4, "Plays Sound"), (5, "Keyboard Key"),
              (6, "Static Text"), (7, "Summary Element"), (8, "Not Enabled"), (9, "Updates Frequently"),
              (10, "Search Field"), (11, "Starts Media Session"), (12, "Adjustable"), (13, "Allows Direct Interaction"),
              (14, "Causes Page Turn"), (15, "Tab Bar"), (16, "Header"), (18, "Text Entry")]
TRAIT_TYPE = [("Search Field", "SearchField"), ("Text Entry", "TextField"), ("Keyboard Key", "Key"),
              ("Button", "Button"), ("Link", "Link"), ("Adjustable", "Slider"), ("Tab Bar", "TabBar"),
              ("Image", "Image"), ("Header", "StaticText"), ("Static Text", "StaticText")]
CLICKABLE_TYPES = {"Button", "Key", "Link", "Cell", "Switch", "Toggle", "TextField", "SecureTextField", "SearchField",
                   "TextView", "MenuItem", "Tab", "RadioButton", "CheckBox", "SegmentedControl", "PopUpButton",
                   "MenuButton", "Icon"}


def ns_unarchive(data: bytes) -> Any:
    """Minimal NSKeyedArchiver decoder: NSDictionary/NSArray/NSSet -> dict/list, NSString/NSData/NSDate -> value,
    other classes -> {"$class": name, **fields}. Shared objects are decoded once (cycles are safe)."""
    import plistlib
    p = plistlib.loads(data)
    if not isinstance(p, dict) or "$objects" not in p or "$top" not in p:
        raise ValueError("not an NSKeyedArchive")
    objs = p["$objects"]
    memo: dict[int, Any] = {}

    def res(v: Any) -> Any:
        if isinstance(v, plistlib.UID):
            i = v.data
            if i in memo:
                return memo[i]
            if not 0 <= i < len(objs):
                raise ValueError(f"bad archive reference {i}")
            o = objs[i]
            if o == "$null":
                return None
            if not (isinstance(o, dict) and "$class" in o):
                return res(o)
            cls_ref = o["$class"]
            cls = objs[cls_ref.data].get("$classname") if isinstance(cls_ref, plistlib.UID) else None
            if "NS.keys" in o and "NS.objects" in o:
                out_d: dict[str, Any] = {}
                memo[i] = out_d
                for k, val in zip(o["NS.keys"], o["NS.objects"]):
                    out_d[str(res(k))] = res(val)
                return out_d
            if "NS.objects" in o:
                out_l: list[Any] = []
                memo[i] = out_l
                out_l.extend(res(x) for x in o["NS.objects"])
                return out_l
            for key in ("NS.string", "NS.bytes", "NS.data", "NS.time", "NS.uuidbytes"):
                if key in o:
                    memo[i] = res(o[key])
                    return memo[i]
            out_o: dict[str, Any] = {"$class": cls}
            memo[i] = out_o
            for k, val in o.items():
                if k != "$class":
                    out_o[k] = res(val)
            return out_o
        if isinstance(v, list):
            return [res(x) for x in v]
        if isinstance(v, dict):
            return {k: res(x) for k, x in v.items()}
        return v

    top = p["$top"]
    return res(top.get("root", next(iter(top.values()), None)))


def ax_rect(v: Any) -> Optional[tuple[float, float, float, float]]:
    """NSValue rect ('{{x, y}, {w, h}}') -> (x, y, w, h) in points."""
    if isinstance(v, dict):
        v = v.get("NS.rectval")
    if not isinstance(v, str):
        return None
    nums = re.findall(r"-?\d+(?:\.\d+)?(?:e-?\d+)?", v)
    if len(nums) != 4:
        return None
    x, y, w, h = (float(n) for n in nums)
    return x, y, w, h


class AxState:
    """Latest accessibility tree pushed by the phone (one generation per InitialDump)."""

    def __init__(self) -> None:
        self.generation = 0
        self.app: Optional[tuple[Any, Any]] = None  # (objectID, pid)
        self.objects: dict[Any, dict[str, Any]] = {}  # objectID -> {"pid": int, "a": {attr: value}}
        self.children: list[tuple[Any, Any]] = []  # navigation order under the application
        self.complete = False  # AdditionalData merged
        self.received_at: Optional[float] = None  # time.monotonic() of the last InitialDump
        self.updated_at: Optional[float] = None
        self.notifications = 0  # change notifications since the last InitialDump

    def feed(self, root: Any, now: Optional[float] = None) -> str:
        """Apply one decoded AXPTranslatorResponse. Returns 'initial', 'additional', 'notification' or 'ignored'."""
        now = time.monotonic() if now is None else now
        if not isinstance(root, dict):
            return "ignored"
        rd = root.get("resultData")
        if not (isinstance(rd, dict) and isinstance(rd.get("treeDump"), list)):
            if root.get("notification"):
                self.notifications += 1
                return "notification"
            return "ignored"
        initial = "Initial" in str(rd.get("treeDumpType") or "")
        app: Optional[tuple[Any, Any]] = None
        objects: dict[Any, dict[str, Any]] = {}
        for r in rd["treeDump"]:
            if not isinstance(r, dict):
                continue
            kind, res, to = r.get("associatedRequestType"), r.get("resultData"), r.get("associatedTranslationObject")
            if kind == 4 and isinstance(res, dict) and res.get("objectID") is not None:
                app = (res.get("objectID"), res.get("pid"))
            elif kind == 5 and isinstance(to, dict) and to.get("objectID") is not None and isinstance(res, dict):
                e = objects.setdefault(to["objectID"], {"pid": to.get("pid"), "a": {}})
                for k, val in res.items():
                    if str(k).isdigit():
                        e["a"][int(k)] = val
        if initial or self.app is None or (app is not None and app[0] != self.app[0]):
            self.generation += 1
            self.app = app or (next(iter(objects)) if objects else None, None)
            self.objects = objects
            self.complete = False
            self.received_at = now
            self.notifications = 0
            kind_out = "initial"
        else:
            for oid, e in objects.items():
                cur = self.objects.setdefault(oid, {"pid": e["pid"], "a": {}})
                cur["a"].update(e["a"])
            self.complete = True
            kind_out = "additional"
        app_attrs = self.objects.get(self.app[0], {}).get("a", {}) if self.app else {}
        kids = app_attrs.get(AX_CHILDREN) or app_attrs.get(AX_CHILDREN_ALT)
        if isinstance(kids, list):
            self.children = [(k.get("objectID"), k.get("pid")) for k in kids if isinstance(k, dict)]
        elif kind_out == "initial":
            self.children = []
        self.updated_at = now
        return kind_out


def ax_traits(a: dict[int, Any]) -> tuple[int, list[str]]:
    bits = a.get(AX_TRAITS)
    bits = int(bits) if isinstance(bits, int) and not isinstance(bits, bool) else 0
    names = a.get(AX_TRAIT_NAMES)
    if isinstance(names, list) and all(isinstance(n, str) for n in names):
        out = list(names)
        for b, n in TRAIT_BITS:  # keep state bits that the readable list omits
            if bits >> b & 1 and n in ("Selected", "Not Enabled", "Text Entry") and n not in out:
                out.append(n)
        return bits, out
    return bits, [n for b, n in TRAIT_BITS if bits >> b & 1]


def ax_type(a: dict[int, Any], traits: list[str]) -> str:
    t = a.get(AX_TYPE)
    if isinstance(t, int) and not isinstance(t, bool) and 1 < t < len(XCUI_TYPES):
        return XCUI_TYPES[t]
    for trait, name in TRAIT_TYPE:
        if trait in traits:
            return name
    return "Other"


def ax_text(v: Any) -> Optional[str]:
    if v is None or isinstance(v, (dict, list, bytes)):
        return None
    if isinstance(v, bool):
        return "1" if v else "0"
    s = str(v)
    return s if s.strip() else None


def ax_elements(state: AxState, scale: float, screen_px: tuple[int, int], include_offscreen: bool = False,
                max_elements: int = 500) -> dict[str, Any]:
    """Flatten the pushed tree into elements with screenshot-pixel bounds.

    Elements of another process (pid != the app's pid, e.g. the keyboard) report frames relative to the view that
    hosts them; they are offset by the frame origin of the nearest preceding container element of the app
    (role 4, e.g. UISystemKeyboardDockController; consistent with the keyboard layout on iOS 27.0, not verified
    against a screenshot). Remote elements with no such container are left out and counted in `unplaced`."""
    width_px, height_px = screen_px
    app_oid, app_pid = state.app or (None, None)
    order = state.children or [(oid, e.get("pid")) for oid, e in state.objects.items() if oid != app_oid]
    host: Optional[tuple[float, float, Any]] = None  # (x, y, remote pid it hosts)
    elements: list[dict[str, Any]] = []
    offscreen = unplaced = 0
    truncated = False
    for oid, pid in order:
        e = state.objects.get(oid)
        if e is None or oid == app_oid:
            continue
        a = e["a"]
        pid = e.get("pid", pid)
        frame = ax_rect(a.get(AX_FRAME)) or ax_rect(a.get(AX_FRAME_ALT))
        remote = app_pid is not None and pid is not None and pid != app_pid
        if not remote:
            # a container of the app hosts the run of out-of-process elements that directly follows it
            host = (frame[0], frame[1], None) if a.get(AX_ROLE) == AX_ROLE_CONTAINER and frame else None
        if frame is None:
            offscreen += 1
            continue
        if remote:
            if host is None or host[2] not in (None, pid):
                # e.g. a Home Screen widget: its frame is local to a host view the dump does not include, so any
                # bounds would be wrong (verified: a photo widget reported {0,0} instead of its on-screen origin)
                unplaced += 1
                continue
            host = (host[0], host[1], pid)
            frame = (frame[0] + host[0], frame[1] + host[1], frame[2], frame[3])
        x0, y0 = frame[0] * scale, frame[1] * scale
        x1, y1 = (frame[0] + frame[2]) * scale, (frame[1] + frame[3]) * scale
        cx0, cy0, cx1, cy1 = max(0.0, x0), max(0.0, y0), min(float(width_px), x1), min(float(height_px), y1)
        visible = cx1 - cx0 >= 1 and cy1 - cy0 >= 1
        if not visible:
            offscreen += 1
            if not include_offscreen:
                continue
            cx0, cy0, cx1, cy1 = x0, y0, x1, y1
        bits, traits = ax_traits(a)
        typ = ax_type(a, traits)
        label = ax_text(a.get(AX_LABEL)) or ax_text(a.get(AX_TITLE))
        value = ax_text(a.get(AX_VALUE))
        item: dict[str, Any] = {
            "type": typ, "label": label, "value": value, "hint": ax_text(a.get(AX_HINT)), "id": ax_text(a.get(AX_ID)),
            "traits": traits, "enabled": "Not Enabled" not in traits, "selected": "Selected" in traits,
            "clickable": typ in CLICKABLE_TYPES or any(t in traits for t in ("Button", "Link", "Keyboard Key")),
            "bounds": {"x": round(cx0), "y": round(cy0), "width": round(cx1 - cx0), "height": round(cy1 - cy0)},
            "frame": {"x": round(frame[0], 2), "y": round(frame[1], 2), "width": round(frame[2], 2),
                      "height": round(frame[3], 2)},
            "pid": pid,
        }
        if not visible:
            item["offscreen"] = True
        if remote:
            item["remote"] = True
        if typ in ("Switch", "Toggle") or "Toggle" in traits:
            item["checked"] = value in ("1", "on", "On", "true")
        elements.append(item)
        if len(elements) >= max_elements:
            truncated = True
            break
    app_a = state.objects.get(app_oid, {}).get("a", {}) if app_oid is not None else {}
    return {"app": {"pid": app_pid, "label": ax_text(app_a.get(AX_LABEL)) or ax_text(app_a.get(AX_TITLE))},
            "elements": elements, "offscreen": offscreen, "unplaced": unplaced, "truncated": truncated}


# ═════════════════════════════════════════════════════════════════════════════════════════════════
# Device access
# ═════════════════════════════════════════════════════════════════════════════════════════════════

async def native_devices(timeout: float = 1.0) -> list[dict[str, Any]]:
    """Phones macOS's remotepairingd knows (local XPC to the Mac's daemon only; nothing is sent to a phone)."""
    from pymobiledevice3.remote.native_tunnel import browse_native_devices
    out = []
    for d in await browse_native_devices(timeout=timeout):
        auth = (d.get("authState") or {}).get("rawCase") if isinstance(d.get("authState"), dict) else None
        conn = d.get("connectionState") if isinstance(d.get("connectionState"), dict) else {}
        value = conn.get("value") if isinstance(conn.get("value"), dict) else {}
        out.append({"udid": d.get("udid"), "name": d.get("name"), "model": d.get("model"), "authState": auth,
                    "paired": auth == "authenticated", "connected": conn.get("rawCase") == "connected",
                    "attachedPhysically": value.get("attachedPhysically"),
                    "transport": d.get("transportProtocolType"), "wireless": d.get("wirelessConnectivity")})
    return out


def parse_display_info(raw: Any) -> dict[str, Any]:
    """CoreDevice getdisplayinfo (iOS 27): {"orientation": {...}, "displays": [{"primary": true, "currentMode":
    {"size": [w, h]}, "pointScale": 3, "backlightState": "activeOn", ...}, ...]}."""
    out: dict[str, Any] = {}
    if not isinstance(raw, dict):
        return out
    disp = None
    for d in raw.get("displays") or []:
        if isinstance(d, dict) and (d.get("primary") or disp is None) and not d.get("external"):
            disp = d
            if d.get("primary"):
                break
    if disp is not None:
        size = (disp.get("currentMode") or {}).get("size") if isinstance(disp.get("currentMode"), dict) else None
        if isinstance(size, list) and len(size) == 2 and all(isinstance(v, (int, float)) for v in size) and size[0] > 0:
            out["width"], out["height"] = int(size[0]), int(size[1])
        sc = disp.get("pointScale")
        if isinstance(sc, (int, float)) and not isinstance(sc, bool) and sc > 0:
            out["scale"] = float(sc)
        if isinstance(disp.get("backlightState"), str):
            out["backlight"] = disp["backlightState"]
    o = raw.get("orientation")
    if isinstance(o, dict) and isinstance(o.get("currentDeviceOrientation"), str):
        out["orientation"] = o["currentDeviceOrientation"]
        out["orientationLocked"] = o.get("currentDeviceOrientationLocked")
    if "width" not in out:
        got = find_size(raw)
        if got:
            out["width"], out["height"] = got
    if "scale" not in out:
        sc2 = find_scale(raw)
        if sc2:
            out["scale"] = sc2
    return out


def pymd3_version() -> Optional[str]:
    try:
        from pymobiledevice3._version import __version__
        return str(__version__)
    except Exception:
        return None


def _provider_tunnel_class():
    """UserspaceRsdTunnel whose tunnel provider is supplied by the caller (USB / usbmux-network lockdown or a
    RemotePairing service). Mirrors UserspaceRsdTunnel._aopen_locked of pymobiledevice3 11.49.2; only the
    provider selection differs (the stock class only takes usbmux devices and never a pair-host record)."""
    from contextlib import AsyncExitStack

    from pymobiledevice3.exceptions import PyMobileDevice3Exception
    from pymobiledevice3.remote import tunnel_service
    from pymobiledevice3.remote import userspace_tunnel as ut
    from pymobiledevice3.remote.remote_service_discovery import RemoteServiceDiscoveryService

    class ProviderTunnel(ut.UserspaceRsdTunnel):
        def __init__(self, provider_factory: Callable[[], Awaitable[tuple[Any, list[Callable[[], Awaitable[Any]]]]]],
                     serial: Optional[str] = None) -> None:
            super().__init__(serial=serial, autopair=False, remotepairing_fallback=False)
            self._provider_factory = provider_factory

        async def _aopen_locked(self) -> RemoteServiceDiscoveryService:
            if ut._active_tunnel is not None:
                raise PyMobileDevice3Exception("A userspace tunnel is already active in this process")
            tunnel_service.USE_USERSPACE_TUNNEL = True
            stack = AsyncExitStack()
            try:
                provider, closers = await self._provider_factory()
                stack.push_async_callback(provider.close)
                for closer in closers:
                    stack.push_async_callback(closer)
                result = await stack.enter_async_context(provider.start_tcp_tunnel())
                self.tun = result.client.tun
                self.tun.set_peer(result.address)
                dial = await stack.enter_async_context(ut.UserspaceDialPlane(self.tun, result.address))
                rsd = RemoteServiceDiscoveryService((result.address, result.port), open_connection=dial.dial,
                                                    auxiliary_metadata=result.auxiliary_metadata)
                stack.push_async_callback(rsd.close)
                await rsd.connect()
            except BaseException:
                await stack.aclose()
                tunnel_service.USE_USERSPACE_TUNNEL = False
                self.tun = None
                raise
            self._exit_stack = stack
            self.rsd = rsd
            ut._active_tunnel = self
            ut.USERSPACE_ACTIVE = True
            self._transport_watcher = asyncio.create_task(self._watch_transport_closed(result.client))
            return rsd

    return ProviderTunnel


class AuthGatedHid:
    """universalhidservice + a running display media stream (the auth gate). Same steps as pymobiledevice3's
    `touch_session`, kept open across commands and with packet counters for health reporting. UNTESTED on hardware."""

    def __init__(self, rsd: Any) -> None:
        self.rsd = rsd
        self.display: Any = None
        self.transport: Any = None
        self.uhs: Any = None
        self.drain: Optional[asyncio.Task[None]] = None
        self.keepalive: Optional[asyncio.Task[None]] = None
        self.packets = 0
        self.last_packet: Optional[float] = None
        self.opened_at: Optional[float] = None
        self.keyboard_id: Optional[int] = None
        self.token: Optional[int] = None
        self.device_ssrc = 0
        self.rtcp_dest: Optional[tuple[str, int]] = None
        self.last_seq: Optional[int] = None
        self.seq_cycles = 0

    async def open(self) -> None:
        from pymobiledevice3.remote.core_device.display_service import DisplayService
        from pymobiledevice3.remote.core_device.hid_service import TOUCH_AUTH_SETTLE_SECONDS, UniversalHIDServiceService
        from pymobiledevice3.remote.core_device.screen_stream import open_media_receiver

        self.display = DisplayService(self.rsd)
        await self.display.connect()
        try:
            st: Any = None
            with contextlib.suppress(Exception):  # don't take the screen away from Xcode / iPhone Mirroring
                st = await asyncio.wait_for(self.display.get_media_stream_server_status(), 5)
            if isinstance(st, dict) and st.get("sessions"):
                raise SidecarError("stream_busy", "Another client is streaming this iPhone's screen (Xcode Device "
                                   "Hub, iPhone Mirroring or another PhoneDock sidecar)", streamServer=st)
            self.transport, receiver_ip = open_media_receiver(self.display, (1 * 1024 * 1024,))
            resp = await asyncio.wait_for(self.display.start_video_stream(
                receiver_ip=receiver_ip, receiver_port=self.transport.port, sender_ip=self.rsd.service.address[0],
                display_id=1), timeout=10.0)
            cfg = ((resp or {}).get("connection") or {}).get("streamConfig") or {}
            # Our stream token is RemoteSSRC; the phone's is LocalSSRC; RTCP goes to the phone's SourcePort.
            self.token = int(cfg.get("RemoteSSRC") or 0) or None
            self.device_ssrc = int(cfg.get("LocalSSRC") or 0)
            port = int(cfg.get("SourcePort") or 0)
            self.rtcp_dest = (self.rsd.service.address[0], port) if port else None
            await asyncio.sleep(TOUCH_AUTH_SETTLE_SECONDS)
            self.drain = asyncio.create_task(self._drain())
            self.keepalive = asyncio.create_task(self._rtcp_loop())
            self.uhs = UniversalHIDServiceService(self.rsd)
            await self.uhs.connect()
            self.opened_at = time.monotonic()
        except BaseException:
            await self.close()
            raise

    async def _drain(self) -> None:
        with contextlib.suppress(asyncio.CancelledError, OSError, Exception):
            while True:
                pkt = await self.transport.recv()
                self.packets += 1
                self.last_packet = time.monotonic()
                if len(pkt) >= 4 and pkt[0] >> 6 == 2 and not 64 <= (pkt[1] & 0x7F) <= 95:  # RTP, not RTCP
                    seq = pkt[2] << 8 | pkt[3]
                    if self.last_seq is not None and seq < self.last_seq and self.last_seq - seq > 30000:
                        self.seq_cycles += 1
                    self.last_seq = seq

    async def _rtcp_loop(self) -> None:
        """RTCP receiver report every second: the phone reaps a stream after RTCPTimeoutInterval (20 s) without one,
        which silently closes the input gate (measured on iOS 27.0)."""
        with contextlib.suppress(asyncio.CancelledError):
            while True:
                await asyncio.sleep(1.0)
                if self.rtcp_dest is None or not self.packets or self.token is None:
                    continue
                try:
                    await self.transport.sendto(rtcp_receiver_report(self.token, self.device_ssrc,
                                                                     self.seq_cycles << 16 | (self.last_seq or 0)),
                                                *self.rtcp_dest)
                except OSError as e:
                    log.info("RTCP send failed: %r", e)
                    return

    @property
    def alive(self) -> bool:
        """Open, and RTP still arriving (the phone sends ~100+ packets/s even for a static screen; a stall means the
        stream was reaped or another client replaced it)."""
        if self.uhs is None or self.drain is None or self.drain.done():
            return False
        if self.opened_at is not None and time.monotonic() - self.opened_at < 2.0:
            return True
        return self.last_packet is not None and time.monotonic() - self.last_packet < 2.0

    async def keyboard(self) -> int:
        if self.keyboard_id is None:
            self.keyboard_id = await self.uhs.create_keyboard_service()
        return self.keyboard_id

    def info(self) -> dict[str, Any]:
        now = time.monotonic()
        return {"open": self.alive, "packets": self.packets,
                "lastPacketAgeSec": round(now - self.last_packet, 2) if self.last_packet else None,
                "openForSec": round(now - self.opened_at, 1) if self.opened_at else None,
                "keyboard": self.keyboard_id is not None}

    async def close(self) -> None:
        for attr in ("keepalive", "drain"):
            task = getattr(self, attr)
            if task is not None:
                task.cancel()
                with contextlib.suppress(BaseException):
                    await task
                setattr(self, attr, None)
        if self.uhs is not None:
            with contextlib.suppress(Exception):
                await self.uhs.close()
            self.uhs = None
        if self.display is not None:
            with contextlib.suppress(Exception):
                # stop only our own session (identifier = our RemoteSSRC); stop_all would kill Xcode's mirroring too
                if self.token is not None:
                    await asyncio.wait_for(self.display.stop_media_stream(stop_all=False, identifiers=[self.token]), 5)
            with contextlib.suppress(Exception):
                await self.display.close()
            self.display = None
        if self.transport is not None:
            with contextlib.suppress(Exception):
                self.transport.close()
            self.transport = None
        self.keyboard_id = None


class AxSession:
    """Persistent DTX session with the iOS 27 remoteAXService (see the AX notes above). Verified read-only on
    iOS 27.0 over the native transport: no focus movement, no activation."""

    def __init__(self, rsd: Any) -> None:
        self.rsd = rsd
        self.provider: Any = None
        self.queue: Optional[asyncio.Queue[Any]] = None
        self.reader: Optional[asyncio.Task[None]] = None
        self.state = AxState()
        self.changed = asyncio.Event()
        self.last_used = time.monotonic()
        self.decode_errors = 0

    async def open(self) -> None:
        from pymobiledevice3.dtx_service_provider import DtxServiceProvider

        class RemoteAX(DtxServiceProvider):
            SERVICE_NAME = SVC_REMOTE_AX
            RSD_SERVICE_NAME = SVC_REMOTE_AX

        self.provider = RemoteAX(self.rsd)
        await asyncio.wait_for(self.provider.connect(), 10)
        self.queue = asyncio.Queue()
        self.provider.dtx.ctx["control_dispatch_queue"] = self.queue  # unknown control selectors land here
        self.reader = asyncio.create_task(self._read())

    async def _read(self) -> None:
        assert self.queue is not None
        while True:
            selector, args = await self.queue.get()
            if selector != "processDataFromRemoteDevice:" or not args or not isinstance(args[0], (bytes, bytearray)):
                continue
            try:
                kind = self.state.feed(ns_unarchive(bytes(args[0])))
            except Exception as e:  # keep the session alive on one bad payload
                self.decode_errors += 1
                log.info("unreadable accessibility payload: %r", e)
                continue
            if kind in ("initial", "additional"):
                self.changed.set()

    @property
    def alive(self) -> bool:
        if self.provider is None or self.reader is None or self.reader.done():
            return False
        try:
            self.provider.dtx._ctrl_channel._check_open()
        except Exception:
            return False
        return True

    async def request(self) -> None:
        await asyncio.wait_for(self.provider.dtx._ctrl_channel.invoke("clientNeedsAccessibility:", True,
                                                                      expects_reply=True), 8)

    async def snapshot(self, timeout: float, settle: float, max_age: float) -> AxState:
        """Return a tree no older than `max_age` seconds, else ask for a fresh dump and wait for it (and for its
        AdditionalData pass, up to `settle` seconds)."""
        self.last_used = time.monotonic()
        st = self.state
        if max_age > 0 and st.received_at is not None and time.monotonic() - st.received_at <= max_age \
                and st.notifications == 0:
            return st
        gen0, asked = st.generation, time.monotonic()
        self.changed.clear()
        await self.request()
        deadline = asked + timeout
        while not (st.generation > gen0 and (st.received_at or 0) >= asked):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise SidecarError("device_timeout", "The iPhone did not send its accessibility tree in time", [
                    "Unlock the iPhone; the tree comes from the frontmost app", "Retry, or use OCR"])
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self.changed.wait(), remaining)
            self.changed.clear()
        settle_until = time.monotonic() + settle
        while not st.complete and time.monotonic() < settle_until:
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self.changed.wait(), max(0.01, settle_until - time.monotonic()))
            self.changed.clear()
        self.last_used = time.monotonic()
        return st

    async def close(self) -> None:
        if self.provider is not None:
            with contextlib.suppress(Exception):  # "goodbye": the phone ends the session and closes the channel
                await asyncio.wait_for(self.provider.dtx._ctrl_channel.invoke(
                    "clientNeedsAccessibility:", False, expects_reply=False), 2)
        if self.reader is not None:
            self.reader.cancel()
            with contextlib.suppress(BaseException):
                await self.reader
            self.reader = None
        if self.provider is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self.provider.close(), 3)
            self.provider = None


class RealApi:
    """Everything that talks to the phone. Read-only paths verified on iOS 27.0 (native transport); the rest
    UNTESTED on hardware."""

    fake = False

    def __init__(self, session: "Session") -> None:
        self.s = session
        self.hid: Optional[AuthGatedHid] = None
        self.indigo: Any = None
        self.screencap: Any = None
        self.ax: Optional[AxSession] = None

    @property
    def rsd(self) -> Any:
        if self.s.rsd is None:
            raise SidecarError("connection_lost", "Not connected to the iPhone")
        return self.s.rsd

    # ── HID ────────────────────────────────────────────────────────────────────
    async def ensure_hid(self) -> AuthGatedHid:
        if self.hid is not None and self.hid.alive:
            return self.hid
        if self.hid is not None:
            await self.hid.close()
            self.hid = None
        if not self.s.has_service(SVC_UHID):
            raise SidecarError("ui_automation_off", "The iPhone does not offer the HID service "
                               f"({SVC_UHID}); UI Automation is probably disabled")
        self.s.progress("input_stream", "Opening the screen stream that enables input")
        hid = AuthGatedHid(self.rsd)
        try:
            await hid.open()
        except Exception as e:
            raise await self._stream_error(e) from e
        self.hid = hid
        return hid

    async def _stream_error(self, e: BaseException) -> SidecarError:
        se = map_exception(e, wifi=self.s.is_wifi)
        if se.code in ("stream_busy", "ui_automation_off", "local_network_denied", "connection_lost"):
            return se
        details: dict[str, Any] = {"cause": f"{type(e).__name__}: {e}"}
        with contextlib.suppress(Exception):
            locked = await self.lockstate()
            if locked.get("locked"):
                return SidecarError("locked", "The iPhone is locked; iOS will not start the screen stream", **details)
        with contextlib.suppress(Exception):
            from pymobiledevice3.remote.core_device.display_service import DisplayService
            async with DisplayService(self.rsd) as d:
                st = await asyncio.wait_for(d.get_media_stream_server_status(), 5)
            details["streamServer"] = st
            sessions = [v for k, v in (st or {}).items() if "session" in str(k).lower() and v]
            if sessions:
                return SidecarError("stream_busy", "Another client is already streaming this iPhone's screen "
                                    "(Xcode Device Hub or iPhone Mirroring?)", **details)
        return SidecarError("stream_failed", f"Could not start the screen stream that enables input: {e}", **details)

    async def close_hid(self) -> None:
        if self.hid is not None:
            await self.hid.close()
            self.hid = None

    async def touch(self, state: int, hx: int, hy: int) -> None:
        hid = await self.ensure_hid()
        await hid.uhs.send_touchscreen(state, hx, hy)

    async def multitouch(self, contacts: list[Contact]) -> None:
        from pymobiledevice3.remote.core_device.hid_service import TouchscreenContact
        hid = await self.ensure_hid()
        await hid.uhs.send_multitouch([TouchscreenContact(c.identity, c.x, c.y, c.touching) for c in contacts])

    async def keyboard(self, usages: list[int]) -> None:
        hid = await self.ensure_hid()
        await hid.uhs.send_keyboard(await hid.keyboard(), usages)

    async def button(self, page: int, usage: int, state: int) -> None:
        from pymobiledevice3.remote.core_device.hid_service import IndigoHIDService
        if self.indigo is None:
            self.indigo = IndigoHIDService(self.rsd)
            await self.indigo.connect()
        try:
            await self.indigo.send_button(page, usage, state)
        except Exception:
            with contextlib.suppress(Exception):
                await self.indigo.close()
            self.indigo = None
            raise

    def hid_info(self) -> dict[str, Any]:
        return self.hid.info() if self.hid is not None else {"open": False}

    # ── observation ────────────────────────────────────────────────────────────
    async def screenshot(self) -> bytes:
        from pymobiledevice3.remote.core_device.screen_capture_service import ScreenCaptureService
        if self.screencap is None:
            self.screencap = ScreenCaptureService(self.rsd)
            await self.screencap.connect()
        try:
            resp = await asyncio.wait_for(self.screencap.capture_screenshot(), 30)
        except BaseException:
            with contextlib.suppress(Exception):
                await self.screencap.close()
            self.screencap = None
            raise
        return bytes(resp["image"])

    async def display_info(self) -> Any:
        from pymobiledevice3.remote.core_device.device_info import DeviceInfoService
        async with DeviceInfoService(self.rsd) as svc:
            return await asyncio.wait_for(svc.get_display_info(), 10)

    async def lockstate(self) -> dict[str, Any]:
        from pymobiledevice3.remote.core_device.device_info import DeviceInfoService
        async with DeviceInfoService(self.rsd) as svc:
            raw = await asyncio.wait_for(svc.get_lockstate(), 10)
        return {"locked": find_bool(raw, {"islocked", "locked", "deviceislocked", "passcodelocked"}), "raw": raw}

    async def ax_state(self, timeout: float, settle: float, max_age: float) -> AxState:
        if not self.s.has_service(SVC_REMOTE_AX):
            raise SidecarError("not_supported", "This iPhone has no remote accessibility service (needs iOS 27+); "
                               "use OCR", [])
        for attempt in range(2):
            if self.ax is None or not self.ax.alive:
                if self.ax is not None:
                    await self.ax.close()
                self.ax = AxSession(self.rsd)
                await self.ax.open()
            try:
                return await self.ax.snapshot(timeout, settle, max_age)
            except SidecarError:
                raise
            except Exception:
                if attempt:
                    raise
                with contextlib.suppress(Exception):
                    await self.ax.close()
                self.ax = None
        raise AssertionError("unreachable")

    async def close_ax(self) -> None:
        if self.ax is not None:
            await self.ax.close()
            self.ax = None

    async def ax_warm(self) -> int:
        """Open the accessibility session and ask for a dump without waiting for it. The first tree after connecting
        can take 10-25 s (the phone attaches to the frontmost app); later ones ~1 s. Returns the current generation."""
        if not self.s.has_service(SVC_REMOTE_AX):
            raise SidecarError("not_supported", "This iPhone has no remote accessibility service (needs iOS 27+); "
                               "use OCR", [])
        if self.ax is None or not self.ax.alive:
            if self.ax is not None:
                await self.ax.close()
            self.ax = AxSession(self.rsd)
            await self.ax.open()
        await self.ax.request()
        return self.ax.state.generation

    # ── apps / system ──────────────────────────────────────────────────────────
    async def apps(self) -> list[dict[str, Any]]:
        from pymobiledevice3.remote.core_device.app_service import AppServiceService
        async with AppServiceService(self.rsd) as svc:
            return await asyncio.wait_for(svc.list_apps(), 60)

    async def launch(self, bundle_id: str, arguments: list[str], env: dict[str, str], kill: bool) -> Any:
        from pymobiledevice3.remote.core_device.app_service import AppServiceService
        async with AppServiceService(self.rsd) as svc:
            return await asyncio.wait_for(svc.launch_application(bundle_id, arguments, kill, False, env), 30)

    async def open_url(self, url: str, bundle_id: str) -> Any:
        # devicectl's --payload-url: CoreDevice LaunchOptions.payloadURL (Swift URL codable = {"relative": ...}).
        # UNTESTED wire format; if the device ignores it the app just comes to the foreground.
        import plistlib

        from pymobiledevice3.remote.core_device.app_service import AppServiceService
        async with AppServiceService(self.rsd) as svc:
            return await asyncio.wait_for(svc.invoke("com.apple.coredevice.feature.launchapplication", {
                "applicationSpecifier": {"bundleIdentifier": {"_0": bundle_id}},
                "options": {
                    "arguments": [], "environmentVariables": {}, "standardIOUsesPseudoterminals": True,
                    "startStopped": False, "terminateExisting": False, "user": {"shortName": "mobile"},
                    "platformSpecificOptions": plistlib.dumps({}), "payloadURL": {"relative": url},
                },
                "standardIOIdentifiers": {},
            }), 30)

    async def terminate(self, bundle_id: str) -> dict[str, Any]:
        try:
            from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
            from pymobiledevice3.services.dvt.instruments.process_control import ProcessControl
            async with DvtProvider(self.rsd) as dvt, ProcessControl(dvt) as pc:
                pid = await asyncio.wait_for(pc.process_identifier_for_bundle_identifier(bundle_id), 15)
                if not pid:
                    return {"terminated": False, "running": False}
                await asyncio.wait_for(pc.kill(pid), 15)
                return {"terminated": True, "pid": pid}
        except SidecarError:
            raise
        except Exception as dvt_error:
            log.info("DVT terminate failed (%r); trying appservice", dvt_error)
        from pymobiledevice3.remote.core_device.app_service import AppServiceService
        async with AppServiceService(self.rsd) as svc:
            apps = [a for a in await svc.list_apps() if a.get("bundleIdentifier") == bundle_id]
            if not apps:
                raise SidecarError("not_found", f"App {bundle_id} is not installed", [])
            app_path = str(apps[0].get("path") or apps[0].get("url") or "")
            app_path = re.sub(r"^file://", "", app_path).rstrip("/")
            for proc in await svc.list_processes():
                exe = proc.get("executableURL")
                exe = exe.get("relative") if isinstance(exe, dict) else exe
                exe = re.sub(r"^file://", "", str(exe or ""))
                pid = proc.get("processIdentifier")
                if app_path and exe.startswith(app_path) and isinstance(pid, int):
                    await svc.send_signal_to_process(pid, signal.SIGKILL)
                    return {"terminated": True, "pid": pid}
        return {"terminated": False, "running": False}

    async def rotate(self, direction: str) -> dict[str, Any]:
        from pymobiledevice3.remote.core_device.orientation_service import OrientationService
        async with OrientationService(self.rsd) as svc:
            return await asyncio.wait_for(svc.rotate(direction), 10)

    async def clipboard_get(self) -> Optional[str]:
        from pymobiledevice3.remote.core_device.pasteboard_service import PasteboardService
        async with PasteboardService(self.rsd) as pb:
            return await asyncio.wait_for(pb.get_text(), 15)

    async def clipboard_set(self, text: str) -> None:
        from pymobiledevice3.remote.core_device.pasteboard_service import PasteboardService
        async with PasteboardService(self.rsd) as pb:
            await asyncio.wait_for(pb.set_text(text), 15)

    async def appearance(self, style: Optional[str]) -> str:
        from pymobiledevice3.remote.core_device.configuration_service import ConfigurationService
        async with ConfigurationService(self.rsd) as cfg:
            if style:
                await asyncio.wait_for(cfg.set_user_interface_style(style), 10)
                return style
            return await asyncio.wait_for(cfg.get_user_interface_style(), 10)

    async def close(self) -> None:
        await self.close_hid()
        with contextlib.suppress(Exception):
            await self.close_ax()
        for attr in ("indigo", "screencap"):
            svc = getattr(self, attr)
            if svc is not None:
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(svc.close(), 3)
                setattr(self, attr, None)


class FakeApi:
    """In-memory device for protocol/client tests (PD_IOS_NATIVE_FAKE). Records HID reports built with
    pymobiledevice3's real report builders."""

    fake = True

    def __init__(self, session: "Session", width: int, height: int, scale: float) -> None:
        self.s = session
        self.width, self.height, self.scale = width, height, scale
        self.log: list[dict[str, Any]] = []
        self.clip: Optional[str] = None
        self.style = "light"
        self.orientation = "portrait"
        self.hid_open = False

    async def touch(self, state: int, hx: int, hy: int) -> None:
        from pymobiledevice3.remote.core_device.hid_service import build_touchscreen_report
        self.hid_open = True
        self.log.append({"op": "touch", "state": state, "x": hx, "y": hy,
                         "report": build_touchscreen_report(state, hx, hy, timestamp=0).hex()})

    async def multitouch(self, contacts: list[Contact]) -> None:
        from pymobiledevice3.remote.core_device.hid_service import TouchscreenContact, build_multitouch_report
        self.hid_open = True
        report = build_multitouch_report([TouchscreenContact(*c) for c in contacts], timestamp=0)
        self.log.append({"op": "multitouch", "contacts": [list(c) for c in contacts], "report": report.hex()})

    async def keyboard(self, usages: list[int]) -> None:
        self.hid_open = True
        self.log.append({"op": "keyboard", "usages": list(usages)})

    async def button(self, page: int, usage: int, state: int) -> None:
        self.log.append({"op": "button", "page": page, "usage": usage, "state": state})

    def hid_info(self) -> dict[str, Any]:
        return {"open": self.hid_open, "fake": True}

    async def close_hid(self) -> None:
        self.hid_open = False

    async def screenshot(self) -> bytes:
        return make_png(self.width, self.height)

    async def display_info(self) -> Any:
        return {"displays": [{"currentMode": {"size": {"width": self.width, "height": self.height}}, "scale": self.scale}]}

    async def lockstate(self) -> dict[str, Any]:
        return {"locked": False, "raw": {"isLocked": False}}

    async def ax_warm(self) -> int:
        return 0

    async def ax_state(self, timeout: float, settle: float, max_age: float) -> AxState:
        """A small synthetic tree in the phone's wire shape (points; 1 pt = scale px)."""
        w, h = self.width / self.scale, self.height / self.scale

        def rect(x: float, y: float, rw: float, rh: float) -> dict[str, Any]:
            return {"$class": "NSValue", "NS.rectval": f"{{{{{x}, {y}}}, {{{rw}, {rh}}}}}"}

        def to(oid: int, pid: int = 100) -> dict[str, Any]:
            return {"$class": "AXPTranslationObject", "objectID": oid, "pid": pid}

        def entry(oid: int, attrs: dict[int, Any], pid: int = 100) -> dict[str, Any]:
            return {"associatedRequestType": 5, "associatedTranslationObject": to(oid, pid),
                    "resultData": {str(k): v for k, v in attrs.items()}}

        dump = [
            {"associatedRequestType": 4, "resultData": to(1)},
            entry(1, {AX_LABEL: "Fake App", AX_FRAME: rect(0, 0, w, h), AX_ROLE: AX_ROLE_APP,
                      AX_CHILDREN: [to(2), to(3), to(4), to(5), to(6, 200)]}),
            entry(2, {AX_LABEL: "Back", AX_FRAME: rect(16, 64, 44, 44), AX_TRAITS: 1, AX_ROLE: 2}),
            entry(3, {AX_LABEL: "Wi-Fi", AX_VALUE: "1", AX_FRAME: rect(20, 200, w - 40, 52), AX_TYPE: 40}),
            entry(4, {AX_LABEL: "Hidden row", AX_FRAME: rect(0, h + 100, w, 44), AX_TRAITS: 64}),
            entry(5, {AX_FRAME: rect(0, h - 300, w, 300), AX_ROLE: AX_ROLE_CONTAINER}),
            entry(6, {AX_LABEL: "Q", AX_FRAME: rect(6, 10, 37, 45), AX_TRAITS: 32, AX_TYPE: 20}, pid=200),
        ]
        st = AxState()
        st.feed({"resultData": {"treeDump": dump, "treeDumpType": "AXPTreeDumpTypeInitialDump"}})
        st.feed({"resultData": {"treeDump": [entry(2, {AX_ID: "nav.back", AX_TYPE: 9})],
                                "treeDumpType": "AXPTreeDumpTypeAdditionalData"}})
        return st

    async def apps(self) -> list[dict[str, Any]]:
        return [{"bundleIdentifier": "com.apple.mobilesafari", "name": "Safari", "isFirstParty": True},
                {"bundleIdentifier": "com.example.app", "name": "Example", "version": "1.0", "isRemovable": True}]

    async def launch(self, bundle_id: str, arguments: list[str], env: dict[str, str], kill: bool) -> Any:
        self.log.append({"op": "launch", "bundleId": bundle_id, "args": arguments, "env": env, "kill": kill})
        return {"processToken": {"processIdentifier": 4242}}

    async def open_url(self, url: str, bundle_id: str) -> Any:
        self.log.append({"op": "open_url", "url": url, "bundleId": bundle_id})
        return {}

    async def terminate(self, bundle_id: str) -> dict[str, Any]:
        self.log.append({"op": "terminate", "bundleId": bundle_id})
        return {"terminated": True, "pid": 4242}

    async def rotate(self, direction: str) -> dict[str, Any]:
        i = ORIENTATIONS.index(self.orientation)
        self.orientation = ORIENTATIONS[(i + (1 if direction == "left" else -1)) % 4]
        if (self.width > self.height) != self.orientation.startswith("landscape"):
            self.width, self.height = self.height, self.width
        self.log.append({"op": "rotate", "direction": direction})
        return {"currentDeviceOrientation": self.orientation, "currentDeviceOrientationLocked": False}

    async def clipboard_get(self) -> Optional[str]:
        return self.clip

    async def clipboard_set(self, text: str) -> None:
        self.clip = text
        self.log.append({"op": "clipboard_set", "text": text})

    async def appearance(self, style: Optional[str]) -> str:
        if style:
            self.style = style
        return self.style

    async def close(self) -> None:
        self.hid_open = False


# ═════════════════════════════════════════════════════════════════════════════════════════════════
# Session: one device, its tunnel and its input stream
# ═════════════════════════════════════════════════════════════════════════════════════════════════

class Session:
    def __init__(self, server: "Server", udid: Optional[str], transport: str, fake: Optional[str]) -> None:
        self.server = server
        self.lock = asyncio.Lock()
        self.connect_args: dict[str, Any] = {"udid": udid, "transport": transport}
        self.fake_spec = fake
        self.tunnel: Any = None
        self.rsd: Any = None
        self.api: Any = None
        self.info: dict[str, Any] = {}
        self.via: Optional[str] = None
        self.native_info: Optional[dict[str, Any]] = None
        self.display: dict[str, Any] = {}
        self.connected_at: Optional[float] = None
        self.screen: dict[str, Any] = {}
        self.screen_stale = True
        self.orientation: Optional[str] = None
        self.local_network: str = "unknown"
        self.last_input = time.monotonic()
        # While the input stream is open iOS treats the phone as observed remotely (camera/mic blocked): keep it short
        self.hid_idle_sec = float(os.environ.get("PD_IOS_NATIVE_HID_IDLE_SEC", "60"))
        self.ax_idle_sec = float(os.environ.get("PD_IOS_NATIVE_AX_IDLE_SEC", "90"))
        self.last_error: Optional[dict[str, Any]] = None

    # ── helpers ────────────────────────────────────────────────────────────────
    @property
    def is_wifi(self) -> bool:
        """True when this process itself opens LAN connections (subject to macOS Local Network privacy). The native
        path rides remoted's tunnel and usbmux-network goes through usbmuxd, so neither counts."""
        return self.via == "remotepairing" or (self.via is None and self.connect_args.get("transport") == "wifi")

    @property
    def connected(self) -> bool:
        if self.api is None:
            return False
        if self.api.fake:
            return True
        return self.rsd is not None and (self.tunnel is None or getattr(self.tunnel, "rsd", self.rsd) is not None)

    def has_service(self, name: str) -> bool:
        try:
            return name in (self.rsd.peer_info or {}).get("Services", {})
        except Exception:
            return False

    def progress(self, stage: str, message: str, **extra: Any) -> None:
        self.server.emit({"event": "progress", "stage": stage, "message": message, **extra}, REQ_ID.get())

    # ── connect / teardown ─────────────────────────────────────────────────────
    async def teardown(self) -> None:
        api, tunnel = self.api, self.tunnel
        self.api = self.tunnel = self.rsd = None
        self.connected_at = None
        if api is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(api.close(), 8)
        if tunnel is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(tunnel.aclose(), 8)

    async def ensure(self) -> None:
        if not self.connected:
            await self.connect_locked(dict(self.connect_args))

    async def connect_locked(self, args: dict[str, Any]) -> dict[str, Any]:
        transport = str(args.get("transport") or self.connect_args.get("transport") or "auto").lower()
        if transport not in ("auto", "usb", "wifi", "native"):
            raise bad_request("transport must be auto, usb, wifi or native")
        udid = args.get("udid") or self.connect_args.get("udid") or None
        if udid is not None and not isinstance(udid, str):
            raise bad_request("udid must be a string")
        self.connect_args = {**self.connect_args, **args, "udid": udid, "transport": transport}
        await self.teardown()
        if self.fake_spec:
            return await self._connect_fake()
        try:
            await self._open(udid, transport)
            await self._post_connect(bool(args.get("mountDdi", True)))
        except BaseException as e:
            await self.teardown()
            se = map_exception(e, wifi=self.is_wifi or transport == "wifi")
            if se.code == "local_network_denied":
                self.local_network = "denied"
            raise se from e
        if self.is_wifi and self.via == "remotepairing":
            self.local_network = "ok"
        return await self.status_dict()

    async def _connect_fake(self) -> dict[str, Any]:
        m = re.fullmatch(r"(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?", self.fake_spec or "")
        w, h, sc = (int(m.group(1)), int(m.group(2)), float(m.group(3) or 3)) if m else (1179, 2556, 3.0)
        self.api = FakeApi(self, w, h, sc)
        self.via = "fake"
        self.info = {"udid": self.connect_args.get("udid") or "00008140-FAKE00000000001E", "name": "Fake iPhone",
                     "model": "iPhone17,1", "iosVersion": "27.0", "buildVersion": "27A0000", "developerMode": True}
        self.screen = {"width": w, "height": h, "scale": sc, "source": "fake"}
        self.screen_stale = False
        self.connected_at = time.monotonic()
        return await self.status_dict()

    async def _open(self, udid: Optional[str], transport: str) -> None:
        from pymobiledevice3 import usbmux

        if transport in ("native", "auto") and await self._open_native(udid, required=transport == "native"):
            return

        try:
            mux = await usbmux.list_devices()
        except Exception as e:
            if transport == "usb":
                raise SidecarError("usbmuxd_unavailable", f"Cannot reach usbmuxd: {e}") from e
            log.info("usbmuxd unavailable: %r", e)
            mux = []

        def pick(kind: str) -> Optional[Any]:
            cands = [d for d in mux if d.connection_type == kind and (udid is None or d.matches_udid(udid))]
            return cands[0] if cands else None

        if transport in ("auto", "usb"):
            dev = pick("USB")
            if dev is not None:
                return await self._open_usbmux(dev.serial, "USB")
            if transport == "usb":
                raise SidecarError("no_device", "No iPhone is connected by USB" + (f" with udid {udid}" if udid else ""),
                                   ["Plug the iPhone in with a data cable and unlock it"])
        if transport in ("auto", "wifi"):
            dev = pick("Network")
            if dev is not None:
                return await self._open_usbmux(dev.serial, "Network")
            records = self._remote_records(udid)
            if records:
                return await self._open_remotepairing(udid or records[0]["udid"], len(records))
        if udid is not None and transport == "wifi":
            raise SidecarError("not_paired", f"iPhone {udid} is not paired with this Mac for Wi-Fi")
        raise SidecarError("not_paired", "No paired iPhone found (no USB device, no Wi-Fi pairing)"
                           + (f" for udid {udid}" if udid else ""))

    async def _open_native(self, udid: Optional[str], required: bool) -> bool:
        """Borrow Apple's tunnel (remoted, via remotepairingd). Only for a phone remotepairingd reports as
        authenticated: NativeRemotedTunnel sends InitiatePairingCommand, which could start an interactive pairing
        for an unpaired phone. Returns False (auto mode) when the phone is not known there."""
        if platform.system() != "Darwin":
            if required:
                raise SidecarError("not_supported", "The native transport needs macOS (remoted)", [])
            return False
        try:
            devs = await native_devices(timeout=float(self.connect_args.get("browseTimeoutSec") or 1.0))
        except Exception as e:
            if required:
                raise SidecarError("no_device", f"remotepairingd is not reachable: {e}") from e
            log.info("native browse failed: %r", e)
            return False
        want = (udid or "").replace("-", "").upper()
        cands = [d for d in devs if not want or str(d.get("udid") or "").replace("-", "").upper() == want]
        if not cands:
            if required:
                raise SidecarError("not_paired", "macOS (remotepairingd) does not know this iPhone"
                                   + (f" ({udid})" if udid else ""), [
                    "Pair it once: Xcode > Window > Devices and Simulators, or plug it in and tap Trust",
                    "Wi-Fi without a cable (iOS 27+): Settings > Developer > Paired Macs on the iPhone",
                    "Then `xcrun devicectl list devices` should list it as available (paired)"])
            return False
        dev = cands[0]
        if not dev.get("paired"):
            if required or udid:
                raise SidecarError("not_paired", f"This Mac is not paired with {dev.get('name') or 'the iPhone'} "
                                   f"(authState {dev.get('authState')})")
            return False
        from pymobiledevice3.remote.native_tunnel import NativeRemotedTunnel
        self.progress("tunnel", "Opening Apple's tunnel through remoted", udid=dev.get("udid"))
        tunnel = NativeRemotedTunnel(serial=dev["udid"])
        self.rsd = await tunnel.aopen()
        self.tunnel, self.via, self.native_info = tunnel, "remoted", dev
        self.info = {"udid": dev.get("udid"), "name": dev.get("name"), "model": dev.get("model")}
        return True

    @staticmethod
    def _remote_records(udid: Optional[str]) -> list[dict[str, Any]]:
        from pymobiledevice3.pair_records import iter_remote_pair_records_by_identifier
        out = []
        for ident, path, rec in iter_remote_pair_records_by_identifier():
            if udid is not None and ident.replace("-", "") != udid.replace("-", ""):
                continue
            out.append({"udid": ident, "path": str(path), "name": rec.get("peer_name"), "model": rec.get("peer_model"),
                        "wifiReady": rec.get("peer_alt_irk") is not None or rec.get("altIRK") is not None})
        return out

    async def _open_usbmux(self, serial: str, kind: str) -> None:
        from pymobiledevice3.lockdown import create_using_usbmux
        from pymobiledevice3.remote.tunnel_service import CoreDeviceTunnelProxy

        trust = float(self.connect_args.get("trustTimeoutSec") or 0)
        self.progress("lockdown", f"Connecting over {'USB' if kind == 'USB' else 'Wi-Fi (usbmuxd)'}")
        if trust > 0:
            self.progress("trust_prompt", "If the iPhone asks, unlock it and tap Trust", timeoutSec=trust)
        lockdown = await create_using_usbmux(serial=serial, connection_type=kind, autopair=True,
                                             pair_timeout=trust if trust > 0 else None)
        try:
            self.via = "usbmux-usb" if kind == "USB" else "usbmux-network"
            values = getattr(lockdown, "all_values", {}) or {}
            self.info = {"udid": lockdown.udid or serial, "name": values.get("DeviceName"),
                         "model": values.get("ProductType"), "iosVersion": lockdown.product_version,
                         "buildVersion": values.get("BuildVersion")}
            self._check_ios(lockdown.product_version)
            dev_mode = None
            with contextlib.suppress(Exception):
                dev_mode = await lockdown.get_developer_mode_status()
            self.info["developerMode"] = dev_mode
            if dev_mode is False:
                raise SidecarError("developer_mode_off", "Developer Mode is off on the iPhone")
        except BaseException:
            await lockdown.close()
            raise

        async def factory() -> tuple[Any, list[Callable[[], Awaitable[Any]]]]:
            try:
                return await CoreDeviceTunnelProxy.create(lockdown), [lockdown.close]
            except BaseException as e:
                await lockdown.close()
                if type(e).__name__ == "InvalidServiceError":
                    raise SidecarError("developer_mode_off", "The iPhone does not offer CoreDeviceProxy; Developer "
                                       "Mode is probably off") from e
                raise

        self.progress("tunnel", "Opening the userspace tunnel")
        tunnel = _provider_tunnel_class()(factory, serial=serial)
        self.rsd = await tunnel.aopen()
        self.tunnel = tunnel

    async def _open_remotepairing(self, udid: str, n_records: int) -> None:
        from pymobiledevice3.bonjour import is_multicast_blocked, probe_multicast
        from pymobiledevice3.remote.tunnel_service import get_remote_pairing_tunnel_services

        self.via = "remotepairing"
        self.info = {"udid": udid}
        timeout = float(self.connect_args.get("browseTimeoutSec") or 4)
        self.progress("browse", "Looking for the iPhone on the local network", udid=udid)
        services = await get_remote_pairing_tunnel_services(bonjour_timeout=timeout, udid=udid)
        if not services:
            blocked = False
            with contextlib.suppress(Exception):
                sent, errors = await probe_multicast()
                blocked = is_multicast_blocked(sent, errors)
            if blocked:
                raise SidecarError("local_network_denied", "Bonjour is blocked for this process (macOS Local Network "
                                   "privacy), so the iPhone cannot be found on Wi-Fi")
            raise SidecarError("no_device", f"Paired iPhone {udid} was not found on the local network",
                               HINTS["no_device"][1:] + ["Wake the iPhone and keep it unlocked while connecting"])
        provider, rest = services[0], services[1:]
        for extra in rest:
            with contextlib.suppress(Exception):
                await extra.close()

        async def factory() -> tuple[Any, list[Callable[[], Awaitable[Any]]]]:
            return provider, []

        self.progress("tunnel", "Opening the userspace tunnel over Wi-Fi")
        tunnel = _provider_tunnel_class()(factory, serial=udid)
        self.rsd = await tunnel.aopen()
        self.tunnel = tunnel

    @staticmethod
    def _check_ios(version: str) -> None:
        if parse_version(version)[0] < MIN_IOS_MAJOR:
            raise SidecarError("ios_too_old", f"iOS {version} is too old for native control (needs iOS "
                               f"{MIN_IOS_MAJOR}+)", iosVersion=version)

    async def _post_connect(self, mount_ddi: bool) -> None:
        rsd = self.rsd
        props = (rsd.peer_info or {}).get("Properties", {})
        self.info.update({k: v for k, v in {
            "udid": rsd.udid or self.info.get("udid"), "model": props.get("ProductType") or self.info.get("model"),
            "iosVersion": rsd.product_version, "buildVersion": props.get("BuildVersion") or self.info.get("buildVersion"),
        }.items() if v})
        self._check_ios(rsd.product_version)
        if not self.info.get("name"):
            with contextlib.suppress(Exception):
                self.info["name"] = await asyncio.wait_for(rsd.get_value(key="DeviceName"), 5)
        if self.info.get("developerMode") is None:
            with contextlib.suppress(Exception):
                self.info["developerMode"] = await asyncio.wait_for(rsd.get_developer_mode_status(), 5)
            if self.info.get("developerMode") is False:
                raise SidecarError("developer_mode_off", "Developer Mode is off on the iPhone")
        if not all(self.has_service(s) for s in DDI_SERVICES):
            if not mount_ddi:
                raise SidecarError("ddi_missing", "The developer disk image is not mounted")
            await self._mount_ddi_and_reopen()
        self.api = RealApi(self)
        self.connected_at = time.monotonic()
        with contextlib.suppress(Exception):
            await self._refresh_screen_from_display_info()

    async def _mount_ddi_and_reopen(self) -> None:
        from pymobiledevice3.services.mobile_image_mounter import auto_mount
        self.progress("ddi_mount", "Mounting the developer disk image (first time: download + Apple signing)")
        try:
            await asyncio.wait_for(auto_mount(self.rsd), 240)
        except Exception as e:
            if type(e).__name__ != "AlreadyMountedError":
                raise SidecarError("ddi_missing", f"Could not mount the developer disk image: {e}") from e
        udid, transport, info, via = self.info.get("udid"), self.connect_args["transport"], dict(self.info), self.via
        await self.teardown()
        self.progress("tunnel", "Reconnecting after mounting the developer disk image")
        await asyncio.sleep(1.0)
        await self._open(udid, transport if via != "remoted" else "native")
        self.info = {**info, **self.info}
        if not all(self.has_service(s) for s in DDI_SERVICES):
            raise SidecarError("ddi_missing", "The developer disk image was installed but its services did not appear; "
                               "restart the iPhone and retry")

    async def _refresh_screen_from_display_info(self) -> None:
        d = parse_display_info(await self.api.display_info())
        self.display = {k: d.get(k) for k in ("backlight", "orientation", "orientationLocked") if d.get(k) is not None}
        if d.get("orientation") in ORIENTATIONS:
            self.orientation = d["orientation"]
        if d.get("width") and not self.screen.get("width"):
            w, h = d["width"], d["height"]
            if (self.orientation or "portrait").startswith("landscape") and h > w:
                w, h = h, w  # currentMode.size is portrait; screenshots follow the interface orientation (UNTESTED)
            self.screen = {"width": w, "height": h, "source": "displayInfo"}
        if d.get("scale"):
            self.screen["scale"] = d["scale"]
            self.screen["scaleSource"] = "displayInfo"
        self.screen_stale = not self.screen.get("width")

    # ── screen geometry ────────────────────────────────────────────────────────
    def _note_png(self, png: bytes) -> tuple[int, int]:
        w, h = png_size(png)
        scale = self.screen.get("scale") if self.screen.get("scaleSource") == "displayInfo" else None
        self.screen = {"width": w, "height": h, "source": "screenshot", "scale": scale or estimate_scale(w, h),
                       "scaleSource": "displayInfo" if scale else "estimate"}
        self.screen_stale = False
        return w, h

    async def screen_dims(self, args: dict[str, Any]) -> tuple[int, int]:
        sc = args.get("screen")
        if isinstance(sc, dict) and sc.get("width") and sc.get("height"):
            return int(num(sc, "width", lo=2)), int(num(sc, "height", lo=2))
        if self.screen_stale or not self.screen.get("width"):
            self._note_png(await self.api.screenshot())
        return int(self.screen["width"]), int(self.screen["height"])

    # ── status ─────────────────────────────────────────────────────────────────
    async def status_dict(self, refresh: bool = False) -> dict[str, Any]:
        api = self.api
        out: dict[str, Any] = {
            "udid": self.info.get("udid"), "name": self.info.get("name"), "model": self.info.get("model"),
            "iosVersion": self.info.get("iosVersion"), "buildVersion": self.info.get("buildVersion"),
            "connection": ({"usbmux-usb": "usb", "usbmux-network": "wifi", "remotepairing": "wifi", "fake": "usb"}
                           .get(self.via or "") if self.via != "remoted" else
                           "usb" if (self.native_info or {}).get("attachedPhysically") else "wifi"),
            "via": self.via, "transport": self.connect_args.get("transport"),
            "developerMode": self.info.get("developerMode"),
            "localNetwork": self.local_network, "orientation": self.orientation,
            "screen": ({k: self.screen.get(k) for k in ("width", "height", "scale")} if self.screen.get("width")
                       else None),
            "screenSource": self.screen.get("source"),
            "screenOn": (self.display.get("backlight") not in ("off", "inactiveOff") if self.display.get("backlight")
                         else None),
            "backlight": self.display.get("backlight"),
            "uiTree": {"available": self.has_service(SVC_REMOTE_AX) or bool(api is not None and api.fake),
                       "open": bool(api is not None and not api.fake and api.ax is not None and api.ax.alive),
                       "generation": api.ax.state.generation if api is not None and not api.fake and api.ax else None},
        }
        if api is not None and api.fake:
            out.update({"ddiMounted": True, "inputAvailable": True, "inputReady": api.hid_open,
                        "uiAutomation": "unknown", "locked": False, "hid": api.hid_info(), "fake": True})
        else:
            services = {s: self.has_service(s) for s in SERVICES_OF_INTEREST}
            ddi = all(self.has_service(s) for s in DDI_SERVICES)
            out.update({
                "ddiMounted": ddi, "services": services,
                "inputAvailable": ddi and services[SVC_UHID],
                "inputReady": bool(api is not None and api.hid is not None and api.hid.alive),
                "uiAutomation": "off" if ddi and not services[SVC_UHID] else "unknown",
                "hid": api.hid_info() if api is not None else {"open": False},
                "locked": None,
            })
            if api is not None and refresh:
                # getlockstate is "not implemented" on iOS 27.0; keep trying in case a later build adds it
                if self.info.get("_lockUnsupported") is None:
                    try:
                        ls = await api.lockstate()
                        self.info["locked"] = ls.get("locked")
                    except Exception as e:
                        if "not implemented" in str(e):
                            self.info["_lockUnsupported"] = True
                with contextlib.suppress(Exception):
                    await self._refresh_screen_from_display_info()
                    out.update({"orientation": self.orientation, "backlight": self.display.get("backlight"),
                                "screenOn": self.display.get("backlight") not in ("off", "inactiveOff")})
            out["locked"] = self.info.get("locked")
        if self.connected_at is not None:
            out["connectedForSec"] = round(time.monotonic() - self.connected_at, 1)
        return out

    # ── command wrapper ────────────────────────────────────────────────────────
    async def run(self, fn: Callable[[], Awaitable[Any]], retry: bool = True,
                  retry_on: tuple[str, ...] = ("connection_lost", "device_timeout")) -> Any:
        """Run a device operation under the session lock; reconnect and retry once if the link dropped."""
        async with self.lock:
            await self.ensure()
            try:
                return await fn()
            except Exception as e:
                se = map_exception(e, wifi=self.is_wifi)
                if not retry or se.code not in retry_on or self.api is None or self.api.fake:
                    if se.code in ("connection_lost",):
                        await self.teardown()
                    raise se from e
                self.server.emit({"event": "reconnecting", "reason": se.message}, REQ_ID.get())
                await self.teardown()
                await self.ensure()
                try:
                    return await fn()
                except Exception as e2:
                    raise map_exception(e2, wifi=self.is_wifi) from e2

    async def run_steps(self, steps: list[Step]) -> None:
        self.last_input = time.monotonic()
        for st in steps:
            kind = st[0]
            if kind == "sleep":
                await asyncio.sleep(st[1])
            elif kind == "t1":
                await self.api.touch(st[1], st[2], st[3])
            elif kind == "mt":
                await self.api.multitouch(st[1])
        self.last_input = time.monotonic()

    async def press(self, mods: list[int], usage: int, char_delay: float = 0.04, gap: float = 0.02) -> None:
        if mods:
            await self.api.keyboard(list(mods))  # establish modifiers first (iOS can drop a shift sent with the key)
            await asyncio.sleep(char_delay)
        await self.api.keyboard(list(mods) + [usage])
        await asyncio.sleep(char_delay)
        await self.api.keyboard([])
        await asyncio.sleep(gap)

    async def idle_watch(self) -> None:
        while True:
            await asyncio.sleep(10)
            api = self.api
            if api is None or self.lock.locked():
                continue
            if time.monotonic() - self.last_input > self.hid_idle_sec and api.hid_info().get("open"):
                async with self.lock:
                    if self.api is api and time.monotonic() - self.last_input > self.hid_idle_sec:
                        log.info("closing the idle input stream")
                        with contextlib.suppress(Exception):
                            await api.close_hid()
            ax = None if api.fake else api.ax
            if ax is not None and time.monotonic() - ax.last_used > self.ax_idle_sec:
                async with self.lock:
                    if self.api is api and api.ax is ax and time.monotonic() - ax.last_used > self.ax_idle_sec:
                        log.info("closing the idle accessibility session")
                        with contextlib.suppress(Exception):
                            await api.close_ax()


# ═════════════════════════════════════════════════════════════════════════════════════════════════
# Server: protocol + commands
# ═════════════════════════════════════════════════════════════════════════════════════════════════

class Server:
    def __init__(self, out: Any, udid: Optional[str], transport: str, fake: Optional[str], debug: bool) -> None:
        self.out = out
        self.debug = debug or bool(fake)
        self.session = Session(self, udid, transport, fake)
        self.pair_lock = asyncio.Lock()
        self.stop = asyncio.Event()
        self.tasks: set[asyncio.Task[None]] = set()
        self.commands: dict[str, Callable[[dict[str, Any]], Awaitable[Any]]] = {
            "ping": self.c_ping, "connect": self.c_connect, "disconnect": self.c_disconnect, "status": self.c_status,
            "devices": self.c_devices, "screenshot": self.c_screenshot, "tap": self.c_tap,
            "double_tap": self.c_double_tap, "long_press": self.c_long_press, "swipe": self.c_swipe,
            "pinch": self.c_pinch, "type": self.c_type, "key": self.c_key, "button": self.c_button,
            "launch": self.c_launch, "terminate": self.c_terminate, "open_url": self.c_open_url, "apps": self.c_apps,
            "rotate": self.c_rotate, "clipboard_get": self.c_clipboard_get, "clipboard_set": self.c_clipboard_set,
            "appearance": self.c_appearance, "ui": self.c_ui, "pair_wifi": self.c_pair_wifi,
            "mount_ddi": self.c_mount_ddi, "shutdown": self.c_shutdown,
        }
        if self.debug:
            self.commands.update({"_sleep": self.c_sleep, "_crash": self.c_crash, "_fake_log": self.c_fake_log,
                                  "_echo": self.c_echo})

    # ── I/O ────────────────────────────────────────────────────────────────────
    def emit(self, obj: dict[str, Any], rid: Any = None) -> None:
        if rid is not None and "id" not in obj:
            obj = {**obj, "id": rid}
        self.out.write(json.dumps(obj, default=json_default, separators=(",", ":")) + "\n")
        self.out.flush()

    async def handle(self, req: dict[str, Any]) -> None:
        rid = req.get("id")
        token = REQ_ID.set(rid)
        try:
            cmd = req.get("cmd")
            fn = self.commands.get(cmd) if isinstance(cmd, str) else None
            if fn is None:
                raise SidecarError("unknown_command", f"unknown command {cmd!r}", [f"known: {', '.join(sorted(self.commands))}"])
            args = req.get("args") or {}
            if not isinstance(args, dict):
                raise bad_request("args must be an object")
            result = await fn(args)
            self.emit({"id": rid, "ok": True, "result": result if result is not None else {}})
        except asyncio.CancelledError:
            self.emit({"id": rid, "ok": False, "error": SidecarError("cancelled", "sidecar is shutting down", []).to_json()})
            raise
        except Exception as e:
            se = map_exception(e, wifi=self.session.is_wifi)
            if se.code == "internal":
                log.error("command %r failed:\n%s", req.get("cmd"), "".join(traceback.format_exception(e)))
            self.session.last_error = {"code": se.code, "message": se.message, "at": time.time()}
            self.emit({"id": rid, "ok": False, "error": se.to_json()})
        finally:
            REQ_ID.reset(token)

    async def serve(self) -> None:
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            with contextlib.suppress(Exception):
                loop.add_signal_handler(sig, self.stop.set)
        reader = asyncio.StreamReader(limit=32 * 1024 * 1024)
        await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
        self.emit({"event": "ready", "version": SIDECAR_VERSION, "pymobiledevice3": pymd3_version(), "pid": os.getpid(),
                   "python": platform.python_version(), "fake": bool(self.session.fake_spec)})
        idle = asyncio.create_task(self.session.idle_watch())
        stop_wait = asyncio.create_task(self.stop.wait())
        try:
            while not self.stop.is_set():
                read = asyncio.create_task(reader.readline())
                done, _ = await asyncio.wait({read, stop_wait}, return_when=asyncio.FIRST_COMPLETED)
                if read not in done:
                    read.cancel()
                    break
                try:
                    line = read.result()
                except ValueError:
                    self.emit({"id": None, "ok": False, "error": bad_request("request line too long").to_json()})
                    continue
                if not line:
                    break  # stdin closed: the client is gone
                line = line.strip()
                if not line:
                    continue
                try:
                    req = json.loads(line)
                    if not isinstance(req, dict):
                        raise ValueError("request must be a JSON object")
                except ValueError as e:
                    self.emit({"id": None, "ok": False, "error": bad_request(f"invalid JSON request: {e}").to_json()})
                    continue
                task = asyncio.create_task(self.handle(req))
                self.tasks.add(task)
                task.add_done_callback(self.tasks.discard)
        finally:
            idle.cancel()
            stop_wait.cancel()
            await self.shutdown()

    async def shutdown(self) -> None:
        pending = [t for t in self.tasks if t is not asyncio.current_task()]
        if pending:  # let quick in-flight commands finish (a tap mid-gesture must not leave a finger down)
            await asyncio.wait(pending, timeout=3)
        for t in list(self.tasks):
            t.cancel()
        if self.tasks:
            await asyncio.wait(self.tasks, timeout=2)
        with contextlib.suppress(Exception):
            await asyncio.wait_for(self.session.teardown(), 10)

    # ── commands ───────────────────────────────────────────────────────────────
    async def c_ping(self, a: dict[str, Any]) -> Any:
        return {"pong": True, "pid": os.getpid(), "version": SIDECAR_VERSION, "pymobiledevice3": pymd3_version(),
                "connected": self.session.connected}

    async def c_connect(self, a: dict[str, Any]) -> Any:
        async with self.session.lock:
            return await self.session.connect_locked(a)

    async def c_disconnect(self, a: dict[str, Any]) -> Any:
        async with self.session.lock:
            await self.session.teardown()
        return {"disconnected": True}

    async def c_status(self, a: dict[str, Any]) -> Any:
        s = self.session
        if s.connected and not a.get("refresh"):
            return await s.status_dict()
        return await s.run(lambda: s.status_dict(refresh=True))

    async def c_devices(self, a: dict[str, Any]) -> Any:
        """Local inventory only (remotepairingd, usbmuxd socket, pairing-record files); nothing is sent to a phone."""
        from pymobiledevice3 import usbmux
        out: dict[str, Any] = {"native": [], "usbmux": [], "wifiPairings": []}
        if platform.system() == "Darwin" and a.get("native", True):
            try:
                out["native"] = await native_devices(timeout=num(a, "browseTimeoutSec", 1.0, lo=0.2, hi=10))
            except Exception as e:
                out["nativeError"] = f"{type(e).__name__}: {e}"
        try:
            out["usbmux"] = [{"udid": d.serial, "connection": "usb" if d.is_usb else "wifi"}
                             for d in await usbmux.list_devices()]
        except Exception as e:
            out["usbmuxError"] = f"{type(e).__name__}: {e}"
        out["wifiPairings"] = Session._remote_records(None)
        return out

    async def c_screenshot(self, a: dict[str, Any]) -> Any:
        s = self.session
        path = a.get("path")
        if path is not None and (not isinstance(path, str) or not os.path.isabs(path)):
            raise bad_request("path must be an absolute file path")

        async def op() -> Any:
            png = await s.api.screenshot()
            w, h = s._note_png(png)
            res: dict[str, Any] = {"width": w, "height": h, "bytes": len(png), "scale": s.screen.get("scale")}
            if path:
                tmp = f"{path}.{os.getpid()}.tmp"
                with open(tmp, "wb") as f:
                    f.write(png)
                os.replace(tmp, path)
                res["path"] = path
            else:
                res["data"] = base64.b64encode(png).decode()
            return res
        return await s.run(op)

    async def _touch_op(self, a: dict[str, Any], build: Callable[[int, int], list[Step]]) -> Any:
        s = self.session

        async def op() -> Any:
            w, h = await s.screen_dims(a)
            steps = build(w, h)
            await s.run_steps(steps)
            return {"screen": {"width": w, "height": h}, "reports": sum(1 for st in steps if st[0] != "sleep")}
        return await s.run(op, retry=True)

    async def c_tap(self, a: dict[str, Any]) -> Any:
        x, y = num(a, "x"), num(a, "y")
        return await self._touch_op(a, lambda w, h: gesture_tap(*to_hid(x, y, w, h)))

    async def c_double_tap(self, a: dict[str, Any]) -> Any:
        x, y = num(a, "x"), num(a, "y")
        return await self._touch_op(a, lambda w, h: gesture_double_tap(*to_hid(x, y, w, h)))

    async def c_long_press(self, a: dict[str, Any]) -> Any:
        x, y, ms = num(a, "x"), num(a, "y"), num(a, "ms", 800, lo=50, hi=60_000)
        return await self._touch_op(a, lambda w, h: gesture_long_press(*to_hid(x, y, w, h), ms))

    async def c_swipe(self, a: dict[str, Any]) -> Any:
        x1, y1, x2, y2 = num(a, "x1"), num(a, "y1"), num(a, "x2"), num(a, "y2")
        ms = num(a, "ms", 300, lo=20, hi=30_000)
        return await self._touch_op(a, lambda w, h: gesture_drag(to_hid(x1, y1, w, h), to_hid(x2, y2, w, h), ms))

    async def c_pinch(self, a: dict[str, Any]) -> Any:
        x, y = num(a, "x"), num(a, "y")
        scale, ms = num(a, "scale", lo=0.01, hi=100), num(a, "ms", 400, lo=50, hi=30_000)

        def build(w: int, h: int) -> list[Step]:
            paths = pinch_paths(x, y, scale, w, h)
            hid = [(*to_hid(p[0], p[1], w, h), *to_hid(p[2], p[3], w, h)) for p in paths]
            return gesture_multi_drag(hid, ms)
        return await self._touch_op(a, build)

    async def c_type(self, a: dict[str, Any]) -> Any:
        s = self.session
        text = text_arg(a, "text")
        if len(text) > 20_000:
            raise bad_request("text is too long (max 20000 characters)")
        plan = plan_text(text)
        paste_mode = a.get("paste", "auto")
        if paste_mode == "never" and any(kind == "paste" for kind, _ in plan):
            raise bad_request("text contains characters that need the clipboard (non US-ASCII) and paste is 'never'")

        async def op() -> Any:
            s.last_input = time.monotonic()
            pasted = 0
            for kind, val in plan:
                if kind == "key":
                    await s.press(*val)
                else:
                    previous = None
                    with contextlib.suppress(Exception):
                        previous = await s.api.clipboard_get()
                    await s.api.clipboard_set(val)
                    await asyncio.sleep(0.15)
                    await s.press([KEY_LEFT_GUI], KEY_V)
                    await asyncio.sleep(0.3)
                    pasted += len(val)
                    if previous is not None and a.get("restoreClipboard", True):
                        with contextlib.suppress(Exception):
                            await s.api.clipboard_set(previous)
                s.last_input = time.monotonic()
            return {"typed": len(text) - pasted, "pasted": pasted}
        return await s.run(op, retry=False)  # never retry typing: it could duplicate text

    async def c_key(self, a: dict[str, Any]) -> Any:
        s = self.session
        name = text_arg(a, "name")
        lname = name.strip().lower().replace("-", "_")
        if lname in BUTTONS or lname in BUTTON_ALIASES or lname == "app_switch":
            return await self.c_button({"name": name})
        mods, usage = parse_key_combo(name)
        count = int(num(a, "count", 1, lo=1, hi=200))

        async def op() -> Any:
            for _ in range(count):
                await s.press(mods, usage)
            s.last_input = time.monotonic()
            return {"key": name, "count": count}
        return await s.run(op, retry=False)

    async def c_button(self, a: dict[str, Any]) -> Any:
        s = self.session
        raw = text_arg(a, "name")
        name = BUTTON_ALIASES.get(raw.strip().lower(), raw.strip().lower().replace("-", "_"))
        if name != "app_switch" and name not in BUTTONS:
            raise bad_request(f"unknown button {raw!r}; known: {', '.join(sorted(BUTTONS))}, app_switch")
        presses = [BUTTONS["home"], BUTTONS["home"]] if name == "app_switch" else [BUTTONS[name]]
        hold = a.get("holdMs")

        async def op() -> Any:
            for i, (page, usage, dflt) in enumerate(presses):
                if i:
                    await asyncio.sleep(0.12)  # double-press home (UNTESTED on Face ID phones)
                await s.api.button(page, usage, 1)
                await asyncio.sleep(num(a, "holdMs") / 1000 if hold is not None else dflt)
                await s.api.button(page, usage, 2)
            await asyncio.sleep(0.1)  # let dtuhidd dispatch before anything else happens
            return {"button": name}
        return await s.run(op, retry=False)

    async def c_launch(self, a: dict[str, Any]) -> Any:
        s = self.session
        bid = text_arg(a, "bundleId")
        args = a.get("args") or []
        env = a.get("env") or {}
        if not isinstance(args, list) or not all(isinstance(x, str) for x in args):
            raise bad_request("args must be a list of strings")
        if not isinstance(env, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in env.items()):
            raise bad_request("env must be an object of strings")
        kill = bool(a.get("terminateExisting", True))

        async def op() -> Any:
            res = await s.api.launch(bid, args, env, kill)
            return {"bundleId": bid, "pid": find_int(res, "processIdentifier")}
        return await s.run(op, retry=False)

    async def c_terminate(self, a: dict[str, Any]) -> Any:
        bid = text_arg(a, "bundleId")
        return await self.session.run(lambda: self.session.api.terminate(bid))

    async def c_open_url(self, a: dict[str, Any]) -> Any:
        url = text_arg(a, "url")
        if not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", url):
            raise bad_request("url must have a scheme, e.g. https://example.com")
        bid = a.get("bundleId") or "com.apple.mobilesafari"

        async def op() -> Any:
            await self.session.api.open_url(url, bid)
            return {"url": url, "bundleId": bid, "untested": True}
        return await self.session.run(op, retry=False)

    async def c_apps(self, a: dict[str, Any]) -> Any:
        s = self.session

        async def op() -> Any:
            apps = [app_entry(x) for x in await s.api.apps()]
            if not a.get("includeSystem", True):
                apps = [x for x in apps if not x["system"]]
            return {"apps": apps}
        return await s.run(op)

    async def c_rotate(self, a: dict[str, Any]) -> Any:
        s = self.session
        direction = a.get("direction")
        target = a.get("orientation")
        if direction not in (None, "left", "right"):
            raise bad_request("direction must be left or right")
        if direction is None and not isinstance(target, str):
            raise bad_request("give orientation (portrait/landscape) or direction (left/right)")
        goal = orientation_goal(target) if direction is None else set()

        async def op() -> Any:
            steps_done = []
            state: dict[str, Any] = {}
            if direction:
                state = await s.api.rotate(direction)
                steps_done.append(direction)
            else:
                for _ in range(4):
                    plan = plan_rotation(s.orientation, goal)
                    if not plan:
                        break
                    for d in plan:
                        state = await s.api.rotate(d)
                        steps_done.append(d)
                        s.orientation = state.get("currentDeviceOrientation") or None
            if state.get("currentDeviceOrientation"):
                s.orientation = state["currentDeviceOrientation"]
            if steps_done:
                s.screen_stale = True
            return {"orientation": s.orientation, "steps": steps_done,
                    "locked": state.get("currentDeviceOrientationLocked")}
        return await s.run(op, retry=False)

    async def c_clipboard_get(self, a: dict[str, Any]) -> Any:
        return await self.session.run(lambda: self._wrap_text(self.session.api.clipboard_get()))

    @staticmethod
    async def _wrap_text(coro: Awaitable[Optional[str]]) -> Any:
        return {"text": await coro}

    async def c_clipboard_set(self, a: dict[str, Any]) -> Any:
        text = text_arg(a, "text", allow_empty=True)

        async def op() -> Any:
            await self.session.api.clipboard_set(text)
            return {"set": True, "length": len(text)}
        return await self.session.run(op)

    async def c_appearance(self, a: dict[str, Any]) -> Any:
        style = a.get("style")
        if style is not None and style not in ("dark", "light"):
            raise bad_request("style must be dark or light")

        async def op() -> Any:
            return {"style": await self.session.api.appearance(style)}
        return await self.session.run(op)

    async def c_ui(self, a: dict[str, Any]) -> Any:
        """Accessibility elements of the frontmost app (iOS 27 remoteAXService), bounds in screenshot pixels.
        Read-only: asks the phone for a tree dump; nothing is focused, pressed or scrolled."""
        s = self.session
        max_el = int(num(a, "maxElements", 500, lo=1, hi=2000))
        timeout = num(a, "timeoutSec", 6, lo=1, hi=60)
        settle = num(a, "settleMs", 700, lo=0, hi=5000) / 1000
        max_age = num(a, "maxAgeMs", 0, lo=0, hi=600_000) / 1000
        include_off = bool(a.get("includeOffscreen", False))

        if a.get("warm"):
            async def warm() -> Any:
                return {"warm": True, "generation": await s.api.ax_warm()}
            return await s.run(warm, retry_on=("connection_lost",))

        async def op() -> Any:
            w, h = await s.screen_dims(a)
            t0 = time.monotonic()
            st = await s.api.ax_state(timeout, settle, max_age)
            app_frame = None
            if st.app is not None:
                app_a = st.objects.get(st.app[0], {}).get("a", {})
                app_frame = ax_rect(app_a.get(AX_FRAME)) or ax_rect(app_a.get(AX_FRAME_ALT))
            # points -> pixels: the app's frame spans the screen, so derive the factor from it (follows rotation)
            scale = round(w / app_frame[2], 4) if app_frame and app_frame[2] > 0 and app_frame[0] == 0 else \
                float(s.screen.get("scale") or estimate_scale(w, h))
            res = ax_elements(st, scale, (w, h), include_offscreen=include_off, max_elements=max_el)
            res.update({
                "source": "accessibility", "generation": st.generation, "complete": st.complete,
                "ageMs": round((time.monotonic() - (st.received_at or time.monotonic())) * 1000),
                "waitedMs": round((time.monotonic() - t0) * 1000),
                "screen": {"width": w, "height": h, "scale": scale},
            })
            return res
        # A slow tree is not a dead link: tearing the tunnel down and re-waiting on device_timeout made every call
        # cold (14-20 s, then OCR). Only a lost connection reconnects; the subscription survives slow dumps.
        return await s.run(op, retry_on=("connection_lost",))

    async def c_mount_ddi(self, a: dict[str, Any]) -> Any:
        s = self.session

        async def op() -> Any:
            if s.api is not None and not s.api.fake and not all(s.has_service(x) for x in DDI_SERVICES):
                await s._mount_ddi_and_reopen()
                s.api = RealApi(s)
            return {"ddiMounted": True}
        return await s.run(op, retry=False)

    async def c_pair_wifi(self, a: dict[str, Any]) -> Any:
        """Advertise this Mac as a pairable host and accept a device-initiated pairing (iOS 27+). Emits
        {"event": "pair_code", "code": "123456"}. Sends mDNS on the LAN. UNTESTED on hardware."""
        if self.pair_lock.locked():
            raise SidecarError("busy", "pairing is already running", [])
        timeout = num(a, "timeoutSec", 180, lo=10, hi=1800)
        name = a.get("name") or f"PhoneDock on {platform.node().split('.')[0] or 'Mac'}"
        if not isinstance(name, str):
            raise bad_request("name must be a string")
        rid = REQ_ID.get()
        async with self.pair_lock:
            from pymobiledevice3.bonjour import is_multicast_blocked, probe_multicast
            from pymobiledevice3.remote.tunnel_service import PairableHostInfo, serve_pairable_host
            try:
                sent, errors = await probe_multicast()
            except OSError as e:
                raise map_exception(e, wifi=True) from e
            if is_multicast_blocked(sent, errors):
                raise SidecarError("local_network_denied", "This process may not use the local network (macOS Local "
                                   "Network privacy), so the iPhone cannot discover it", errors=[str(x) for x in errors[:3]])
            info_kwargs: dict[str, Any] = {"name": name}
            if a.get("model"):
                info_kwargs["model"] = str(a["model"])
            if a.get("fresh"):
                info_kwargs["identifier"] = str(uuid.uuid4()).upper()
            host = PairableHostInfo(**info_kwargs)
            self.emit({"event": "pair_advertising", "name": host.name, "model": host.model,
                       "steps": ["On the iPhone: Settings > Developer > Paired Macs", f"Tap \"{host.name}\" under Other Devices",
                                 "Enter the 6-digit code PhoneDock shows"]}, rid)

            def on_pin(pin: str) -> None:
                self.emit({"event": "pair_code", "code": pin}, rid)

            def on_wait(elapsed: float) -> None:
                self.emit({"event": "pair_waiting", "elapsedSec": int(elapsed)}, rid)

            try:
                res = await serve_pairable_host(host, pin_callback=on_pin, timeout=timeout, waiting_callback=on_wait,
                                                heartbeat_interval=10.0)
            except asyncio.TimeoutError:
                raise SidecarError("pair_timeout", f"No iPhone started pairing within {timeout:g}s") from None
            except Exception as e:
                se = map_exception(e, wifi=True)
                if se.code == "internal":
                    se = SidecarError("pair_failed", f"Pairing failed: {e}", ["Retry; after several failed codes the "
                                      "iPhone throttles pairing for a while"])
                raise se from e
            peer = res.peer_device
            return {"paired": True, "udid": peer.udid, "name": peer.name, "model": peer.model,
                    "recordPath": str(res.record_path)}

    async def c_shutdown(self, a: dict[str, Any]) -> Any:
        self.stop.set()
        return {"stopping": True}

    # debug-only
    async def c_sleep(self, a: dict[str, Any]) -> Any:
        await asyncio.sleep(num(a, "sec", 1, lo=0, hi=3600))
        return {"slept": a.get("sec", 1)}

    async def c_crash(self, a: dict[str, Any]) -> Any:
        sys.stderr.write("pd-ios-native: _crash requested\n")
        sys.stderr.flush()
        os._exit(int(num(a, "code", 3, lo=0, hi=255)))

    async def c_fake_log(self, a: dict[str, Any]) -> Any:
        async with self.session.lock:  # after queued device operations
            api = self.session.api
            entries = list(api.log) if api is not None and api.fake else []
            if a.get("clear") and api is not None and api.fake:
                api.log.clear()
        return {"log": entries}

    async def c_echo(self, a: dict[str, Any]) -> Any:
        return a


# ═════════════════════════════════════════════════════════════════════════════════════════════════
# Entry point
# ═════════════════════════════════════════════════════════════════════════════════════════════════

def check() -> dict[str, Any]:
    v = pymd3_version()
    ok = v is not None and parse_version(v)[:2] >= MIN_PYMD3
    out: dict[str, Any] = {"ok": ok, "sidecar": SIDECAR_VERSION, "python": sys.executable,
                           "pythonVersion": platform.python_version(), "pymobiledevice3": v}
    if v is None:
        out["error"] = "pymobiledevice3 is not importable by this python"
    elif not ok:
        out["error"] = f"pymobiledevice3 {v} is too old (needs {'.'.join(map(str, MIN_PYMD3))}+): pipx upgrade pymobiledevice3"
    return out


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="PhoneDock iOS 27+ native control sidecar (JSON lines on stdio)")
    ap.add_argument("--udid")
    ap.add_argument("--transport", default="auto", choices=["auto", "usb", "wifi", "native"])
    ap.add_argument("--check", action="store_true", help="print environment info as JSON and exit")
    ap.add_argument("--log-level", default=os.environ.get("PD_IOS_NATIVE_LOG", "WARNING"))
    opts = ap.parse_args(argv)
    if opts.check:
        print(json.dumps(check()))
        return 0
    # Protocol lines go to the real stdout only; anything else that writes to stdout lands on stderr.
    out = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    logging.basicConfig(stream=sys.stderr, level=getattr(logging, str(opts.log_level).upper(), logging.WARNING),
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    fake = os.environ.get("PD_IOS_NATIVE_FAKE") or None
    debug = os.environ.get("PD_IOS_NATIVE_DEBUG") == "1"
    server = Server(out, opts.udid, opts.transport, fake, debug)
    try:
        asyncio.run(server.serve())
    except KeyboardInterrupt:
        pass
    out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
