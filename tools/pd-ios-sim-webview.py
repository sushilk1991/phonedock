#!/usr/bin/env python3
"""Read-only Remote Web Inspector client for iOS Simulators (Safari & WKWebView).

Speaks Apple's 4-byte-length-prefixed binary plist RPC over the simulator's
RWI_LISTEN_SOCKET Unix domain socket using Python 3 stdlib only.
Reads a single JSON request on stdin and writes a single JSON response on stdout.
"""
import json
import plistlib
import socket
import struct
import sys
import time
import uuid


def send_rpc(sock: socket.socket, selector: str, args: dict) -> None:
    payload = plistlib.dumps({"__selector": selector, "__argument": args}, fmt=plistlib.FMT_BINARY)
    sock.sendall(struct.pack(">I", len(payload)) + payload)


def recv_rpc(sock: socket.socket) -> dict:
    hdr = b""
    while len(hdr) < 4:
        chunk = sock.recv(4 - len(hdr))
        if not chunk:
            raise EOFError("webinspectord closed connection")
        hdr += chunk
    length = struct.unpack(">I", hdr)[0]
    if length <= 0 or length > 8 * 1024 * 1024:
        raise ValueError(f"invalid webinspectord frame length: {length}")
    buf = b""
    while len(buf) < length:
        chunk = sock.recv(length - len(buf))
        if not chunk:
            raise EOFError("webinspectord truncated frame")
        buf += chunk
    return plistlib.loads(buf)


def collect_pages(sock: socket.socket, conn_id: str, timeout_sec: float = 2.0):
    apps = {}
    listings = {}
    requested = set()

    def ask_listing(app_key: str):
        if app_key in requested:
            return
        requested.add(app_key)
        send_rpc(sock, "_rpc_forwardGetListing:", {
            "WIRConnectionIdentifierKey": conn_id,
            "WIRApplicationIdentifierKey": app_key,
        })

    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        rem = max(0.05, min(0.35, deadline - time.time()))
        sock.settimeout(rem)
        try:
            msg = recv_rpc(sock)
        except socket.timeout:
            if requested and len(listings) >= len(requested):
                break
            if listings and (time.time() + 0.8 >= deadline):
                break
            continue
        sel = msg.get("__selector")
        arg = msg.get("__argument") or {}
        if sel == "_rpc_reportConnectedApplicationList:":
            for k, v in (arg.get("WIRApplicationDictionaryKey") or {}).items():
                apps[k] = v
                ask_listing(k)
        elif sel == "_rpc_applicationConnected:":
            k = arg.get("WIRApplicationIdentifierKey")
            if k:
                apps[k] = arg
                ask_listing(k)
        elif sel == "_rpc_applicationSentListing:":
            k = arg.get("WIRApplicationIdentifierKey")
            if k:
                listings[k] = arg.get("WIRListingKey") or {}
                if requested and len(listings) >= len(requested):
                    break

    pages = []
    for app_key, listing in listings.items():
        app_info = apps.get(app_key) or {}
        bundle_id = str(app_info.get("WIRApplicationBundleIdentifierKey") or "")
        app_name = str(app_info.get("WIRApplicationNameKey") or "")
        for p in listing.values():
            wtype = str(p.get("WIRTypeKey") or "")
            if wtype not in ("WIRTypeWeb", "WIRTypeWebPage"):
                continue
            page_id = p.get("WIRPageIdentifierKey")
            if page_id is None:
                continue
            pages.append({
                "id": f"{app_key}:{page_id}",
                "appKey": app_key,
                "pageId": page_id,
                "appId": bundle_id,
                "appName": app_name,
                "title": str(p.get("WIRTitleKey") or ""),
                "url": str(p.get("WIRURLKey") or ""),
            })
    return pages


