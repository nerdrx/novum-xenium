"""Bounded image-only protocol and cache confinement; no cloud calls."""
import importlib.util
import io
import json
from pathlib import Path
import struct
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request
import uuid
from http.server import ThreadingHTTPServer

spec = importlib.util.spec_from_file_location("bridge", Path(__file__).resolve().parents[1] / "scripts/codex_image_bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class BridgeTests(unittest.TestCase):
    def test_rejects_non_image_and_unbounded_requests(self):
        for request in [{}, {"prompt": "x", "model": "chat-model"}, {"prompt": "x", "n": 2},
                        {"prompt": "x", "size": "../../etc/passwd"}, {"prompt": "x" * 32001},
                        {"prompt": "x", "size": []}, {"prompt": "x", "quality": {}}]:
            with self.assertRaises(ValueError):
                bridge.validate_request(request)
        self.assertEqual(bridge.validate_request({"prompt": " chicken "}), ("chicken", "1024x1024", "medium"))

    def test_thread_detection_ignores_truncated_image_output(self):
        event = {"type": "thread.started", "thread_id": str(uuid.uuid4())}
        stream = io.BytesIO(json.dumps(event).encode() + b'\n{"incomplete":"' + b'x' * 100000)
        self.assertEqual(bridge.started_thread_event(stream), event)
        self.assertLess(stream.tell(), 1000)

    def test_reads_only_png_for_the_returned_thread(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            thread = str(uuid.uuid4())
            directory = root / thread
            directory.mkdir()
            png = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\x0dIHDR" + struct.pack(">II", 32, 64)
            (directory / "image.png").write_bytes(png)
            events = [{"type": "thread.started", "thread_id": thread}]
            self.assertEqual(bridge.image_for_thread(events, root), (png, 32, 64))
            with self.assertRaisesRegex(bridge.NoImageGenerated, "No new file was saved"):
                bridge.image_for_thread([{"type": "thread.started", "thread_id": str(uuid.uuid4())}], root)
            with self.assertRaises(ValueError):
                bridge.image_for_thread([{"type": "thread.started", "thread_id": "../../etc"}], root)
            (directory / "image.png").unlink()
            (directory / "image.png").symlink_to(root / "outside.png")
            (root / "outside.png").write_bytes(png)
            with self.assertRaises(ValueError):
                bridge.image_for_thread(events, root)

    def test_http_requires_token_and_refuses_chat_routes(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), bridge.Handler)
        server.token = "test-token" * 4
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            base = f"http://127.0.0.1:{server.server_port}"
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(base + "/v1/models")
            self.assertEqual(error.exception.code, 401)
            error.exception.close()
            request = urllib.request.Request(base + "/v1/models", headers={"Authorization": "Bearer " + server.token})
            with urllib.request.urlopen(request) as response:
                self.assertEqual(json.load(response)["data"][0]["id"], bridge.MODEL)
            request = urllib.request.Request(base + "/v1/chat/completions", data=b"{}", headers={"Authorization": "Bearer " + server.token})
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(request)
            self.assertEqual(error.exception.code, 404)
            error.exception.close()
            request = urllib.request.Request(base + "/v1/images/generations", data=b'{"prompt":"A chicken"}',
                headers={"Authorization": "Bearer " + server.token, "Content-Type": "application/json"})
            with patch.object(bridge, "generate", side_effect=bridge.NoImageGenerated("No new file was saved")):
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(request)
                self.assertEqual(error.exception.code, 422)
                self.assertEqual(json.load(error.exception)["error"]["message"], "No new file was saved")
                error.exception.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
