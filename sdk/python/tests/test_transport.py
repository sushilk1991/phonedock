"""Transport regressions use disposable localhost HTTP servers, never a daemon or device."""
import errno
import io
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from phonedock import PhoneDock, PhoneDockApiError


@contextmanager
def serve(reply):
    class Handler(BaseHTTPRequestHandler):
        def handle_request(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            reply(self, body)

        do_POST = handle_request
        do_PUT = handle_request
        do_GET = handle_request

        def log_message(self, *_args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def json_reply(handler, data, status=200):
    payload = json.dumps(data).encode()
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(payload)))
    handler.end_headers()
    handler.wfile.write(payload)


class TransportTests(unittest.TestCase):
    def test_clipboard_put_loss_is_unknown_and_never_retried(self):
        seen = []
        def drop(handler, _body):
            seen.append(handler.headers.get("X-PhoneDock-Request-ID"))
            handler.close_connection = True
        with serve(drop) as url:
            c = self.client(url, auto_start=True)
            with patch.object(c, "ensure_daemon") as start:
                with self.assertRaises(PhoneDockApiError) as caught:
                    c.set_clipboard("pdtest-clipboard", "private text")
                self.assertEqual(caught.exception.delivery, "unknown")
                self.assertIsNotNone(caught.exception.request_id)
                self.assertEqual(len(seen), 1)
                start.assert_not_called()

    def test_canonical_device_resolution_does_not_use_partial_inventory(self):
        c = PhoneDock(auto_start=False)
        device = {"id": "ios-simulator:pdtest-cold", "nativeId": "pdtest-cold", "name": "test-phone"}
        with patch.object(c, "device", return_value=device) as targeted, patch.object(c, "devices") as aggregate:
            self.assertEqual(c.resolve_device(device["id"]), device)
            targeted.assert_called_once_with(device["id"])
            aggregate.assert_not_called()
        with patch.object(c, "devices", side_effect=[[], [device]]), patch.object(c, "inventory_status", side_effect=[{"ios": {"refreshing": True}}, {"ios": {"refreshing": False, "at": 1}}]), patch("time.sleep"):
            self.assertEqual(c.resolve_device("test-phone"), device)
        with patch.object(c, "devices", side_effect=[[], [device]]), patch.object(c, "inventory_status", return_value={"ios": {"refreshing": False, "at": 1}}):
            self.assertEqual(c.resolve_device("test-phone"), device)

    def setUp(self):
        self.home = tempfile.TemporaryDirectory(prefix="pdtest-sdk-home-")
        self.addCleanup(self.home.cleanup)

    def client(self, url, **options):
        return PhoneDock(base_url=url, token="test-token", home=self.home.name, **options)

    def test_consumed_input_then_disconnect_is_unknown_and_never_retried(self):
        seen = []

        def drop(handler, _body):
            seen.append(handler.headers.get("X-PhoneDock-Request-ID"))
            handler.close_connection = True

        with serve(drop) as url:
            c = self.client(url, auto_start=True)
            with patch.object(c, "ensure_daemon") as start:
                with self.assertRaises(PhoneDockApiError) as caught:
                    c.tap("pdtest-mock", 1, 2)
                self.assertEqual(caught.exception.delivery, "unknown")
                self.assertFalse(caught.exception.retry_safe)
                self.assertEqual(caught.exception.request_id, seen[0])
                self.assertRegex(seen[0], r"^[A-Za-z0-9._-]{1,128}$")
                self.assertEqual(len(seen), 1)
                start.assert_not_called()

    def test_partial_response_and_malformed_json_are_unknown(self):
        for partial in (True, False):
            with self.subTest(partial=partial):
                seen = []

                def reply(handler, _body):
                    seen.append(1)
                    handler.send_response(200)
                    handler.send_header("Content-Type", "application/json")
                    if partial:
                        handler.send_header("Content-Length", "100")
                    handler.end_headers()
                    handler.wfile.write(b'{"ok":' if partial else b'not json')
                    handler.close_connection = True

                with serve(reply) as url:
                    c = self.client(url, auto_start=True)
                    with patch.object(c, "ensure_daemon") as start:
                        with self.assertRaises(PhoneDockApiError) as caught:
                            c.tap("pdtest-mock", 1, 2)
                        self.assertEqual(caught.exception.delivery, "unknown")
                        self.assertIsNotNone(caught.exception.request_id)
                        self.assertEqual(len(seen), 1)
                        start.assert_not_called()

    def test_http_error_preserves_delivery_or_defaults_to_unknown(self):
        for delivery in ("sent", "not_sent", None):
            with self.subTest(delivery=delivery):
                def reply(handler, _body):
                    error = {"code": "rejected", "message": "Rejected", "hints": ["Look"], "detail": "Reason"}
                    if delivery is not None:
                        error["delivery"] = delivery
                    json_reply(handler, {"error": error}, 409)

                with serve(reply) as url:
                    with self.assertRaises(PhoneDockApiError) as caught:
                        self.client(url, auto_start=False).tap("pdtest-mock", 1, 2)
                    e = caught.exception
                    self.assertEqual(e.delivery, delivery or "unknown")
                    self.assertEqual(e.status, 409)
                    self.assertEqual(e.hints, ["Look"])
                    self.assertEqual(e.detail, "Reason")
                    self.assertIsNotNone(e.request_id)

    def test_urlerror_reset_is_unknown_and_not_retried(self):
        c = self.client("http://127.0.0.1:1", auto_start=True)
        with patch("urllib.request.urlopen", side_effect=urllib.error.URLError(ConnectionResetError(errno.ECONNRESET, "reset"))) as send:
            with patch.object(c, "ensure_daemon") as start:
                with self.assertRaises(PhoneDockApiError) as caught:
                    c.tap("pdtest-mock", 1, 2)
                self.assertEqual(caught.exception.delivery, "unknown")
                self.assertEqual(send.call_count, 1)
                start.assert_not_called()

    def test_timeout_after_input_and_interrupted_http_error_are_unknown(self):
        for timeout in (True, False):
            with self.subTest(timeout=timeout):
                seen = []

                def reply(handler, _body):
                    seen.append(1)
                    if timeout:
                        threading.Event().wait(0.1)
                    else:
                        handler.send_response(409)
                        handler.send_header("Content-Type", "application/json")
                        handler.send_header("Content-Length", "200")
                        handler.end_headers()
                        handler.wfile.write(b'{"error":')
                    handler.close_connection = True

                with serve(reply) as url:
                    c = self.client(url, auto_start=True, timeout=0.02 if timeout else 1)
                    with patch.object(c, "ensure_daemon") as start:
                        with self.assertRaises(PhoneDockApiError) as caught:
                            c.tap("pdtest-mock", 1, 2)
                        self.assertEqual(caught.exception.delivery, "unknown")
                        self.assertIsNotNone(caught.exception.request_id)
                        start.assert_not_called()
                self.assertEqual(len(seen), 1)

    def test_refused_before_connection_is_not_sent(self):
        c = self.client("http://127.0.0.1:1", auto_start=False)
        with patch("urllib.request.urlopen", side_effect=urllib.error.URLError(ConnectionRefusedError(errno.ECONNREFUSED, "refused"))):
            with self.assertRaises(PhoneDockApiError) as caught:
                c.tap("pdtest-mock", 1, 2)
            self.assertEqual(caught.exception.delivery, "not_sent")
            self.assertTrue(caught.exception.retry_safe)

    def test_safe_connection_retry_retains_request_id(self):
        response = io.BytesIO(b'{"ok":true}')
        response.headers = {"Content-Type": "application/json"}
        c = self.client("http://127.0.0.1:1", auto_start=True)
        error = urllib.error.URLError(ConnectionRefusedError(errno.ECONNREFUSED, "refused"))
        # Exercise the retry branch even when the parent test run disables real daemon startup.
        # ensure_daemon below is mocked, so this cannot launch a process.
        c.auto_start = True
        with patch("urllib.request.urlopen", side_effect=[error, response]) as send:
            with patch.object(c, "ensure_daemon") as start:
                self.assertTrue(c.tap("pdtest-mock", 1, 2)["ok"])
                start.assert_called_once()
                ids = [call.args[0].get_header("X-phonedock-request-id") for call in send.call_args_list]
                self.assertTrue(ids[0])
                self.assertEqual(ids[0], ids[1])

    def test_auth_refresh_retains_request_id(self):
        ids = []
        with tempfile.TemporaryDirectory(prefix="pdtest-sdk-token-") as home:
            port = os.environ.get("PHONEDOCK_PORT", "47420")
            filename = "daemon.json" if port == "47420" else f"daemon-{port}.json"
            info = Path(home, filename)
            info.write_text(json.dumps({"port": 1, "token": "old"}))

            def reply(handler, _body):
                ids.append(handler.headers.get("X-PhoneDock-Request-ID"))
                if len(ids) == 1:
                    info.write_text(json.dumps({"port": 1, "token": "new"}))
                    json_reply(handler, {"error": {"code": "unauthorized"}}, 401)
                else:
                    self.assertEqual(handler.headers.get("Authorization"), "Bearer new")
                    json_reply(handler, {"ok": True})

            with serve(reply) as url:
                c = PhoneDock(base_url=url, home=home, auto_start=False)
                self.assertTrue(c.tap("pdtest-mock", 1, 2)["ok"])
            self.assertEqual(len(ids), 2)
            self.assertTrue(ids[0])
            self.assertEqual(ids[0], ids[1])

    def test_remote_url_never_starts_a_local_daemon(self):
        for url in ("http://example.invalid:1234", "http://localhost.attacker.invalid:1234"):
            with self.subTest(url=url):
                c = self.client(url)
                with patch.object(c, "is_running", return_value=False):
                    with patch("subprocess.Popen") as spawn:
                        with self.assertRaises(PhoneDockApiError):
                            c.ensure_daemon(timeout=0)
                        self.assertEqual(spawn.call_count, 0)

    def test_explicit_request_id_and_read_only_recovery_lookup(self):
        seen = []

        def reply(handler, _body):
            seen.append((handler.command, handler.path, handler.headers.get("X-PhoneDock-Request-ID")))
            json_reply(handler, {"ok": True})

        with serve(reply) as url:
            c = self.client(url, auto_start=False)
            c._request("POST", "/v1/devices/pdtest-mock/input", {}, request_id="pdtest-recover")
            c.request_result("android-emulator:pdtest-mock", "pdtest-recover")
            with self.assertRaises(PhoneDockApiError) as caught:
                c._request("POST", "/unused", {}, request_id="bad\nheader")
            self.assertEqual(caught.exception.delivery, "not_sent")
        self.assertEqual(seen[0][2], "pdtest-recover")
        self.assertEqual(seen[1][0], "GET")
        self.assertTrue(seen[1][1].endswith("android-emulator%3Apdtest-mock/requests/pdtest-recover"))
        self.assertEqual(len(seen), 2)

    def test_launch_sends_args_env_and_return_ui(self):
        captured = []

        def reply(handler, body):
            captured.append((handler.command, handler.path, json.loads(body.decode())))
            json_reply(handler, {"ok": True, "delivery": "sent", "retrySafe": False})

        with serve(reply) as url:
            c = self.client(url, auto_start=False)
            c.launch("ios-simulator:pdtest-1", "com.example.app", args=["-UITesting"], env={"API_KEY": "secret"}, return_ui=True, settle_ms=700)
            c.launch("android-emulator:pdtest-2", "com.example.app", args={"debug": True, "count": 2}, verify=False)
            c.tap("android-emulator:pdtest-2", 10, 20, return_ui=True, settle_ms=300)
            c.go_back("android-emulator:pdtest-2", return_ui=True, settle_ms=0)
        self.assertEqual(captured[0][0], "POST")
        self.assertTrue(captured[0][1].endswith("/apps/com.example.app/launch"))
        self.assertEqual(captured[0][2], {"args": ["-UITesting"], "env": {"API_KEY": "secret"}, "returnUi": True, "settleMs": 700})
        self.assertEqual(captured[1][2], {"args": {"debug": True, "count": 2}, "verify": False})
        self.assertEqual(captured[2][2], {"action": "tap", "x": 10, "y": 20, "returnUi": True, "settleMs": 300})
        self.assertEqual(captured[3][2], {"returnUi": True, "settleMs": 0})

    def test_positional_request_id_compatibility_for_input_fill_launch(self):
        captured = []

        def reply(handler, body):
            captured.append((handler.path, handler.headers.get("X-PhoneDock-Request-ID"), json.loads(body.decode())))
            json_reply(handler, {"ok": True, "delivery": "sent", "retrySafe": False})

        with serve(reply) as url:
            c = self.client(url, auto_start=False)
            # Legacy positional calls: request_id stays at its original position before the new settle_ms parameter
            c.input("android-emulator:pdtest-1", {"action": "tap", "x": 1, "y": 2}, None, "snap-1", True, "req-input-1")
            c.fill(
                "android-emulator:pdtest-1", "hello", "Email", None, None, None, None, None, None, None,
                True, False, False, None, "snap-2", True, "req-fill-1",
            )
            c.launch("ios-simulator:pdtest-1", "com.example.app", None, ["-A"], {"K": "V"}, True, True, "req-launch-1")

        self.assertEqual(captured[0][1], "req-input-1")
        self.assertNotIn("settleMs", captured[0][2])
        self.assertEqual(captured[0][2], {"action": "tap", "x": 1, "y": 2, "snapshotId": "snap-1", "returnUi": True})

        self.assertEqual(captured[1][1], "req-fill-1")
        self.assertNotIn("settleMs", captured[1][2])
        self.assertEqual(captured[1][2]["snapshotId"], "snap-2")
        self.assertEqual(captured[1][2]["returnUi"], True)

        self.assertEqual(captured[2][1], "req-launch-1")
        self.assertNotIn("settleMs", captured[2][2])
        self.assertEqual(captured[2][2], {"args": ["-A"], "env": {"K": "V"}, "verify": True, "returnUi": True})


if __name__ == "__main__":
    unittest.main()