def setup_target(sock: socket.socket, conn_id: str, app_key: str, page_id, sender: str):
    send_rpc(sock, "_rpc_forwardSocketSetup:", {
        "WIRConnectionIdentifierKey": conn_id,
        "WIRApplicationIdentifierKey": app_key,
        "WIRPageIdentifierKey": page_id,
        "WIRSenderKey": sender,
        "WIRAutomaticallyPause": False,
    })
    target_id = None
    deadline = time.time() + 1.5
    while time.time() < deadline:
        sock.settimeout(max(0.05, min(0.35, deadline - time.time())))
        try:
            msg = recv_rpc(sock)
        except socket.timeout:
            break
        if msg.get("__selector") != "_rpc_applicationSentData:":
            continue
        raw = (msg.get("__argument") or {}).get("WIRMessageDataKey") or b""
        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception:
            continue
        if data.get("method") == "Target.targetCreated":
            ti = (data.get("params") or {}).get("targetInfo") or {}
            ttype = ti.get("type")
            if ttype in ("page", "web-page", "itml"):
                target_id = ti.get("targetId")
                break
            if not target_id and ti.get("targetId"):
                target_id = ti.get("targetId")
    return target_id


def send_inspector_cmd(sock, conn_id, app_key, page_id, sender, target_id, cmd_id, method, params):
    inner = json.dumps({"id": cmd_id, "method": method, "params": params})
    if target_id:
        outer = json.dumps({
            "id": cmd_id + 10000,
            "method": "Target.sendMessageToTarget",
            "params": {"targetId": target_id, "message": inner},
        }).encode("utf-8")
    else:
        outer = inner.encode("utf-8")
    send_rpc(sock, "_rpc_forwardSocketData:", {
        "WIRConnectionIdentifierKey": conn_id,
        "WIRApplicationIdentifierKey": app_key,
        "WIRPageIdentifierKey": page_id,
        "WIRSenderKey": sender,
        "WIRSocketDataKey": outer,
    })


def unwrap_inspector_msg(raw_bytes: bytes):
    try:
        outer = json.loads(raw_bytes.decode("utf-8"))
    except Exception:
        return None
    if outer.get("method") == "Target.dispatchMessageFromTarget":
        inner_raw = (outer.get("params") or {}).get("message")
        if isinstance(inner_raw, str):
            try:
                return json.loads(inner_raw)
            except Exception:
                return None
    return outer


def eval_js(sock, conn_id, app_key, page_id, sender, target_id, expression: str, timeout_sec: float = 4.0):
    send_inspector_cmd(sock, conn_id, app_key, page_id, sender, target_id, 1, "Runtime.evaluate", {
        "expression": expression,
        "returnByValue": True,
        "objectGroup": "phonedock-ro",
    })
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        sock.settimeout(max(0.05, deadline - time.time()))
        try:
            msg = recv_rpc(sock)
        except socket.timeout:
            break
        if msg.get("__selector") != "_rpc_applicationSentData:":
            continue
        raw = (msg.get("__argument") or {}).get("WIRMessageDataKey") or b""
        payload = unwrap_inspector_msg(raw)
        if not isinstance(payload, dict):
            continue
        if payload.get("id") == 1:
            if payload.get("error"):
                return {"error": str(payload["error"])}
            res = payload.get("result") or {}
            if res.get("wasThrown"):
                return {"error": "evaluation threw an exception"}
            val = (res.get("result") or {}).get("value")
            return {"value": val}
    return {"error": "Web Inspector evaluation timed out"}


def capture_network(sock, conn_id, app_key, page_id, sender, target_id, capture_ms: int):
    send_inspector_cmd(sock, conn_id, app_key, page_id, sender, target_id, 2, "Network.enable", {})
    requests = {}
    truncated = False
    deadline = time.time() + max(0.05, min(5.0, capture_ms / 1000.0))
    while time.time() < deadline:
        sock.settimeout(max(0.05, deadline - time.time()))
        try:
            msg = recv_rpc(sock)
        except socket.timeout:
            break
        if msg.get("__selector") != "_rpc_applicationSentData:":
            continue
        raw = (msg.get("__argument") or {}).get("WIRMessageDataKey") or b""
        payload = unwrap_inspector_msg(raw)
        if not isinstance(payload, dict):
            continue
        method = payload.get("method")
        params = payload.get("params") or {}
        req_id = params.get("requestId")
        if not isinstance(req_id, str) or len(req_id) > 200:
            continue
        if method == "Network.requestWillBeSent":
            if len(requests) >= 500 and req_id not in requests:
                truncated = True
                continue
            req = params.get("request") or {}
            ts = params.get("timestamp")
            requests[req_id] = {
                "method": str(req.get("method") or "?")[:16],
                "url": str(req.get("url") or ""),
                "start": ts if isinstance(ts, (int, float)) else None,
            }
        elif req_id in requests:
            entry = requests[req_id]
            if method == "Network.responseReceived":
                status = (params.get("response") or {}).get("status")
                if isinstance(status, (int, float)):
                    entry["status"] = int(status)
            elif method in ("Network.loadingFinished", "Network.loadingFailed"):
                ts = params.get("timestamp")
                if isinstance(entry.get("start"), (int, float)) and isinstance(ts, (int, float)):
                    entry["durationMs"] = max(0, int(round((ts - entry["start"]) * 1000)))
                if method == "Network.loadingFailed":
                    entry["failed"] = True
    out = []
    for r in requests.values():
        item = {"method": r["method"], "url": r["url"]}
        if "status" in r:
            item["status"] = r["status"]
        if "durationMs" in r:
            item["durationMs"] = r["durationMs"]
        if r.get("failed"):
            item["failed"] = True
        out.append(item)
    return {"requests": out, "truncated": truncated}


