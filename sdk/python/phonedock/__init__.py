"""PhoneDock Python SDK (stdlib only).

Talks to the PhoneDock daemon HTTP API (docs/API.md). Discovery: $PHONEDOCK_HOME/daemon.json
({"port", "token"}); PHONEDOCK_PORT / PHONEDOCK_URL / PHONEDOCK_TOKEN override. Coordinates are device
screenshot pixels; `screenshot()` returns the scale so you can map downscaled image coords back.
"""
from __future__ import annotations

import json
import errno
import http.client
import os
import re
import shutil
import socket
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Dict, Iterator, List, Optional, Union

__all__ = ["PhoneDock", "PhoneDockApiError", "phonedock_home", "read_daemon_info"]
__version__ = "0.9.0"

DEFAULT_PORT = 47420

#: `expect` of an input: "text" (should be visible), or {"visible": t} | {"gone": t} | {"id": i} | {"changed": True},
#: plus "match" (contains | exact | regex) and "timeoutMs" (default 5000).
Expect = Optional[Union[str, Dict[str, Any]]]


class PhoneDockApiError(Exception):
    """An API error. Input calls also say how far the input got: `delivery` is "sent", "not_sent" or "unknown", and
    `retry_safe` is True only when nothing reached the device (never resend an input whose delivery is unknown)."""
    def __init__(self, message: str, code: str = "error", status: int = 0, hints: Optional[List[str]] = None, detail: Optional[str] = None,
                 delivery: Optional[str] = None, request_id: Optional[str] = None):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status
        self.hints = hints or []
        self.detail = detail
        self.delivery = delivery
        self.retry_safe = delivery == "not_sent" if delivery else None
        self.request_id = request_id

    def __str__(self) -> str:
        s = f"{self.message} [{self.code}]"
        if self.hints:
            s += "\n" + "\n".join(f"  hint: {h}" for h in self.hints)
        return s


def phonedock_home() -> str:
    return os.environ.get("PHONEDOCK_HOME") or os.path.join(os.path.expanduser("~"), "Library", "Application Support", "PhoneDock")


def read_daemon_info(home: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """daemon.json for the default port; daemon-<port>.json when PHONEDOCK_PORT names another daemon."""
    port = os.environ.get("PHONEDOCK_PORT") or str(DEFAULT_PORT)
    name = "daemon.json" if port == str(DEFAULT_PORT) else f"daemon-{port}.json"
    try:
        with open(os.path.join(home or phonedock_home(), name), "r", encoding="utf-8") as f:
            info = json.load(f)
        return info if isinstance(info.get("port"), int) else None
    except (OSError, ValueError):
        return None


def _q(s: str) -> str:
    return urllib.parse.quote(s, safe="")


_APP_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}")
_REQUEST_ID = re.compile(r"[A-Za-z0-9._-]{1,128}")
_INPUT_PATH = re.compile(r"/v1/devices/[^/]+/(?:input|fill|scroll-to|swipe|back|gesture|keyboard/hide|alert|environment|clipboard|apps/[^/]+/launch)/?$")


def _never_connected(error: BaseException) -> bool:
    reason = error.reason if isinstance(error, urllib.error.URLError) else error
    return isinstance(reason, (ConnectionRefusedError, socket.gaierror)) or (
        isinstance(reason, OSError) and reason.errno in (errno.ECONNREFUSED, errno.ENETUNREACH, errno.EHOSTUNREACH))


def _local_url(url: str) -> bool:
    try:
        return urllib.parse.urlsplit(url).hostname in ("127.0.0.1", "localhost", "::1")
    except ValueError:
        return False


def _notes_path(app_id: str) -> str:
    # Checked here as well as by the daemon: a "." or ".." path segment would be resolved into another route first.
    if not isinstance(app_id, str) or not _APP_ID.fullmatch(app_id) or ".." in app_id:
        raise PhoneDockApiError("Invalid app id: use a bundle ID or package name", "bad_request", 400,
                                ["Pass the app's bundle ID (iOS) or package name (Android), e.g. com.apple.Preferences."])
    return f"/v1/app-notes/{_q(app_id)}"


