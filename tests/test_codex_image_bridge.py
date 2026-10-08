"""Bounded image-only protocol and cache confinement; no cloud calls."""
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import socket
import struct
import sys
import tempfile
import threading
import time
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
    def _load_bridge_with_environment(self):
        spec = importlib.util.spec_from_file_location(
            "bridge_environment_fixture",
            Path(__file__).resolve().parents[1] / "scripts/codex_image_bridge.py",
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_custom_codex_home_selects_native_image_cache(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {
            "CODEX_HOME": root,
        }, clear=False):
            os.environ.pop("CODEX_IMAGE_ROOT", None)
            configured = self._load_bridge_with_environment()
            expected_root = Path(root) / "generated_images"
            self.assertEqual(configured.IMAGE_ROOT, expected_root)

            thread = str(uuid.uuid4())
            directory = expected_root / thread
            directory.mkdir(parents=True)
            png = (b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\x0dIHDR"
                   + struct.pack(">II", 32, 64))
            (directory / "image.png").write_bytes(png)
            events = [{"type": "thread.started", "thread_id": thread}]
            self.assertEqual(configured.image_for_thread(events), (png, 32, 64))

    def test_explicit_image_root_overrides_codex_home(self):
        with tempfile.TemporaryDirectory() as root:
            codex_home = Path(root) / "codex-home"
            image_root = Path(root) / "custom-cache"
            with patch.dict(os.environ, {
                "CODEX_HOME": str(codex_home),
                "CODEX_IMAGE_ROOT": str(image_root),
            }, clear=False):
                configured = self._load_bridge_with_environment()
            self.assertEqual(configured.IMAGE_ROOT, image_root)

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

    def test_disconnect_stops_owned_cli_releases_lock_and_normal_request_still_works(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            marker = root / "pid"
            child_marker = root / "child-pid"
            image_root = root / "images"
            cli = root / "fake-codex"
            cli.write_text(f'''#!{sys.executable}
import json, os, pathlib, signal, struct, subprocess, sys, time, uuid
mode = os.environ["FAKE_CLI_MODE"]
if mode == "wait":
    child_code = ('import os,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); '
                  'open(os.environ["FAKE_CLI_CHILD_PID"],"w").write(str(os.getpid())); '
                  'time.sleep(30)')
    child = subprocess.Popen([sys.executable, "-c", child_code])
    while not pathlib.Path(os.environ["FAKE_CLI_CHILD_PID"]).exists(): time.sleep(0.01)
pathlib.Path(os.environ["FAKE_CLI_PID"]).write_text(str(os.getpid()))
if mode == "wait":
    child.wait()
time.sleep(0.05)
thread_id = str(uuid.uuid4())
directory = pathlib.Path(os.environ["FAKE_CLI_IMAGE_ROOT"]) / thread_id
directory.mkdir(parents=True)
png = b"\\x89PNG\\r\\n\\x1a\\n" + b"\\x00\\x00\\x00\\x0dIHDR" + struct.pack(">II", 40, 50)
(directory / "fixture.png").write_bytes(png)
print(json.dumps({{"type": "thread.started", "thread_id": thread_id}}), flush=True)
''')
            cli.chmod(0o700)
            server = ThreadingHTTPServer(("127.0.0.1", 0), bridge.Handler)
            server.token = "test-token" * 4
            real_popen = bridge.subprocess.Popen
            processes = []

            def tracked_popen(*args, **kwargs):
                process = real_popen(*args, **kwargs)
                processes.append(process)
                return process

            serve = threading.Thread(target=server.serve_forever, daemon=True)
            serve.start()
            try:
                with patch.object(bridge, "CODEX", str(cli)), \
                        patch.object(bridge, "JOB_ROOT", root / "jobs"), \
                        patch.object(bridge, "IMAGE_ROOT", image_root), \
                        patch.object(bridge, "PROCESS_TERM_GRACE", 0.1), \
                        patch.object(bridge.subprocess, "Popen", tracked_popen), \
                        patch.dict(os.environ, {
                            "FAKE_CLI_PID": str(marker),
                            "FAKE_CLI_CHILD_PID": str(child_marker),
                            "FAKE_CLI_IMAGE_ROOT": str(image_root),
                            "FAKE_CLI_MODE": "wait",
                        }):
                    body = json.dumps({"prompt": "x" * 32_000}).encode()
                    sock = socket.create_connection(("127.0.0.1", server.server_port))
                    sock.sendall(
                        b"POST /v1/images/generations HTTP/1.1\r\n"
                        + f"Host: 127.0.0.1:{server.server_port}\r\n".encode()
                        + f"Authorization: Bearer {server.token}\r\n".encode()
                        + b"Content-Type: application/json\r\n"
                        + f"Content-Length: {len(body)}\r\n\r\n".encode()
                        + body
                    )
                    for _ in range(200):
                        if marker.exists():
                            break
                        time.sleep(0.01)
                    self.assertTrue(marker.exists(), "fake CLI should start")
                    sock.close()
                    for _ in range(300):
                        if processes and processes[0].poll() is not None:
                            break
                        time.sleep(0.01)
                    self.assertEqual(len(processes), 1)
                    self.assertIsNotNone(processes[0].poll(), "disconnected CLI must be reaped")
                    self.assertEqual(processes[0].returncode, -signal.SIGTERM)
                    child_pid = int(child_marker.read_text())
                    for _ in range(200):
                        try:
                            state = Path(f"/proc/{child_pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
                        except FileNotFoundError:
                            break
                        if state == "Z":
                            break
                        time.sleep(0.01)
                    else:
                        self.fail("TERM-ignoring CLI descendant must be killed with the process group")

                    os.environ["FAKE_CLI_MODE"] = "success"
                    request = urllib.request.Request(
                        f"http://127.0.0.1:{server.server_port}/v1/images/generations",
                        data=body,
                        headers={"Authorization": "Bearer " + server.token,
                                 "Content-Type": "application/json"},
                    )
                    with urllib.request.urlopen(request, timeout=3) as response:
                        payload = json.load(response)
                    self.assertEqual(payload["size"], "40x50")
                    self.assertEqual(len(processes), 2)
                    self.assertEqual(processes[1].returncode, 0)
            finally:
                server.shutdown()
                server.server_close()
                serve.join()

    def test_disconnect_peek_does_not_consume_queued_bytes(self):
        left, right = socket.socketpair()
        try:
            right.sendall(b"pipelined request")
            right.close()
            self.assertFalse(bridge._client_disconnected(left))
            self.assertEqual(left.recv(17), b"pipelined request")
            self.assertTrue(bridge._client_disconnected(left))
        finally:
            left.close()


if __name__ == "__main__":
    unittest.main()
