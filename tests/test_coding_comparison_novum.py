import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from urllib.parse import parse_qs

SCRIPT = Path(__file__).parents[1] / "scripts" / "coding_comparison_novum.py"


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    calls = []
    mode = "complete"

    def log_message(self, *_args):
        pass

    def do_POST(self):
        assert self.headers.get("Cookie") == "odysseus_session=private-test-token"
        body = self.rfile.read(int(self.headers.get("Content-Length", "0"))).decode()
        fields = parse_qs(body)
        self.calls.append((self.path, fields, dict(self.headers)))
        if self.path == "/api/session":
            payload = json.dumps({"id": "session-test"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if self.path == "/api/chat_stream":
            chat_call = sum(path == "/api/chat_stream" for path, *_ in self.calls)
            if self.mode == "timeout":
                self.send_response(200)
                self.send_header("X-Odysseus-Run-Id", "run-test")
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", "100")
                self.end_headers()
                self.wfile.flush()
                time.sleep(0.7)
                return
            events = {
                "approval": [
                    {"type": "tool_output", "ask_user": {"kind": "tool_approval", "approval_id": "approval-x"}},
                ],
                "approval_then_verified": ([
                    {"type": "tool_output", "ask_user": {"kind": "tool_approval", "approval_id": "approval-x",
                     "session_id": "session-test", "workspace": "/mapped/workspace"}},
                ] if chat_call == 1 else [
                    {"type": "agent_terminal", "status": "completed"},
                ]),
                "approval_wrong_session": [
                    {"type": "ask_user", "data": {"kind": "tool_approval", "approval_id": "approval-x",
                     "session_id": "different-session"}},
                ],
                "approval_malformed": [
                    {"type": "ask_user", "data": {"kind": "tool_approval", "approval_id": "bad\nid"}},
                ],
                "approval_valid_then_invalid": [
                    {"type": "ask_user", "data": {"kind": "tool_approval", "approval_id": "approval-x"}},
                    {"type": "tool_output", "ask_user": {"kind": "tool_approval", "approval_id": "bad\nid"}},
                ],
                "error_done": [
                    {"error": "Provider request failed: PRIVATE BODY", "status": 502},
                ],
                "unverified_done": [
                    {"type": "agent_terminal", "status": "failed", "reason": "completion_unverified",
                     "message": "PRIVATE TERMINAL BODY"},
                ],
                "verified": [
                    {"type": "model_actual", "model": "served-model", "requested_model": "qwen3.5:9b",
                     "endpoint_id": "ep-actual", "round": 1},
                    {"type": "coding_work_packet", "round": 1, "stage": "done", "test_status": "passed",
                     "review_status": "passed", "packet": {"private": "DO NOT EMIT"}},
                    {"type": "verification", "passed": True, "status": "passed"},
                    {"type": "agent_terminal", "status": "completed"},
                    {"type": "metrics", "data": {"model": "served-model", "endpoint_id": "ep-actual",
                     "input_tokens": 120, "output_tokens": 44, "total_tokens": 164}},
                ],
            }
            payload = b"".join(
                (b"data: " + json.dumps(event).encode() + b"\n\n")
                for event in events.get(self.mode, [])
            ) + b"data: [DONE]\n\n"
            self.send_response(200)
            self.send_header("X-Odysseus-Run-Id", "run-test")
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if self.path == "/api/chat/stop/session-test":
            self.calls[-1] = (self.calls[-1][0], self.calls[-1][1], {**self.calls[-1][2], "stop_run_id": self.headers.get("X-Odysseus-Run-Id")})
            self.send_response(200)
            self.end_headers()
            return
        self.send_response(404)
        self.end_headers()


class NovumAdapterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        Handler.calls = []
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def invoke(self, directory, *, mode="complete", timeout="5", preset_id=None,
               approve_task=False, files_json=None):
        Handler.mode = mode
        Handler.calls = []
        env = {**os.environ, "ODYSSEUS_SESSION": "private-test-token"}
        command = [
            sys.executable, str(SCRIPT), "--task-file", str(Path(directory) / "TASK.md"),
            "--host-workspace", directory, "--container-workspace", "/mapped/workspace",
            "--api-base", self.base, "--endpoint-id", "ep-test", "--model", "qwen3.5:9b",
            f"--timeout={timeout}",
        ]
        if preset_id is not None:
            command.extend(("--preset-id", preset_id))
        if files_json is not None:
            command.extend(("--files-json", files_json))
        if approve_task:
            command.append("--approve-task")
        return subprocess.run(command, cwd=directory, env=env, text=True, capture_output=True, timeout=10)

    def test_stream_uses_explicit_mapping_and_reports_run_identity_without_output(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "TASK.md").write_text("Fix the arithmetic defect.\n")
            Path(directory, "calc.py").write_text("def add(a,b): return a-b\n")
            result = self.invoke(directory, mode="verified")
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual((report["session_id"], report["run_id"], report["model"]), ("session-test", "run-test", "qwen3.5:9b"))
        self.assertNotIn("private-test-token", result.stdout)
        session_path, session, _ = Handler.calls[0]
        chat_path, chat, _ = Handler.calls[1]
        self.assertEqual(session_path, "/api/session")
        self.assertEqual(session["endpoint_id"], ["ep-test"])
        self.assertEqual(session["model"], ["qwen3.5:9b"])
        self.assertEqual(chat_path, "/api/chat_stream")
        self.assertEqual(chat["selected_endpoint_id"], ["ep-test"])
        self.assertEqual(chat["workspace"], ["/mapped/workspace"])
        self.assertEqual(chat["mode"], ["agent"])
        self.assertEqual(report["status"], "complete")
        self.assertEqual(report["actual_route"]["model"], "served-model")
        self.assertEqual(report["actual_route"]["endpoint_id"], "ep-actual")
        self.assertEqual(report["verification_passed"], True)
        self.assertIn("coding_work_packet", [event["type"] for event in report["evidence"]])
        self.assertNotIn("DO NOT EMIT", result.stdout)

    def test_done_without_outcome_evidence_is_unverified(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "TASK.md").write_text("Fix defect.\n")
            Path(directory, "calc.py").write_text("broken\n")
            result = self.invoke(directory)
        self.assertEqual(result.returncode, 2)
        report = json.loads(result.stdout)
        self.assertEqual(report["status"], "incomplete")
        self.assertTrue(report["stream_ended"])
        self.assertIsNone(report["verification_passed"])

    def test_provider_error_then_done_stays_failed_and_redacted(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "TASK.md").write_text("Fix defect.\n")
            Path(directory, "calc.py").write_text("broken\n")
            result = self.invoke(directory, mode="error_done")
        self.assertEqual(result.returncode, 1)
        report = json.loads(result.stdout)
        self.assertEqual(report["status"], "failed")
        self.assertTrue(report["stream_ended"])
        self.assertEqual(report["evidence"], [{"type": "error", "status": 502}])
        self.assertNotIn("PRIVATE BODY", result.stdout)

    def test_unverified_terminal_then_done_is_not_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "TASK.md").write_text("Fix defect.\n")
            Path(directory, "calc.py").write_text("broken\n")
            result = self.invoke(directory, mode="unverified_done")
        self.assertEqual(result.returncode, 2)
        report = json.loads(result.stdout)
        self.assertEqual(report["status"], "unverified")
        self.assertEqual(report["terminal"]["reason"], "completion_unverified")
        self.assertNotIn("PRIVATE TERMINAL BODY", result.stdout)

    def test_preset_id_is_sent_and_reported_as_generation_settings_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "TASK.md").write_text("Fix the arithmetic defect.\n")
            Path(directory, "calc.py").write_text("def add(a,b): return a-b\n")
            result = self.invoke(directory, mode="verified", preset_id="code_analyze")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(Handler.calls[1][1]["preset_id"], ["code_analyze"])
        self.assertEqual(json.loads(result.stdout)["preset_id"], "code_analyze")

    def test_multifile_selection_accepts_named_files_without_calc_py(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "TASK.md").write_text("Fix core.py and report.py.\n")
            Path(directory, "core.py").write_text("def total(values): return len(values)\n")
            Path(directory, "report.py").write_text("from core import total\n")
            result = self.invoke(directory, mode="verified", files_json='["core.py", "report.py"]')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["source_files"], ["core.py", "report.py"])
        self.assertEqual(Handler.calls[1][1]["workspace"], ["/mapped/workspace"])

    def test_invalid_source_file_selection_fails_before_network(self):
        cases = ('[]', '["../outside.py"]', '["missing.py"]', '["calc.py", "calc.py"]')
        for files_json in cases:
            with self.subTest(files_json=files_json), tempfile.TemporaryDirectory() as directory:
                Handler.calls = []
                Path(directory, "TASK.md").write_text("Fix calc.py.\n")
                Path(directory, "calc.py").write_text("broken\n")
                result = self.invoke(directory, files_json=files_json)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(Handler.calls, [])

    def test_approval_is_reported_without_opt_in(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "TASK.md").write_text("Fix defect.\n")
            Path(directory, "calc.py").write_text("broken\n")
            result = self.invoke(directory, mode="approval")
        self.assertEqual(result.returncode, 3)
        self.assertEqual(json.loads(result.stdout)["status"], "approval_needed")
        self.assertEqual(len(Handler.calls), 2)
        self.assertFalse(any(path.endswith("stop/session-test") for path, *_ in Handler.calls))

    def test_opt_in_approves_exact_pending_task_then_continues_same_session(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "TASK.md").write_text("Fix defect.\n")
            Path(directory, "calc.py").write_text("broken\n")
            result = self.invoke(directory, mode="approval_then_verified", approve_task=True)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        report = json.loads(result.stdout)
        self.assertEqual(report["status"], "complete")
        self.assertEqual(report["approval_count"], 1)
        self.assertNotIn("approval-x", result.stdout)
        self.assertEqual(len(Handler.calls), 3)
        first = Handler.calls[1][1]
        resumed = Handler.calls[2][1]
        self.assertEqual(first["session"], resumed["session"])
        self.assertEqual(first["workspace"], resumed["workspace"])
        self.assertEqual(first["selected_endpoint_id"], resumed["selected_endpoint_id"])
        self.assertEqual(resumed["tool_approval_id"], ["approval-x"])
        self.assertEqual(resumed["tool_approval_decision"], ["approve_task"])

    def test_opt_in_rejects_malformed_or_wrong_session_approval(self):
        for mode in ("approval_malformed", "approval_wrong_session", "approval_valid_then_invalid"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                Path(directory, "TASK.md").write_text("Fix defect.\n")
                Path(directory, "calc.py").write_text("broken\n")
                result = self.invoke(directory, mode=mode, approve_task=True)
            self.assertEqual(result.returncode, 4)
            self.assertEqual(json.loads(result.stdout)["status"], "approval_invalid")
            self.assertEqual(len([path for path, *_ in Handler.calls if path == "/api/chat_stream"]), 1)

    def test_bad_workspace_mapping_fails_before_network(self):
        Handler.calls = []
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "TASK.md").write_text("Fix defect.\n")
            Path(directory, "calc.py").write_text("broken\n")
            result = subprocess.run([
                sys.executable, str(SCRIPT), "--task-file", str(Path(directory) / "TASK.md"),
                "--host-workspace", directory, "--container-workspace", "relative",
                "--api-base", self.base, "--endpoint-id", "ep-test", "--model", "qwen3.5:9b",
            ], env={**os.environ, "ODYSSEUS_SESSION": "private-test-token"}, text=True, capture_output=True)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(Handler.calls, [])

    def test_non_finite_timeout_fails_before_network(self):
        for timeout in ("nan", "inf", "-inf"):
            with self.subTest(timeout=timeout):
                Handler.calls = []
                with tempfile.TemporaryDirectory() as directory:
                    Path(directory, "TASK.md").write_text("Fix defect.\n")
                    Path(directory, "calc.py").write_text("broken\n")
                    result = self.invoke(directory, timeout=timeout)
                self.assertEqual(result.returncode, 2)
                self.assertIn("positive finite number", result.stderr)
                self.assertEqual(Handler.calls, [])

    def test_timeout_requests_stop_with_exact_owned_run_id(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "TASK.md").write_text("Fix defect.\n")
            Path(directory, "calc.py").write_text("broken\n")
            result = self.invoke(directory, mode="timeout", timeout="0.2")
        self.assertEqual(result.returncode, 124, result.stdout + result.stderr)
        report = json.loads(result.stdout)
        self.assertTrue(report["stopped_exact_run"])
        self.assertEqual(report["run_id"], "run-test")
        self.assertEqual(Handler.calls[-1][2]["stop_run_id"], "run-test")


if __name__ == "__main__":
    unittest.main()