class PhoneDock:
    """Client for the PhoneDock daemon.

    >>> pd = PhoneDock(owner="my-agent")
    >>> pd.devices()
    """

    def __init__(self, base_url: Optional[str] = None, token: Optional[str] = None, owner: Optional[str] = None,
                 auto_start: bool = True, home: Optional[str] = None, timeout: float = 120.0):
        self.home = home or phonedock_home()
        self._base_url = (base_url or os.environ.get("PHONEDOCK_URL") or "").rstrip("/") or None
        self._token = token or os.environ.get("PHONEDOCK_TOKEN")
        self.owner = owner or os.environ.get("PHONEDOCK_OWNER") or f"py:{os.getpid()}"
        self.auto_start = auto_start and os.environ.get("PHONEDOCK_NO_AUTOSTART") != "1"
        self.timeout = timeout
        self._info: Optional[Dict[str, Any]] = None

    # ── connection ────────────────────────────────────────────────────────
    def _load_info(self, refresh: bool = False) -> Optional[Dict[str, Any]]:
        if refresh or self._info is None:
            self._info = read_daemon_info(self.home)
        return self._info

    @property
    def base_url(self) -> str:
        if self._base_url:
            return self._base_url
        port = os.environ.get("PHONEDOCK_PORT")
        if not port:
            info = self._load_info()
            port = str(info["port"]) if info else str(DEFAULT_PORT)
        return f"http://127.0.0.1:{port}"

    @property
    def token(self) -> Optional[str]:
        if self._token:
            return self._token
        info = self._load_info()
        return info.get("token") if info else None

    def health(self) -> Dict[str, Any]:
        return self._request("GET", "/v1/health", retry=False)

    def doctor(self, device_id: Optional[str] = None, capabilities: Optional[List[str]] = None) -> Dict[str, Any]:
        return self._request("GET", "/v1/doctor", query={"device": device_id, "capabilities": ",".join(capabilities) if capabilities else None})

    def inventory_status(self) -> Dict[str, Any]:
        return self._request("GET", "/v1/inventory")

    def environment(self, device_id: str) -> Dict[str, Any]:
        return self._request("GET", self._dev(device_id, "/environment"))

    def set_environment(self, device_id: str, action: Dict[str, Any], request_id: Optional[str] = None) -> Dict[str, Any]:
        return self._request("POST", self._dev(device_id, "/environment"), action, request_id=request_id)

    def audit_ui(self, device_id: str, include_offscreen: bool = False) -> Dict[str, Any]:
        return self._request("GET", self._dev(device_id, "/audit"), query={"includeOffscreen": include_offscreen})

    def inspect_webview(self, device_id: str, app_id: Optional[str] = None, action: str = "snapshot",
                        target_id: Optional[str] = None, bounds: Optional[Dict[str, float]] = None,
                        capture_ms: Optional[int] = None, max_elements: Optional[int] = None, *,
                        selector: Optional[str] = None) -> Dict[str, Any]:
        body = {k: v for k, v in {"appId": app_id, "action": action, "selector": selector, "targetId": target_id,
                                "bounds": bounds, "captureMs": capture_ms, "maxElements": max_elements}.items() if v is not None}
        return self._request("POST", self._dev(device_id, "/webview"), body)

    def is_running(self) -> bool:
        try:
            return bool(self.health().get("ok"))
        except Exception:
            return False

    def ensure_daemon(self, timeout: float = 10.0) -> None:
        """Start the daemon (detached) if /v1/health doesn't answer, then wait up to `timeout` seconds."""
        if self.is_running():
            self._load_info(refresh=True)
            return
        if self._base_url and not _local_url(self._base_url):
            raise PhoneDockApiError(f"PhoneDock daemon at {self._base_url} is not reachable", "daemon_unreachable", 0)
        entry = os.environ.get("PHONEDOCK_DAEMON_ENTRY")
        here = os.path.dirname(os.path.abspath(__file__))
        repo_entry = os.path.normpath(os.path.join(here, "..", "..", "..", "src", "daemon", "main.ts"))
        if not entry and os.path.exists(repo_entry):
            entry = repo_entry
        cli = shutil.which("phonedock")
        if entry:
            node = shutil.which("node") or "/opt/homebrew/bin/node"
            argv = [node, entry]
        elif cli:
            argv = [cli, "daemon", "start"]
        else:
            raise PhoneDockApiError("Cannot find the PhoneDock daemon", "daemon_not_found", 0,
                                    ["Set PHONEDOCK_DAEMON_ENTRY or put `phonedock` on PATH"])
        log_dir = os.path.join(self.home, "logs")
        os.makedirs(log_dir, exist_ok=True)
        env = dict(os.environ, PHONEDOCK_HOME=self.home)
        if self._base_url:
            explicit_port = urllib.parse.urlsplit(self._base_url).port
            if explicit_port is not None:
                env["PHONEDOCK_PORT"] = str(explicit_port)
        with open(os.path.join(log_dir, "daemon.log"), "ab") as log:
            subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=env, start_new_session=True, cwd=self.home)
        deadline = time.time() + timeout
        while time.time() < deadline:
            time.sleep(0.2)
            if self.is_running():
                self._load_info(refresh=True)
                return
        raise PhoneDockApiError("PhoneDock daemon did not become healthy in time", "daemon_start_timeout", 0,
                                [f"See {os.path.join(log_dir, 'daemon.log')}"])

    def _request(self, method: str, path: str, body: Any = None, query: Optional[Dict[str, Any]] = None,
                 raw: bool = False, retry: bool = True, timeout: Optional[float] = None,
                 request_id: Optional[str] = None) -> Any:
        is_input = method.upper() in ("POST", "PUT") and _INPUT_PATH.fullmatch(path) is not None
        if request_id is not None and (not isinstance(request_id, str) or not _REQUEST_ID.fullmatch(request_id) or re.fullmatch(r"\.+", request_id)):
            raise PhoneDockApiError("Invalid request id: use 1–128 letters, digits, periods, underscores or hyphens",
                                    "bad_request", 400, delivery="not_sent")
        if is_input and request_id is None:
            request_id = str(uuid.uuid4())
        q = {k: ("1" if v is True else "0" if v is False else str(v)) for k, v in (query or {}).items() if v is not None}
        url = self.base_url + path + (("?" + urllib.parse.urlencode(q)) if q else "")
        headers = {"X-PhoneDock-Owner": self.owner}
        if request_id is not None:
            headers["X-PhoneDock-Request-ID"] = request_id
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        data = None
        if body is not None:
            try:
                data = json.dumps(body).encode()
            except (TypeError, ValueError):
                raise PhoneDockApiError("The request body cannot be serialized as JSON", "bad_request", 400,
                                        delivery="not_sent" if is_input else None, request_id=request_id) from None
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            resp = urllib.request.urlopen(req, timeout=timeout or self.timeout)
        except urllib.error.HTTPError as e:
            if e.code == 401 and retry and not self._token:
                before = (self._info or {}).get("token")
                if (self._load_info(refresh=True) or {}).get("token") != before:
                    e.close()
                    return self._request(method, path, body, query, raw, retry=False, timeout=timeout, request_id=request_id)
            err = self._to_error(e)
            if is_input and err.delivery is None:
                err.delivery = "not_sent" if e.code == 401 else "unknown"
                err.retry_safe = err.delivery == "not_sent"
            err.request_id = request_id
            raise err from None
        except (urllib.error.URLError, OSError, http.client.HTTPException) as e:
            fresh = _never_connected(e)
            # An input is never replayed after a reset/timeout/drop: the device may already have acted.
            if retry and self.auto_start and (fresh or (not is_input and isinstance(e, urllib.error.URLError))):
                try:
                    self.ensure_daemon()
                except PhoneDockApiError as start_error:
                    if is_input:
                        start_error.delivery = "not_sent"
                        start_error.retry_safe = True
                    start_error.request_id = request_id
                    raise
                return self._request(method, path, body, query, raw, retry=False, timeout=timeout, request_id=request_id)
            delivery = ("not_sent" if fresh else "unknown") if is_input else None
            raise self._transport_error(e, delivery, request_id) from None
        if raw:
            return resp
        try:
            with resp:
                payload = resp.read()
                ctype = resp.headers.get("Content-Type", "")
            if "application/json" in ctype:
                try:
                    return json.loads(payload)
                except (ValueError, UnicodeError):
                    raise PhoneDockApiError("PhoneDock returned invalid JSON", "invalid_response", getattr(resp, "status", 200),
                                            delivery="unknown" if is_input else None, request_id=request_id) from None
            return payload.decode("utf-8", "replace")
        except (OSError, http.client.HTTPException) as e:
            raise self._transport_error(e, "unknown" if is_input else None, request_id) from None

    def _transport_error(self, error: BaseException, delivery: Optional[str], request_id: Optional[str]) -> PhoneDockApiError:
        if delivery == "unknown":
            return PhoneDockApiError("The connection to PhoneDock broke after the input may have been sent", "daemon_unreachable", 0,
                                     ["The input may have reached the device: look at the screen before sending it again."],
                                     delivery=delivery, request_id=request_id)
        reason = error.reason if isinstance(error, urllib.error.URLError) else error
        return PhoneDockApiError(f"PhoneDock daemon not reachable at {self.base_url}: {reason}", "daemon_unreachable", 0,
                                 ["Start it with `phonedock daemon start`"], delivery=delivery, request_id=request_id)

    @staticmethod
    def _to_error(e: urllib.error.HTTPError) -> PhoneDockApiError:
        try:
            j = json.loads(e.read() or b"{}")
            err = j.get("error", j)
            dl = err.get("delivery") if err.get("delivery") in ("sent", "not_sent", "unknown") else None
            return PhoneDockApiError(err.get("message", f"HTTP {e.code}"), err.get("code", f"http_{e.code}"), e.code, err.get("hints") or [], err.get("detail"), dl)
        except Exception:
            return PhoneDockApiError(f"HTTP {e.code} {e.reason}", f"http_{e.code}", e.code)
        finally:
            e.close()

    def _dev(self, device_id: str, sub: str = "") -> str:
        return f"/v1/devices/{_q(device_id)}{sub}"

    def request_result(self, device_id: str, request_id: str) -> Dict[str, Any]:
        """Recover a recorded input result after its response was lost. Never sends input again."""
        if not isinstance(request_id, str) or not _REQUEST_ID.fullmatch(request_id) or re.fullmatch(r"\.+", request_id):
            raise PhoneDockApiError("Invalid request id", "bad_request", 400)
        return self._request("GET", self._dev(device_id, f"/requests/{_q(request_id)}"))

    # ── jobs ──────────────────────────────────────────────────────────────
    def jobs(self) -> List[Dict[str, Any]]:
        return self._request("GET", "/v1/jobs")

    def job(self, job_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/v1/jobs/{_q(job_id)}")

    def wait_job(self, job_id: str, timeout: float = 900.0, interval: float = 1.0) -> Dict[str, Any]:
        deadline = time.time() + timeout
        while True:
            j = self.job(job_id)
            if j.get("state") == "done":
                return j
            if j.get("state") == "failed":
                err = j.get("error")
                if isinstance(err, dict):  # {code, message, hints, detail}; older daemons sent a string
                    raise PhoneDockApiError(err.get("message") or f"job {job_id} failed", err.get("code") or "job_failed", 0,
                                            err.get("hints") or (j.get("progress") or [])[-5:])
                raise PhoneDockApiError(err or f"job {job_id} failed", "job_failed", 0, (j.get("progress") or [])[-5:])
            if time.time() > deadline:
                raise PhoneDockApiError(f"Timed out waiting for job {job_id}", "job_timeout")
            time.sleep(interval)

    # ── catalog ───────────────────────────────────────────────────────────
    def backends(self) -> List[Dict[str, Any]]:
        return self._request("GET", "/v1/backends")

    def components(self) -> List[Dict[str, Any]]:
        return self._request("GET", "/v1/components")

    def install_component(self, component_id: str, wait: bool = True, timeout: float = 900.0) -> Dict[str, Any]:
        res = self._request("POST", f"/v1/components/{_q(component_id)}/install")
        job = res.get("job", res) if isinstance(res, dict) else res
        return self.wait_job(job["id"], timeout=timeout) if wait else job

    def images(self, backend: str) -> List[Dict[str, Any]]:
        return self._request("GET", f"/v1/backends/{_q(backend)}/images")

    def install_image(self, backend: str, image: str, wait: bool = True) -> Dict[str, Any]:
        job = self._request("POST", f"/v1/backends/{_q(backend)}/images/install", {"image": image})
        return self.wait_job(job["id"], timeout=3600) if wait else job

    def profiles(self, backend: str) -> List[Dict[str, Any]]:
        return self._request("GET", f"/v1/backends/{_q(backend)}/profiles")

    # ── devices ───────────────────────────────────────────────────────────
    def devices(self, backend: Optional[str] = None, platform: Optional[str] = None, state: Optional[str] = None) -> List[Dict[str, Any]]:
        return self._request("GET", "/v1/devices", query={"backend": backend, "platform": platform, "state": state})

    def device(self, device_id: str) -> Dict[str, Any]:
        return self._request("GET", self._dev(device_id))

    def resolve_device(self, query: str) -> Dict[str, Any]:
        """Full id, native id, exact name, or unique prefix → Device."""
        query = query.strip()
        if re.match(r"^(android-emulator|android-device|ios-simulator|ios-device|qemu|corellium):.+", query):
            return self.device(query)
        devs = self.devices()
        deadline = time.monotonic() + 5
        status_known = False
        while True:
            try:
                status = self.inventory_status()
                status_known = True
            except PhoneDockApiError as error:
                if error.status == 404:  # older daemon
                    break
                raise
            unresolved = [(name, s) for name, s in status.items() if s.get("at") is None]
            if not unresolved:
                break
            if any(s.get("error") or s.get("timedOut") for _, s in unresolved):
                raise PhoneDockApiError("Device discovery is incomplete", "inventory_incomplete", 503,
                                        ["Use the full backend:nativeId. Unresolved backends: " + ", ".join(name for name, _ in unresolved)])
            if time.monotonic() >= deadline:
                raise PhoneDockApiError("Device discovery is still warming", "inventory_pending", 503,
                                        ["Use the full backend:nativeId or retry after discovery completes."])
            time.sleep(0.1)
        if status_known:
            devs = self.devices()
        for pred in (lambda d: d["id"] == query, lambda d: d.get("nativeId") == query, lambda d: d.get("name") == query,
                     lambda d: d["id"].startswith(query) or d.get("nativeId", "").startswith(query) or d.get("name", "").lower().startswith(query.lower())):
            m = [d for d in devs if pred(d)]
            if len(m) == 1:
                return m[0]
            if len(m) > 1:
                raise PhoneDockApiError(f'"{query}" matches {len(m)} devices', "ambiguous_device", 400, [d["id"] for d in m[:10]])
        raise PhoneDockApiError(f'No device matches "{query}"', "not_found", 404)

    def create(self, backend: str, name: str, wait: bool = True, boot: bool = False, **spec: Any) -> Dict[str, Any]:
        """Create a device. spec keys follow DeviceSpec (image, profile, cpus, ramMB, storageMB, width, height, dpi, autoStart, options)."""
        r = self._request("POST", "/v1/devices", {"backend": backend, "name": name, "boot": boot, **spec})
        if not wait:
            return r
        j = self.wait_job(r["job"]["id"], timeout=1800)
        return j.get("result") or r.get("device")

    def update(self, device_id: str, name: Optional[str] = None, auto_start: Optional[bool] = None) -> Dict[str, Any]:
        patch: Dict[str, Any] = {}
        if name is not None:
            patch["name"] = name
        if auto_start is not None:
            patch["autoStart"] = auto_start
        return self._request("PATCH", self._dev(device_id), patch)

    def delete(self, device_id: str, force: bool = False) -> Dict[str, Any]:
        return self._request("DELETE", self._dev(device_id), query={"force": 1 if force else None})

    def boot(self, device_id: str, wait: bool = True, cold: bool = False, window: bool = False, slim: Optional[Union[bool, str]] = None) -> Dict[str, Any]:
        body: Dict[str, Any] = {"coldBoot": cold, "window": window}
        if slim is not None:
            body["slim"] = slim
        r = self._request("POST", self._dev(device_id, "/boot"), body)
        return self.wait_job(r["job"]["id"], timeout=600) if wait and r.get("job") else r

    def shutdown(self, device_id: str) -> Dict[str, Any]:
        return self._request("POST", self._dev(device_id, "/shutdown"), {})

    def idle_sleep(self) -> Dict[str, Any]:
        """When idle Android emulators PhoneDock created go to sleep (their memory is freed; any use wakes them where
        they left off), and where each one is: ``{timeoutSec, source, choices, devices}``. ``timeoutSec`` None: never."""
        return self._request("GET", "/v1/idle-sleep")

    def set_idle_sleep(self, after: Union[int, str, None]) -> Dict[str, Any]:
        """Set it: None (never) or 600, 900, 1800, 3600 seconds; or "off", "10m", "15m", "30m", "1h"."""
        body = {"after": after} if isinstance(after, str) else {"timeoutSec": after}
        return self._request("POST", "/v1/idle-sleep", body)

    def simslim(self) -> Dict[str, Any]:
        """SimSlim setting and availability for iOS simulators."""
        return self._request("GET", "/v1/simslim")

    def set_simslim(self, enabled: Optional[bool] = None, except_categories: Optional[List[str]] = None, profile_path: Optional[str] = None) -> Dict[str, Any]:
        body: Dict[str, Any] = {}
        if enabled is not None:
            body["enabled"] = enabled
        if except_categories is not None:
            body["except"] = except_categories
        if profile_path is not None:
            body["profilePath"] = profile_path
        return self._request("POST", "/v1/simslim", body)

    def device_simslim(self, device_id: str, action: str = "status", no_reboot: bool = False) -> Dict[str, Any]:
        return self._request("POST", self._dev(device_id, "/simslim"), {"action": action, "noReboot": no_reboot})

    def clone(self, device_id: str, name: str, wait: bool = True) -> Dict[str, Any]:
        r = self._request("POST", self._dev(device_id, "/clone"), {"name": name})
        return self.wait_job(r["job"]["id"], timeout=1800).get("result") if wait else r

    def snapshots(self, device_id: str) -> List[Dict[str, Any]]:
        return self._request("GET", self._dev(device_id, "/snapshots"))

    def save_snapshot(self, device_id: str, name: str) -> Dict[str, Any]:
        return self._request("POST", self._dev(device_id, "/snapshots"), {"name": name})

    def restore_snapshot(self, device_id: str, name: str) -> Dict[str, Any]:
        return self._request("POST", self._dev(device_id, f"/snapshots/{_q(name)}/restore"), {})

    def delete_snapshot(self, device_id: str, name: str) -> Dict[str, Any]:
        return self._request("DELETE", self._dev(device_id, f"/snapshots/{_q(name)}"))

    # ── observation ───────────────────────────────────────────────────────
    def screenshot(self, device_id: str, format: Optional[str] = None, max_size: Optional[int] = None, quality: Optional[int] = None) -> Dict[str, Any]:
        """Returns {data: bytes, mime, deviceWidth, deviceHeight, imageWidth, imageHeight, scale} (scale = device px / image px)."""
        resp = self._request("GET", self._dev(device_id, "/screenshot"), query={"format": format, "maxSize": max_size, "quality": quality}, raw=True)
        data = resp.read()
        h = resp.headers

        def num(k: str) -> float:
            try:
                return float(h.get(k) or 0)
            except ValueError:
                return 0.0
        iw, ih = num("X-Image-Width"), num("X-Image-Height")
        dw, dh = num("X-Device-Width") or iw, num("X-Device-Height") or ih
        return {"data": data, "mime": (h.get("Content-Type") or "image/png").split(";")[0], "deviceWidth": dw, "deviceHeight": dh,
                "imageWidth": iw, "imageHeight": ih, "scale": num("X-Scale") or ((dw / iw) if iw else 1.0)}

    def ui(self, device_id: str, ocr_fallback: Optional[bool] = None) -> Dict[str, Any]:
        return self._request("GET", self._dev(device_id, "/ui"), query={"format": "json", "ocrFallback": ocr_fallback})

    def ui_text(self, device_id: str, ocr_fallback: Optional[bool] = None) -> str:
        return self._request("GET", self._dev(device_id, "/ui"), query={"format": "text", "ocrFallback": ocr_fallback})

    # ── input ─────────────────────────────────────────────────────────────
    def input(self, device_id: str, action: Union[Dict[str, Any], List[Dict[str, Any]]], expect: Expect = None,
              snapshot_id: Optional[str] = None, return_ui: bool = False, request_id: Optional[str] = None,
              settle_ms: Optional[int] = None) -> Dict[str, Any]:
        """One action or several in a row. The result has `delivery` ("sent" / "not_sent") and `retrySafe`; with
        `expect` (checked once, after the last action) also `expect`: {ok, outcome, message, …}, where outcome is
        "verified", "screen_unchanged" or "changed_not_found". expect: "text" (visible), {"visible": t},
        {"gone": t}, {"id": i} or {"changed": True}, plus "match" and "timeoutMs" (default 5000)."""
        body: Dict[str, Any] = {"actions": action} if isinstance(action, list) else dict(action)
        if expect is not None:
            body["expect"] = expect
        if snapshot_id is not None:
            body["snapshotId"] = snapshot_id
        if return_ui:
            body["returnUi"] = True
        if settle_ms is not None:
            body["settleMs"] = settle_ms
        return self._request("POST", self._dev(device_id, "/input"), body, request_id=request_id)

    def tap(self, device_id: str, x: float, y: float, label: Optional[str] = None,
            selector: Optional[Dict[str, Any]] = None, element: Optional[Dict[str, Any]] = None, expect: Expect = None,
            return_ui: bool = False, request_id: Optional[str] = None, settle_ms: Optional[int] = None) -> Dict[str, Any]:
        """`label` names what the tap is aimed at; `selector` ({text, id, type, match, index}) is the find query that
        chose the point and `element` ({type, id, editable}) what it hit. All three only show in the activity log
        (`save_flow` turns a selector into `tap: <text>`)."""
        body: Dict[str, Any] = {"action": "tap", "x": round(x), "y": round(y)}
        if label:
            body["label"] = label[:80]
        if selector:
            body["selector"] = {k: v for k, v in selector.items() if v not in (None, "", 0) and not (k == "match" and v == "contains")}
        if element:
            body["element"] = {k: v for k, v in element.items() if v is not None}
        return self.input(device_id, body, expect, return_ui=return_ui, request_id=request_id, settle_ms=settle_ms)

    def tap_ref(self, device_id: str, ref: str, expect: Expect = None, snapshot_id: Optional[str] = None,
                return_ui: bool = False, request_id: Optional[str] = None, settle_ms: Optional[int] = None) -> Dict[str, Any]:
        return self.input(device_id, {"action": "tap", "ref": ref.lstrip("@")}, expect, snapshot_id=snapshot_id,
                          return_ui=return_ui, request_id=request_id, settle_ms=settle_ms)

    def long_press(self, device_id: str, x: float, y: float, duration_ms: Optional[int] = None, expect: Expect = None,
                   return_ui: bool = False, request_id: Optional[str] = None, settle_ms: Optional[int] = None) -> Dict[str, Any]:
        return self.input(device_id, {"action": "longPress", "x": round(x), "y": round(y), "durationMs": duration_ms},
                          expect, return_ui=return_ui, request_id=request_id, settle_ms=settle_ms)

    def swipe(self, device_id: str, x1: float, y1: float, x2: float, y2: float, duration_ms: Optional[int] = None,
              expect: Expect = None, return_ui: bool = False, request_id: Optional[str] = None,
              settle_ms: Optional[int] = None) -> Dict[str, Any]:
        return self.input(device_id, {"action": "swipe", "x1": round(x1), "y1": round(y1), "x2": round(x2), "y2": round(y2),
                                      "durationMs": duration_ms}, expect, return_ui=return_ui, request_id=request_id, settle_ms=settle_ms)

    def type(self, device_id: str, text: str, secret: bool = False, expect: Expect = None,
             return_ui: bool = False, request_id: Optional[str] = None, settle_ms: Optional[int] = None) -> Dict[str, Any]:
        """secret=True keeps the text out of the action log (stored as '•••'; replay skips it)."""
        action: Dict[str, Any] = {"action": "type", "text": text}
        if secret:
            action["secret"] = True
        return self.input(device_id, action, expect, return_ui=return_ui, request_id=request_id, settle_ms=settle_ms)

    def swipe_direction(self, device_id: str, direction: str, distance: Optional[float] = None, duration_ms: Optional[int] = None,
                        x: Optional[float] = None, y: Optional[float] = None, expect: Expect = None,
                        return_ui: bool = False, request_id: Optional[str] = None, settle_ms: Optional[int] = None) -> Dict[str, Any]:
        """Swipe the finger up/down/left/right ("up" reveals what is below) inside the scroll container, never on the
        keyboard. Returns {swipe, container, delivery, …}; with expect (see input()) also `expect`."""
        body = {k: v for k, v in {"direction": direction, "distance": distance, "durationMs": duration_ms,
                                  "x": None if x is None else round(x), "y": None if y is None else round(y), "expect": expect,
                                  "returnUi": True if return_ui else None, "settleMs": settle_ms}.items() if v is not None}
        return self._request("POST", self._dev(device_id, "/swipe"), body, request_id=request_id)

    def double_tap(self, device_id: str, x: float, y: float, expect: Expect = None,
                   return_ui: bool = False, request_id: Optional[str] = None, settle_ms: Optional[int] = None) -> Dict[str, Any]:
        return self.input(device_id, {"action": "doubleTap", "x": round(x), "y": round(y)}, expect,
                          return_ui=return_ui, request_id=request_id, settle_ms=settle_ms)

    def pinch(self, device_id: str, x: float, y: float, scale: float, duration_ms: Optional[int] = None,
              return_ui: bool = False, request_id: Optional[str] = None, settle_ms: Optional[int] = None) -> Dict[str, Any]:
        """scale < 1 pinches in (zoom out), > 1 spreads (zoom in)."""
        return self.input(device_id, {"action": "pinch", "x": round(x), "y": round(y), "scale": scale, "durationMs": duration_ms},
                          return_ui=return_ui, request_id=request_id, settle_ms=settle_ms)

    def hide_keyboard(self, device_id: str, return_ui: bool = False, request_id: Optional[str] = None,
                      settle_ms: Optional[int] = None) -> Dict[str, Any]:
        body = {k: v for k, v in {"returnUi": True if return_ui else None, "settleMs": settle_ms}.items() if v is not None}
        return self._request("POST", self._dev(device_id, "/keyboard/hide"), body, request_id=request_id)

    # ── find / wait / fill ────────────────────────────────────────────────
    @staticmethod
    def _query(text: Optional[str], id: Optional[str], type: Optional[str], match: Optional[str], **extra: Any) -> Dict[str, Any]:
        q = {"text": text, "id": id, "type": type, "match": match, **extra}
        return {k: v for k, v in q.items() if v is not None}

    def find(self, device_id: str, text: Optional[str] = None, id: Optional[str] = None, type: Optional[str] = None,
             match: Optional[str] = None, index: Optional[int] = None, ocr_fallback: Optional[bool] = None, limit: Optional[int] = None) -> Dict[str, Any]:
        """Ranked element search (exact > contains, clickable > not, visible > not; OCR fallback).
        Returns {source, total, index, match, matches, screen, capturedAt, ocrTried, summary?}; centres are device pixels."""
        return self._request("POST", self._dev(device_id, "/find"),
                             self._query(text, id, type, match, index=index, ocrFallback=ocr_fallback, limit=limit))

    def tap_text(self, device_id: str, text: str, match: Optional[str] = None, index: Optional[int] = None, type: Optional[str] = None) -> Dict[str, Any]:
        """find() then tap the chosen match. Returns the match; raises PhoneDockApiError('not_found') if nothing matches."""
        r = self.find(device_id, text=text, type=type, match=match, index=index)
        m = r.get("match")
        if not m:
            raise PhoneDockApiError(f"Nothing on screen matches {text!r}", "not_found", 404, [f"Screen now: {r.get('summary', '?')}"])
        self.tap(device_id, m["center"]["x"], m["center"]["y"], (m.get("text") or m.get("label") or "").strip() or None,
                 selector={"text": text, "type": type, "match": match, "index": index},
                 element={"type": m.get("type"), "id": m.get("id"), "editable": True if m.get("editable") else None})
        return m

    def wait_for(self, device_id: str, until: str, text: Optional[str] = None, id: Optional[str] = None, type: Optional[str] = None,
                 match: Optional[str] = None, timeout_ms: int = 10000, interval_ms: Optional[int] = None, stable_ms: Optional[int] = None) -> Dict[str, Any]:
        """until = 'visible' | 'gone' | 'idle'. Raises PhoneDockApiError('wait_timeout', 408) with a screen summary in hints."""
        body = self._query(text, id, type, match, until=until, timeoutMs=timeout_ms, intervalMs=interval_ms, stableMs=stable_ms)
        return self._request("POST", self._dev(device_id, "/wait"), body, timeout=max(self.timeout, timeout_ms / 1000 + 30))

    def fill(self, device_id: str, value: str, text: Optional[str] = None, ref: Optional[str] = None, id: Optional[str] = None,
             type: Optional[str] = None, match: Optional[str] = None, index: Optional[int] = None, x: Optional[float] = None,
             y: Optional[float] = None, clear: bool = True, submit: bool = False, secret: bool = False, expect: Expect = None,
             snapshot_id: Optional[str] = None, return_ui: bool = False, request_id: Optional[str] = None,
             settle_ms: Optional[int] = None) -> Dict[str, Any]:
        """Tap a field (by text/ref/id or device-pixel x,y), wait for focus, clear it, type value, re-read and verify.
        Returns {element, cleared, clearMethod, previousValue, finalValue, verified, warnings, elapsedMs, delivery, …};
        with expect (see input()) also `expect`."""
        body = self._query(text, id, type, match, value=value, ref=ref, index=index, clear=clear, submit=submit, secret=secret,
                           x=None if x is None else round(x), y=None if y is None else round(y), expect=expect,
                           snapshotId=snapshot_id, returnUi=True if return_ui else None, settleMs=settle_ms)
        return self._request("POST", self._dev(device_id, "/fill"), body, request_id=request_id)

    def focus(self, device_id: str, wait_ms: Optional[int] = None) -> Dict[str, Any]:
        """{known, ok, focused, keyboard, elapsedMs}: the focused text field / whether a keyboard is up."""
        return self._request("GET", self._dev(device_id, "/focus"), query={"waitMs": wait_ms})

    def scroll_to(self, device_id: str, text: str, match: Optional[str] = None, type: Optional[str] = None,
                  direction: Optional[str] = None, max_scrolls: Optional[int] = None, x: Optional[float] = None,
                  y: Optional[float] = None, ocr_fallback: Optional[bool] = None, return_ui: bool = False,
                  request_id: Optional[str] = None, settle_ms: Optional[int] = None) -> Dict[str, Any]:
        """Slow, precise swipes until an element matching `text` is on screen. direction = where to look
        ('down' default, 'up', 'left', 'right'); x, y = device-pixel point to swipe around. Returns
        {found, element, scrolls, endReached, reason?, …}; found is False with reason 'end reached, not found'
        when a swipe no longer moves the content."""
        body = self._query(text, None, type, match, direction=direction, maxScrolls=max_scrolls, ocrFallback=ocr_fallback,
                           x=None if x is None else round(x), y=None if y is None else round(y),
                           returnUi=True if return_ui else None, settleMs=settle_ms)
        return self._request("POST", self._dev(device_id, "/scroll-to"), body, timeout=max(self.timeout, 300.0), request_id=request_id)

    # ── flows ─────────────────────────────────────────────────────────────
    def save_flow(self, device_id: str, since: Optional[str] = None, until: Optional[str] = None, owner: Optional[str] = None,
                  name: Optional[str] = None, app_id: Optional[str] = None, assertions: Optional[List[Any]] = None,
                  auto_assert: Optional[bool] = None, keep_noise: bool = False, format: str = "yaml",
                  path: Optional[str] = None) -> Dict[str, Any]:
        """Turn this device's recent actions into a flow (a YAML regression test that `phonedock test` runs).
        since/until: ISO time or a duration back from now ("10m"); default the latest session. owner: only that
        owner's actions (e.g. self.owner). assertions: texts that must be visible at the end ("!text": must not be),
        or flow steps such as {"assert_text": {"field": "id:status", "equals": "On"}}.
        Returns {text, flow, warnings, dropped, stats, range}; with path, also writes the text there."""
        body = {k: v for k, v in {"since": since, "until": until, "owner": owner, "name": name, "appId": app_id,
                                  "assertions": assertions, "autoAssert": auto_assert, "keepNoise": keep_noise or None,
                                  "format": format}.items() if v is not None}
        r = self._request("POST", self._dev(device_id, "/flow"), body)
        if path:
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                f.write(r["text"])
            r["path"] = os.path.abspath(path)
        return r

    # ── navigation / system UI / prompts ──────────────────────────────────
    def go_back(self, device_id: str, return_ui: bool = False, request_id: Optional[str] = None,
                settle_ms: Optional[int] = None) -> Dict[str, Any]:
        """{ok, method, tapped?}: Android presses Back; iOS taps the nav bar back button, else swipes from the left edge."""
        body = {k: v for k, v in {"returnUi": True if return_ui else None, "settleMs": settle_ms}.items() if v is not None}
        return self._request("POST", self._dev(device_id, "/back"), body, request_id=request_id)

    def system_gesture(self, device_id: str, gesture: str, return_ui: bool = False, request_id: Optional[str] = None,
                       settle_ms: Optional[int] = None) -> Dict[str, Any]:
        """gesture = 'go_home' | 'app_switcher' | 'control_center' | 'notification_center'."""
        body = {k: v for k, v in {"gesture": gesture, "returnUi": True if return_ui else None, "settleMs": settle_ms}.items() if v is not None}
        return self._request("POST", self._dev(device_id, "/gesture"), body, request_id=request_id)

    def prompt(self, device_id: str, ocr_fallback: Optional[bool] = None) -> Dict[str, Any]:
        """{prompt, source, capturedAt}: the system prompt / alert on screen (prompt is None when there is none).
        prompt = {kind, reason, buttons: [{text, ref?, bounds, role?}], needsHuman, title?, message?}."""
        return self._request("GET", self._dev(device_id, "/prompt"), query={"ocrFallback": ocr_fallback})

    def handle_alert(self, device_id: str, action: str = "accept", button: Optional[str] = None,
                     return_ui: bool = False, request_id: Optional[str] = None, settle_ms: Optional[int] = None) -> Dict[str, Any]:
        """Tap a system prompt's button by text: action 'accept' | 'dismiss' | 'button=<label>' (or pass button=).
        Raises PhoneDockApiError('needs_human', 403) for passcode / biometric / credential / profile / Allow Paste
        prompts (use request_human), 'no_prompt' 404 when nothing is on screen. Never types."""
        body: Dict[str, Any] = {"action": "button", "button": button} if button else {"action": action}
        if return_ui:
            body["returnUi"] = True
        if settle_ms is not None:
            body["settleMs"] = settle_ms
        return self._request("POST", self._dev(device_id, "/alert"), body, request_id=request_id)

    # ── human handoff ─────────────────────────────────────────────────────
    def request_handoff(self, device_id: str, reason: str, timeout_sec: Optional[int] = None) -> Dict[str, Any]:
        """Ask a human to do something on the device. Raises 409 handoff_pending if one is already open."""
        body: Dict[str, Any] = {"reason": reason}
        if timeout_sec is not None:
            body["timeoutSec"] = timeout_sec
        return self._request("POST", self._dev(device_id, "/handoff"), body)

    def handoffs(self, state: Optional[str] = None, device_id: Optional[str] = None) -> List[Dict[str, Any]]:
        return self._request("GET", "/v1/handoffs", query={"state": state, "deviceId": device_id})

    def handoff(self, handoff_id: str, wait_sec: Optional[int] = None) -> Dict[str, Any]:
        """Get a handoff; wait_sec (≤60) long-polls until it is no longer pending."""
        return self._request("GET", f"/v1/handoffs/{_q(handoff_id)}", query={"waitSec": wait_sec},
                             timeout=max(self.timeout, (wait_sec or 0) + 30))

    def resolve_handoff(self, handoff_id: str, state: str, note: Optional[str] = None) -> Dict[str, Any]:
        """state = 'done' | 'cancelled'."""
        body: Dict[str, Any] = {"state": state}
        if note is not None:
            body["note"] = note
        return self._request("POST", f"/v1/handoffs/{_q(handoff_id)}/resolve", body)

    def wait_handoff(self, handoff_id: str) -> Dict[str, Any]:
        """Block until the handoff is done / cancelled / timeout."""
        while True:
            h = self.handoff(handoff_id, wait_sec=25)
            if h.get("state") != "pending":
                return h

    def request_human(self, device_id: str, reason: str, timeout_sec: Optional[int] = None) -> Dict[str, Any]:
        """request_handoff() + wait_handoff()."""
        return self.wait_handoff(self.request_handoff(device_id, reason, timeout_sec)["id"])

    # ── app state / diagnostics ───────────────────────────────────────────
    def foreground_app(self, device_id: str) -> Optional[Dict[str, Any]]:
        """AppInfo of the foreground app, or None (home screen / unknown)."""
        return self._request("GET", self._dev(device_id, "/foreground")).get("app")

    def crashes(self, device_id: str, since: Optional[str] = None, app_id: Optional[str] = None, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        return self._request("GET", self._dev(device_id, "/crashes"), query={"since": since, "appId": app_id, "limit": limit})

    def crash(self, device_id: str, crash_id: str, full: bool = False, max_chars: Optional[int] = None) -> Dict[str, Any]:
        """{id, text, truncated, length}: header + crashed thread unless full=True."""
        return self._request("GET", self._dev(device_id, f"/crashes/{_q(crash_id)}"), query={"full": 1 if full else None, "maxChars": max_chars})

    def start_recording(self, device_id: str, max_seconds: Optional[int] = None) -> Dict[str, Any]:
        body: Dict[str, Any] = {} if max_seconds is None else {"maxSeconds": max_seconds}
        return self._request("POST", self._dev(device_id, "/recording/start"), body)

    def stop_recording(self, device_id: str) -> Dict[str, Any]:
        """{path, sizeBytes, durationSec}."""
        return self._request("POST", self._dev(device_id, "/recording/stop"), {})

    def recording(self, device_id: str) -> Dict[str, Any]:
        return self._request("GET", self._dev(device_id, "/recording"))

    # Performance traces (docs/API.md "Performance traces"): start, drive the flow, stop, read the summary,
    # change the code, then trace the same flow again; stop compares with the previous run of the same app + template.
    def start_trace(self, device_id: str, app_id: str, template: Optional[str] = None,
                    time_limit_sec: Optional[int] = None, launch: Optional[bool] = None) -> Dict[str, Any]:
        """iOS: xctrace (default template "Time Profiler" + Hangs). Android: perfetto + gfxinfo frame stats.
        {traceId, appId, tool, template, instruments, process, timeLimitSec, startedAt, dir}."""
        body: Dict[str, Any] = {"appId": app_id}
        if template is not None:
            body["template"] = template
        if time_limit_sec is not None:
            body["timeLimitSec"] = time_limit_sec
        if launch is not None:
            body["launch"] = launch
        return self._request("POST", self._dev(device_id, "/trace/start"), body, timeout=max(self.timeout, 300.0))

    def stop_trace(self, device_id: str, compare_to: Optional[str] = None, top: Optional[int] = None,
                   triage_chars: Optional[int] = None) -> Dict[str, Any]:
        """{ok, traceId, text, summary}. summary.metrics has the same keys every run (null = not measured);
        summary.compare has before/after/delta per metric vs the previous trace (compare_to="none" turns it off)."""
        body: Dict[str, Any] = {}
        if compare_to is not None:
            body["compareTo"] = compare_to
        if top is not None:
            body["top"] = top
        if triage_chars is not None:
            body["triageChars"] = triage_chars
        return self._request("POST", self._dev(device_id, "/trace/stop"), body, timeout=max(self.timeout, 600.0))   # finalize + analysis

    def trace(self, device_id: str) -> Dict[str, Any]:
        """{active, traceId?, appId?, startedAt?, timeLimitSec?, finished?} – finished = a trace the time limit ended."""
        return self._request("GET", self._dev(device_id, "/trace"))

    def traces(self, device_id: str, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        """Earlier traces of the device, newest first: [{traceId, appId, template, startedAt, metrics, files}]."""
        return self._request("GET", self._dev(device_id, "/traces"), query={"limit": limit})

    def app_data(self, device_id: str, app_id: str) -> List[Dict[str, Any]]:
        """Saved app-data snapshots, newest first."""
        return self._request("GET", self._dev(device_id, f"/apps/{_q(app_id)}/data"))

    def export_app_data(self, device_id: str, app_id: str, name: str) -> Dict[str, Any]:
        return self._request("POST", self._dev(device_id, f"/apps/{_q(app_id)}/data/export"), {"name": name})

    def import_app_data(self, device_id: str, app_id: str, name: str) -> Dict[str, Any]:
        return self._request("POST", self._dev(device_id, f"/apps/{_q(app_id)}/data/import"), {"name": name})

    # ── app notes (per app, shared by every agent on this Mac) ──────────────
    def app_notes_list(self) -> List[Dict[str, Any]]:
        """Every app with notes, newest first: [{appId, path, updatedAt, sizeBytes}]."""
        return self._request("GET", "/v1/app-notes")

    def app_notes(self, app_id: str) -> Dict[str, Any]:
        """One app's notes: {appId, path, notes, updatedAt, sizeBytes}; notes is None when there are none yet."""
        return self._request("GET", _notes_path(app_id))

    def save_app_notes(self, app_id: str, notes: str) -> Dict[str, Any]:
        """Replace one app's notes (Markdown, at most 32 KB): {ok, appId, path, updatedAt, sizeBytes, created}."""
        return self._request("PUT", _notes_path(app_id), {"notes": notes})

    def delete_app_notes(self, app_id: str) -> Dict[str, Any]:
        """{ok, appId, path, deleted}; deleted is False when there were none."""
        return self._request("DELETE", _notes_path(app_id))

    def key(self, device_id: str, key: str, expect: Expect = None, return_ui: bool = False,
            request_id: Optional[str] = None, settle_ms: Optional[int] = None) -> Dict[str, Any]:
        return self.input(device_id, {"action": "key", "key": key}, expect, return_ui=return_ui, request_id=request_id, settle_ms=settle_ms)

    # ── apps / system ─────────────────────────────────────────────────────
    def apps(self, device_id: str, system: bool = False) -> List[Dict[str, Any]]:
        return self._request("GET", self._dev(device_id, "/apps"), query={"system": 1 if system else None})

    def app_info(self, device_id: str, app_id: str) -> Optional[Dict[str, Any]]:
        """Single-app metadata (version + build), or None when the app is not installed."""
        try:
            return self._request("GET", self._dev(device_id, f"/apps/{_q(app_id)}"))
        except PhoneDockApiError as e:
            if e.status == 404 and e.code == "not_found":
                return None
            raise

    # ── flow run records (schemaVersion: 1) ───────────────────────────────
    def list_runs(self, device: Optional[str] = None, status: Optional[str] = None, flow: Optional[str] = None,
                  app_id: Optional[str] = None, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        """List recorded flow runs (newest first)."""
        return self._request("GET", "/v1/runs", query={"device": device, "status": status, "flow": flow, "appId": app_id, "limit": limit})

    def get_run(self, run_id: str) -> Dict[str, Any]:
        """Fetch a single RunRecord by ID."""
        return self._request("GET", f"/v1/runs/{_q(run_id)}")

    def export_run(self, run_id: str, format: str = "md") -> str:
        """Export a run record as public-safe Markdown ('md') or JSON ('json')."""
        resp = self._request("GET", f"/v1/runs/{_q(run_id)}/export", query={"format": format}, raw=True)
        return resp.read().decode("utf-8", "replace")

    def save_run(self, record: Dict[str, Any]) -> Dict[str, Any]:
        """Persist a schemaVersion=1 RunRecord to the daemon store (409 conflict if ID already exists)."""
        return self._request("POST", "/v1/runs", record)

    def install(self, device_id: str, path_or_url: str) -> Dict[str, Any]:
        if path_or_url.startswith(("http://", "https://")):
            body = {"url": path_or_url}
        else:
            body = {"path": os.path.abspath(path_or_url)}
        return self._request("POST", self._dev(device_id, "/apps"), body)

    def uninstall(self, device_id: str, app_id: str) -> Dict[str, Any]:
        return self._request("DELETE", self._dev(device_id, f"/apps/{_q(app_id)}"))

    def launch(self, device_id: str, app_id: str, expect: Expect = None,
               args: Optional[Union[List[str], Dict[str, Any]]] = None,
               env: Optional[Dict[str, str]] = None,
               verify: Optional[bool] = None,
               return_ui: bool = False,
               request_id: Optional[str] = None,
               settle_ms: Optional[int] = None) -> Dict[str, Any]:
        body: Dict[str, Any] = {}
        if expect is not None:
            body["expect"] = expect
        if args is not None:
            body["args"] = args
        if env is not None:
            body["env"] = env
        if verify is not None:
            body["verify"] = verify
        if return_ui:
            body["returnUi"] = True
        if settle_ms is not None:
            body["settleMs"] = settle_ms
        return self._request("POST", self._dev(device_id, f"/apps/{_q(app_id)}/launch"), body, request_id=request_id)

    def terminate(self, device_id: str, app_id: str) -> Dict[str, Any]:
        return self._request("POST", self._dev(device_id, f"/apps/{_q(app_id)}/terminate"), {})

    def open_url(self, device_id: str, url: str) -> Dict[str, Any]:
        return self._request("POST", self._dev(device_id, "/open-url"), {"url": url})

    def shell(self, device_id: str, command: str) -> Dict[str, Any]:
        return self._request("POST", self._dev(device_id, "/shell"), {"command": command})

    def settings(self, device_id: str) -> Dict[str, Any]:
        return self._request("GET", self._dev(device_id, "/settings"))

    def set_settings(self, device_id: str, settings: Dict[str, Any]) -> Dict[str, Any]:
        return self._request("POST", self._dev(device_id, "/settings"), settings)

    def reset_settings(self, device_id: str) -> Dict[str, Any]:
        return self._request("POST", self._dev(device_id, "/settings/reset"), {})

    def appearance(self, device_id: str) -> Dict[str, Any]:
        """Current system appearance: {"appearance": "dark" | "light" | "unknown"}."""
        return self._request("GET", self._dev(device_id, "/appearance"))

    def set_appearance(self, device_id: str, mode: str) -> Dict[str, Any]:
        """Switch to "dark" or "light" (iOS simulator: simctl ui; Android: cmd uimode night)."""
        return self._request("POST", self._dev(device_id, "/appearance"), {"appearance": mode})

    def get_clipboard(self, device_id: str) -> Optional[str]:
        """The device clipboard's plain text, or None when it is empty or holds no text (capability "clipboard":
        iOS simulators, Android, iPhones on iOS 27+)."""
        return self._request("GET", self._dev(device_id, "/clipboard")).get("text")

    def set_clipboard(self, device_id: str, text: str, request_id: Optional[str] = None) -> Dict[str, Any]:
        """Replace the device clipboard with `text` (needs the lease): {"ok": True, "length": N}. Only the length is logged."""
        return self._request("PUT", self._dev(device_id, "/clipboard"), {"text": text}, request_id=request_id)

    def logs(self, device_id: str, lines: Optional[int] = None, filter: Optional[str] = None) -> str:
        return self._request("GET", self._dev(device_id, "/logs"), query={"lines": lines, "filter": filter})

    def set_location(self, device_id: str, lat: float, lon: float) -> Dict[str, Any]:
        return self._request("POST", self._dev(device_id, "/location"), {"lat": lat, "lon": lon})

    def start_location_route(self, device_id: str, gpx: Optional[str] = None, waypoints: Optional[List[Dict[str, float]]] = None, speed_mps: float = 5.0, loop: bool = False) -> Dict[str, Any]:
        body: Dict[str, Any] = {"speedMps": speed_mps, "loop": loop}
        if gpx is not None:
            body["gpx"] = gpx
        if waypoints is not None:
            body["waypoints"] = waypoints
        return self._request("POST", self._dev(device_id, "/location"), body)

    def location_route(self, device_id: str) -> Dict[str, Any]:
        return self._request("GET", self._dev(device_id, "/location"))

    def stop_location_route(self, device_id: str) -> Dict[str, Any]:
        return self._request("DELETE", self._dev(device_id, "/location"))

    def push_file(self, device_id: str, local: str, remote: str) -> Dict[str, Any]:
        return self._request("POST", self._dev(device_id, "/files/push"), {"local": os.path.abspath(local), "remote": remote})

    def pull_file(self, device_id: str, remote: str, local: str) -> Dict[str, Any]:
        return self._request("POST", self._dev(device_id, "/files/pull"), {"remote": remote, "local": os.path.abspath(local)})

    def push_notification(self, device_id: str, app_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._request("POST", self._dev(device_id, "/push"), {"appId": app_id, "payload": payload})

    def rotate(self, device_id: str, orientation: str) -> Dict[str, Any]:
        return self._request("POST", self._dev(device_id, "/rotate"), {"orientation": orientation})

    # ── multi-agent ───────────────────────────────────────────────────────
    def lease(self, device_id: str, ttl_sec: Optional[int] = None, force: bool = False) -> Dict[str, Any]:
        return self._request("POST", self._dev(device_id, "/lease"), {"owner": self.owner, "ttlSec": ttl_sec, "force": force})

    def release_lease(self, device_id: str) -> Dict[str, Any]:
        return self._request("DELETE", self._dev(device_id, "/lease"))

    def acquire(self, platform: Optional[str] = None, backend: Optional[str] = None, create_if_none: Optional[Dict[str, Any]] = None,
                ttl_sec: Optional[int] = None) -> Dict[str, Any]:
        """Returns {device, lease}."""
        body = {"owner": self.owner, "platform": platform, "backend": backend, "createIfNone": create_if_none, "ttlSec": ttl_sec}
        return self._request("POST", "/v1/pool/acquire", {k: v for k, v in body.items() if v is not None})

    def release(self, device_id: str) -> Dict[str, Any]:
        return self._request("POST", "/v1/pool/release", {"owner": self.owner, "deviceId": device_id})

    # ── proxies ───────────────────────────────────────────────────────────
    def proxies(self) -> List[Dict[str, Any]]:
        """List saved proxies (passwords are never returned)."""
        return self._request("GET", "/v1/proxies")

    def test_proxy_url(self, url: str) -> Dict[str, Any]:
        """Test an unsaved proxy URL on the spot and return exit IP, country, and latency."""
        return self._request("POST", "/v1/proxies/test", {"url": url})

    def add_proxy(self, name: str, url: str, test: bool = False) -> Dict[str, Any]:
        """Save an HTTP or SOCKS5 proxy."""
        body: Dict[str, Any] = {"name": name, "url": url}
        if test:
            body["test"] = True
        return self._request("POST", "/v1/proxies", body)

    def update_proxy(self, proxy_id: str, name: Optional[str] = None, url: Optional[str] = None) -> Dict[str, Any]:
        body = {k: v for k, v in {"name": name, "url": url}.items() if v is not None}
        return self._request("PATCH", f"/v1/proxies/{_q(proxy_id)}", body)

    def delete_proxy(self, proxy_id: str) -> Dict[str, Any]:
        return self._request("DELETE", f"/v1/proxies/{_q(proxy_id)}")

    def test_proxy(self, proxy_id: str) -> Dict[str, Any]:
        return self._request("POST", f"/v1/proxies/{_q(proxy_id)}/test", {})

    def device_proxy(self, device_id: str) -> Dict[str, Any]:
        return self._request("GET", self._dev(device_id, "/proxy"))

    def attach_proxy(self, device_id: str, proxy_id: str, sync_location: bool = False) -> Dict[str, Any]:
        body: Dict[str, Any] = {"proxyId": proxy_id}
        if sync_location:
            body["syncLocation"] = True
        return self._request("PUT", self._dev(device_id, "/proxy"), body)

    def detach_proxy(self, device_id: str) -> Dict[str, Any]:
        return self._request("DELETE", self._dev(device_id, "/proxy"))

    # ── events ────────────────────────────────────────────────────────────
    def events(self) -> Iterator[Dict[str, Any]]:
        """Yield {event, data} from the SSE stream (blocking)."""
        resp = self._request("GET", "/v1/events", raw=True, timeout=3600 * 24)
        ev, data = "message", []
        for raw_line in resp:
            line = raw_line.decode("utf-8", "replace").rstrip("\r\n")
            if not line:
                if data:
                    txt = "\n".join(data)
                    try:
                        payload: Any = json.loads(txt)
                    except ValueError:
                        payload = txt
                    yield {"event": ev, "data": payload}
                ev, data = "message", []
            elif line.startswith(":"):
                continue
            elif line.startswith("event:"):
                ev = line[6:].strip()
            elif line.startswith("data:"):
                data.append(line[5:].lstrip())