def main():
    try:
        req = json.loads(sys.stdin.read())
    except Exception as e:
        sys.stdout.write(json.dumps({"ok": False, "code": "bad_request", "error": f"invalid request: {e}"}))
        return

    sock_path = req.get("socketPath")
    action = req.get("action") or "snapshot"
    want_app = req.get("appId")
    want_target = req.get("targetId")
    expression = req.get("expression")
    capture_ms = int(req.get("captureMs") or 2000)

    if not sock_path:
        sys.stdout.write(json.dumps({"ok": False, "code": "not_supported", "error": "missing socketPath"}))
        return

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(3.0)
    try:
        sock.connect(sock_path)
    except Exception as e:
        sys.stdout.write(json.dumps({"ok": False, "code": "webview_debug_failed", "error": f"connect failed: {e}"}))
        return

    conn_id = str(uuid.uuid4()).upper()
    try:
        send_rpc(sock, "_rpc_reportIdentifier:", {"WIRConnectionIdentifierKey": conn_id})
        pages = collect_pages(sock, conn_id)
        if want_app:
            pages = [p for p in pages if p["appId"].lower() == want_app.lower()]

        if not pages:
            sys.stdout.write(json.dumps({
                "ok": False,
                "code": "not_supported",
                "error": "No inspectable Safari tab or WKWebView found on this simulator",
            }))
            return

        selected = None
        if want_target:
            for p in pages:
                if p["id"] == want_target or str(p["pageId"]) == want_target:
                    selected = p
                    break
        elif len(pages) == 1:
            selected = pages[0]
        else:
            # If no appId filter was passed and exactly one Safari tab exists, prefer Safari.
            safari = [p for p in pages if p["appId"].lower() == "com.apple.mobilesafari"]
            if not want_app and len(safari) == 1:
                selected = safari[0]

        if not selected:
            sys.stdout.write(json.dumps({
                "ok": False,
                "code": "ambiguous_target",
                "error": "Choose one inspectable Safari tab or WebView target",
                "availableTargets": [
                    {"id": p["id"], "appId": p["appId"], "title": p["title"][:200], "url": p["url"]}
                    for p in pages[:20]
                ],
            }))
            return

        sender = str(uuid.uuid4()).upper()
        target_id = setup_target(sock, conn_id, selected["appKey"], selected["pageId"], sender)
        target_out = {
            "id": selected["id"],
            "appId": selected["appId"],
            "title": selected["title"][:200],
            "url": selected["url"],
        }

        if action == "network":
            net = capture_network(sock, conn_id, selected["appKey"], selected["pageId"], sender, target_id, capture_ms)
            sys.stdout.write(json.dumps({"ok": True, "target": target_out, **net}))
        else:
            ev = eval_js(sock, conn_id, selected["appKey"], selected["pageId"], sender, target_id, str(expression or "null"))
            if "error" in ev:
                sys.stdout.write(json.dumps({"ok": False, "code": "webview_debug_failed", "error": ev["error"]}))
            else:
                sys.stdout.write(json.dumps({"ok": True, "target": target_out, "value": ev.get("value")}))
    except Exception as e:
        sys.stdout.write(json.dumps({"ok": False, "code": "webview_debug_failed", "error": str(e)}))
    finally:
        try:
            sock.close()
        except Exception:
            pass


if __name__ == "__main__":
    main()
