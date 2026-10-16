import datetime as dt
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest
from unittest import mock
import urllib.error
import urllib.parse
import urllib.request


BRIDGE_PATH = Path(__file__).parents[1] / "src" / "alarm_bridge.py"
SPEC = importlib.util.spec_from_file_location("alarm_bridge_test", BRIDGE_PATH)
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


class AlarmBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.state_dir = Path(self.temp.name) / "state"
        self.state_dir.mkdir(mode=0o700)
        self.token_file = Path(self.temp.name) / "token"
        self.token = "t" * 48
        self.server = bridge._Server(self.token, self.state_dir, self.token_file, ("127.0.0.1", 0))
        self.server.token = self.token
        self.server.state_dir = self.state_dir
        self.server.token_file = self.token_file
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = "http://127.0.0.1:%s" % self.server.server_port

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def request(self, path, method="GET", body=None, auth=True):
        data = None if body is None else json.dumps(body).encode()
        headers = {"Content-Type": "application/json"} if data is not None else {}
        if auth:
            headers["Authorization"] = "Bearer " + self.token
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=3) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as exc:
            try:
                return exc.code, json.load(exc)
            finally:
                exc.close()

    def valid_request(self, **changes):
        value = {
            "owner": "admin",
            "at": (dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=5)).isoformat(),
            "volume_percent": 78,
            "duration_seconds": 45,
            "label": "Wake up",
        }
        value.update(changes)
        return value

    def test_authenticated_create_list_and_owner_scoped_stop(self):
        with mock.patch.object(bridge, "_systemd_available", return_value=True), \
                mock.patch.object(bridge, "_audio_available", return_value=True), \
                mock.patch.object(bridge, "_schedule") as schedule, \
                mock.patch.object(bridge, "_stop_units") as stop_units:
            status, created = self.request("/v1/alarms", "POST", self.valid_request())
            self.assertEqual(status, 201)
            alarm = created["alarm"]
            self.assertEqual(alarm["status"], "scheduled")
            self.assertRegex(alarm["id"], bridge._ID_RE)
            schedule.assert_called_once()

            status, listed = self.request("/v1/alarms?owner=admin")
            self.assertEqual(status, 200)
            self.assertEqual(listed["alarms"], [alarm])
            self.assertNotIn("owner", listed["alarms"][0])

            status, denied = self.request("/v1/alarms/%s/stop" % alarm["id"], "POST", {"owner": "other"})
            self.assertEqual(status, 404)
            self.assertEqual(denied["error"], "Alarm not found")
            stop_units.assert_not_called()

            status, stopped = self.request("/v1/alarms/%s/stop" % alarm["id"], "POST", {"owner": "admin"})
            self.assertEqual(status, 200)
            self.assertEqual(stopped["alarm"]["status"], "stopped")
            stop_units.assert_called_once_with(alarm["id"])

    def test_auth_unknown_fields_and_validation(self):
        status, _ = self.request("/v1/alarms?owner=admin", auth=False)
        self.assertEqual(status, 401)
        with mock.patch.object(bridge, "_systemd_available", return_value=True), \
                mock.patch.object(bridge, "_audio_available", return_value=True), \
                mock.patch.object(bridge, "_schedule") as schedule:
            for payload in (
                self.valid_request(extra="command"),
                self.valid_request(at="2000-01-01T15:00:00+00:00"),
                self.valid_request(volume_percent=True),
                self.valid_request(volume_percent=101),
                self.valid_request(duration_seconds=301),
                self.valid_request(label="bad\nlabel"),
                self.valid_request(owner="  "),
            ):
                status, result = self.request("/v1/alarms", "POST", payload)
                self.assertEqual(status, 400, result)
            schedule.assert_not_called()

    def test_health_and_unsupported_methods_return_json(self):
        with mock.patch.object(bridge, "health", return_value={"ok": False, "prerequisites": {"pactl": False}}):
            status, result = self.request("/health")
        self.assertEqual(status, 200)
        self.assertIs(result["ok"], False)
        status, result = self.request("/v1/alarms", "PUT")
        self.assertEqual(status, 405)
        self.assertEqual(result["error"], "Method not allowed")

    def test_loopback_server_rebinds_after_client_disconnect(self):
        server = bridge._Server(self.token, self.state_dir, self.token_file, ("127.0.0.1", 0))
        port = server.server_port
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}/health",
            headers={"Authorization": "Bearer " + self.token},
        )
        with urllib.request.urlopen(request, timeout=3) as response:
            self.assertEqual(response.status, 200)
            json.load(response)
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

        replacement = bridge._Server(self.token, self.state_dir, self.token_file, ("127.0.0.1", port))
        try:
            self.assertEqual(replacement.server_port, port)
        finally:
            replacement.server_close()

    def test_startup_diagnostic_is_short_and_does_not_expose_token(self):
        stderr = io.StringIO()
        with mock.patch.object(bridge, "_private_dir", return_value=self.state_dir), \
                mock.patch.object(bridge, "_read_or_create_token", return_value="secret-token-never-print"), \
                mock.patch.object(bridge, "_recover"), \
                mock.patch.object(bridge, "_Server", side_effect=OSError("bind failed")), \
                contextlib.redirect_stderr(stderr):
            result = bridge.main(["--token-file", str(self.token_file), "--state-dir", str(self.state_dir)])
        self.assertEqual(result, 1)
        self.assertIn("loopback port 8127", stderr.getvalue())
        self.assertNotIn("secret-token-never-print", stderr.getvalue())

    def test_private_token_creation_and_permissions(self):
        token = bridge._read_or_create_token(self.token_file)
        self.assertGreaterEqual(len(token), 32)
        self.assertEqual(self.token_file.stat().st_mode & 0o777, 0o600)
        self.assertEqual(bridge._read_or_create_token(self.token_file), token)

    def test_timestamp_is_scheduled_in_utc_with_microseconds(self):
        local = dt.datetime(2026, 10, 16, 13, 0, 1, 234567, tzinfo=dt.timezone(dt.timedelta(hours=2)))
        self.assertEqual(bridge._systemd_calendar(local), "2026-10-16 11:00:01.234567 UTC")

    def test_schedule_passes_fixed_arguments_to_systemd(self):
        alarm_id = "12345678-1234-1234-1234-123456789abc"
        alarm = {"id": alarm_id, "at": "2026-10-16T11:00:01.234567+00:00", "duration_seconds": 45}
        with mock.patch.object(bridge, "_run") as run:
            bridge._schedule(alarm, Path("/tmp/token;no-shell"), Path("/tmp/state space"))
        argv = run.call_args.args[0]
        self.assertEqual(argv[0], "systemd-run")
        self.assertIn("--on-calendar=2026-10-16 11:00:01.234567 UTC", argv)
        self.assertIn("--timer-property=AccuracySec=1us", argv)
        self.assertIn("--property=RuntimeMaxSec=60s", argv)
        self.assertIn("--property=TimeoutStopSec=15s", argv)
        stop_post = next(arg for arg in argv if arg.startswith("--property=ExecStopPost="))
        self.assertIn('--restore 12345678-1234-1234-1234-123456789abc', stop_post)
        self.assertIn('"/tmp/state space"', stop_post)
        self.assertLess(argv.index("--property=RuntimeMaxSec=60s"), argv.index("--"))
        self.assertEqual(argv[-1], alarm_id)
        self.assertNotIn("shell", run.call_args.kwargs)

    def test_pactl_uses_stable_locale_for_output_parsing(self):
        with mock.patch.object(bridge, "_run", return_value=mock.Mock(stdout="Mute: no\n")) as run:
            bridge._pactl("get-sink-mute", "sink0")
        self.assertEqual(run.call_args.args[0], ["pactl", "get-sink-mute", "sink0"])
        self.assertEqual(run.call_args.kwargs["env"]["LC_ALL"], "C")

    def test_pactl_passes_locale_to_a_real_subprocess(self):
        with tempfile.TemporaryDirectory() as temp:
            executable = Path(temp) / "pactl"
            executable.write_text("#!/bin/sh\nprintf '%s' \"$LC_ALL\"\n")
            executable.chmod(0o755)
            with mock.patch.dict(os.environ, {"PATH": temp, "LC_ALL": "fr_FR.UTF-8"}):
                result = bridge._pactl("get-default-sink")
        self.assertEqual(result.stdout, "C")

    def test_stop_stops_timer_and_running_service(self):
        alarm_id = "12345678-1234-1234-1234-123456789abc"
        completed = subprocess.CompletedProcess([], 0)
        with mock.patch.object(bridge, "_run", return_value=completed) as run:
            bridge._stop_units(alarm_id)
        self.assertEqual([call.args[0][-1] for call in run.call_args_list],
                         ["novum-alarm-" + alarm_id + ".timer",
                          "novum-alarm-" + alarm_id + ".service"])

    def test_stop_reports_still_active_unit(self):
        alarm_id = "12345678-1234-1234-1234-123456789abc"
        inactive = subprocess.CompletedProcess([], 1)
        active = subprocess.CompletedProcess([], 0)
        with mock.patch.object(bridge, "_run", side_effect=[inactive, active]):
            with self.assertRaises(bridge.BridgeError):
                bridge._stop_units(alarm_id)

    def test_audio_playback_restores_exact_channel_volumes_and_mute(self):
        alarm_id = "12345678-1234-1234-1234-123456789abc"
        calls = []

        def pactl(*args):
            calls.append(args)
            if args[:2] == ("set-sink-volume", "sink0") and args[2:] == ("78%", "78%"):
                snapshot = bridge._read_audio_snapshot(self.state_dir, alarm_id)
                self.assertEqual(snapshot, {"sink": "sink0", "muted": True, "volumes": [10000, 20000]})
            if args[:1] == ("get-default-sink",):
                return mock.Mock(stdout="sink0\n")
            if args[:1] == ("get-sink-mute",):
                return mock.Mock(stdout="Mute: yes\n")
            if args[:1] == ("get-sink-volume",):
                return mock.Mock(stdout="Volume: front-left: 10000 / 15%, front-right: 20000 / 30%\n")
            return mock.Mock(stdout="")

        child = mock.Mock(returncode=0)
        with mock.patch.object(bridge, "_pactl", side_effect=pactl), \
                mock.patch.object(bridge.subprocess, "Popen", return_value=child) as popen, \
                mock.patch.object(bridge.time, "monotonic", side_effect=[10.0, 10.0, 11.0]):
            bridge._play_sound({"volume_percent": 78, "duration_seconds": 1}, self.state_dir, alarm_id)

        popen.assert_called_once_with(["paplay", "--device=sink0", bridge._SOUND],
                                      stdout=bridge.subprocess.DEVNULL, stderr=bridge.subprocess.DEVNULL)
        self.assertIn(("set-sink-volume", "sink0", "78%", "78%"), calls)
        self.assertIn(("set-sink-volume", "sink0", "10000", "20000"), calls)
        self.assertEqual(calls[-1], ("set-sink-mute", "sink0", "1"))
        self.assertFalse(bridge._audio_snapshot_path(self.state_dir, alarm_id).exists())

    def test_audio_failure_still_attempts_to_restore_sink(self):
        alarm_id = "12345678-1234-1234-1234-123456789abc"
        calls = []

        def pactl(*args):
            calls.append(args)
            if args[:1] == ("get-default-sink",):
                return mock.Mock(stdout="sink0\n")
            if args[:1] == ("get-sink-mute",):
                return mock.Mock(stdout="Mute: no\n")
            if args[:1] == ("get-sink-volume",):
                return mock.Mock(stdout="Volume: mono: 12345 / 19%\n")
            return mock.Mock(stdout="")

        with mock.patch.object(bridge, "_pactl", side_effect=pactl), \
                mock.patch.object(bridge.subprocess, "Popen", side_effect=OSError("missing paplay")):
            with self.assertRaises(OSError):
                bridge._play_sound({"volume_percent": 70, "duration_seconds": 2}, self.state_dir, alarm_id)
        self.assertIn(("set-sink-volume", "sink0", "12345"), calls)
        self.assertEqual(calls[-1], ("set-sink-mute", "sink0", "0"))

    def test_mute_restore_runs_even_if_volume_restore_fails(self):
        alarm_id = "12345678-1234-1234-1234-123456789abc"
        calls = []

        def pactl(*args):
            calls.append(args)
            if args[:1] == ("get-default-sink",):
                return mock.Mock(stdout="sink0\n")
            if args[:1] == ("get-sink-mute",):
                return mock.Mock(stdout="Mute: yes\n")
            if args[:1] == ("get-sink-volume",):
                return mock.Mock(stdout="Volume: mono: 12345 / 19%\n")
            if args[:2] == ("set-sink-volume", "sink0") and args[2:] == ("12345",):
                raise RuntimeError("volume restoration failed")
            return mock.Mock(stdout="")

        child = mock.Mock(returncode=0)
        with mock.patch.object(bridge, "_pactl", side_effect=pactl), \
                mock.patch.object(bridge.subprocess, "Popen", return_value=child) as popen, \
                mock.patch.object(bridge.time, "monotonic", side_effect=[10.0, 10.0, 11.0]):
            with self.assertRaisesRegex(RuntimeError, "volume restoration failed"):
                bridge._play_sound({"volume_percent": 70, "duration_seconds": 1}, self.state_dir, alarm_id)
        popen.assert_called_once()
        self.assertEqual(calls[-1], ("set-sink-mute", "sink0", "1"))
        self.assertTrue(bridge._audio_snapshot_path(self.state_dir, alarm_id).exists(),
                        "failed volume restoration keeps recovery state for ExecStopPost")
        with mock.patch.object(bridge, "_pactl"):
            bridge._restore_audio(self.state_dir, alarm_id)
        self.assertFalse(bridge._audio_snapshot_path(self.state_dir, alarm_id).exists())

    def test_restore_runner_is_idempotent(self):
        alarm_id = "12345678-1234-1234-1234-123456789abc"
        bridge._save_state(self.state_dir, {"alarms": {alarm_id: {
            "id": alarm_id, "owner": "admin", "status": "firing",
        }}})
        bridge._write_audio_snapshot(self.state_dir, alarm_id,
                                     {"sink": "sink0", "muted": True, "volumes": [12345, 23456]})
        with mock.patch.object(bridge, "_pactl") as pactl:
            bridge._restore_audio(self.state_dir, alarm_id)
            self.assertFalse(bridge._audio_snapshot_path(self.state_dir, alarm_id).exists())
            bridge._restore_audio(self.state_dir, alarm_id)
        self.assertEqual([call.args for call in pactl.call_args_list], [
            ("set-sink-volume", "sink0", "12345", "23456"),
            ("set-sink-mute", "sink0", "1"),
        ])
        self.assertEqual(bridge._load_state(self.state_dir)["alarms"][alarm_id]["status"], "failed")

    def test_overlapping_alarm_is_skipped_while_audio_lock_is_owned(self):
        alarm_id = "12345678-1234-1234-1234-123456789abc"
        bridge._save_state(self.state_dir, {"alarms": {alarm_id: {
            "id": alarm_id, "owner": "admin", "status": "scheduled",
        }}})
        audio_lock = bridge._audio_lock(self.state_dir)
        try:
            with mock.patch.object(bridge, "_play_sound") as play_sound:
                self.assertEqual(bridge._play(self.state_dir, alarm_id), 0)
            play_sound.assert_not_called()
        finally:
            audio_lock.close()
        self.assertEqual(bridge._load_state(self.state_dir)["alarms"][alarm_id]["status"], "skipped")


if __name__ == "__main__":
    unittest.main()
