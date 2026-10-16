#!/usr/bin/env python3
"""Loopback alarm API backed by per-user systemd timers and PulseAudio."""

import argparse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import fcntl
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.parse
import uuid


HOST = "127.0.0.1"
PORT = 8127
_ID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
_SOUND = "/usr/share/sounds/freedesktop/stereo/alarm-clock-elapsed.oga"
_STOP_EVENT = threading.Event()


class BridgeError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def _private_dir(path):
    path = Path(path).expanduser()
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if path.is_symlink() or not path.is_dir() or info.st_uid != os.getuid():
        raise ValueError("Unsafe alarm state directory")
    os.chmod(path, 0o700)
    return path.resolve()


def _read_or_create_token(path):
    path = Path(path).expanduser()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        info = path.lstat()
    except FileNotFoundError:
        token = secrets.token_urlsafe(32)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(token + "\n")
        return token
    if path.is_symlink() or not path.is_file() or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("Unsafe alarm token file")
    token = path.read_text(encoding="utf-8").strip()
    if len(token) < 32:
        raise ValueError("Alarm token file is invalid")
    return token


def _locked_state(state_dir):
    class StateLock:
        def __enter__(self):
            lock_path = state_dir / ".lock"
            fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
            self.stream = os.fdopen(fd, "r+")
            fcntl.flock(self.stream, fcntl.LOCK_EX)
            return self

        def __exit__(self, *_exc):
            fcntl.flock(self.stream, fcntl.LOCK_UN)
            self.stream.close()
    return StateLock()


def _state_path(state_dir):
    return state_dir / "alarms.json"


def _load_state(state_dir):
    path = _state_path(state_dir)
    try:
        info = path.lstat()
    except FileNotFoundError:
        return {"alarms": {}}
    if path.is_symlink() or not path.is_file() or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("Unsafe alarm state file")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or not isinstance(value.get("alarms"), dict):
        raise ValueError("Alarm state is invalid")
    return value


def _save_state(state_dir, value):
    target = _state_path(state_dir)
    temp = state_dir / (".alarms." + uuid.uuid4().hex)
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, separators=(",", ":"), ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, target)
    finally:
        try:
            temp.unlink()
        except FileNotFoundError:
            pass


def _owner(value):
    if not isinstance(value, str):
        raise ValueError("owner is required")
    value = value.strip()
    if not value or len(value) > 160 or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError("owner must be 1–160 characters without control characters")
    return value


def _parse_at(value):
    if not isinstance(value, str):
        raise ValueError("at must be an ISO timestamp with a timezone")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("at must be an ISO timestamp with a timezone") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("at must include a timezone")
    if parsed <= datetime.now(timezone.utc):
        raise ValueError("at must be in the future")
    return parsed.astimezone(timezone.utc)


def _validate_create(value):
    if not isinstance(value, dict):
        raise ValueError("Request must be a JSON object")
    allowed = {"owner", "at", "volume_percent", "duration_seconds", "label"}
    if set(value) != allowed:
        raise ValueError("Request must contain only owner, at, volume_percent, duration_seconds, and label")
    owner = _owner(value["owner"])
    at = _parse_at(value["at"])
    volume = value["volume_percent"]
    duration = value["duration_seconds"]
    if type(volume) is not int or not 0 <= volume <= 100:
        raise ValueError("volume_percent must be an integer from 0 to 100")
    if type(duration) is not int or not 1 <= duration <= 300:
        raise ValueError("duration_seconds must be an integer from 1 to 300")
    label = value["label"]
    if not isinstance(label, str) or not label.strip() or len(label) > 120:
        raise ValueError("label must be 1–120 characters")
    if any(ord(char) < 32 or ord(char) == 127 for char in label):
        raise ValueError("label cannot contain control characters")
    return {"owner": owner, "at": at, "volume_percent": volume,
            "duration_seconds": duration, "label": label.strip()}


def _alarm_view(alarm):
    return {key: alarm[key] for key in ("id", "at", "status", "volume_percent", "duration_seconds", "label")}


def _run(argv, timeout=8, check=True, env=None):
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=check, env=env)


def _systemd_available():
    if not shutil.which("systemctl"):
        return False
    try:
        return _run(["systemctl", "--user", "show-environment"], timeout=3, check=False).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def _audio_available():
    if not shutil.which("paplay") or not Path(_SOUND).is_file():
        return False
    return _audio_sink_available()


def _audio_sink_available():
    if not shutil.which("pactl"):
        return False
    try:
        return bool(_run(["pactl", "get-default-sink"], timeout=3).stdout.strip())
    except (OSError, subprocess.SubprocessError):
        return False


def health():
    checks = {
        "systemd_user": _systemd_available(),
        "pactl": bool(shutil.which("pactl")),
        "paplay": bool(shutil.which("paplay")),
        "alarm_sound": Path(_SOUND).is_file(),
    }
    checks["audio_sink"] = _audio_sink_available()
    return {"ok": all(checks.values()), "prerequisites": checks}


def _unit_name(alarm_id):
    return "novum-alarm-" + alarm_id


def _systemd_calendar(at):
    return at.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f UTC")


def _systemd_exec(argv):
    def quote(value):
        if not value or any(char.isspace() or char in '\\"' for char in value):
            return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
        return value
    return " ".join(quote(str(value)) for value in argv)


def _schedule(alarm, token_file, state_dir):
    alarm_id = alarm["id"]
    script = str(Path(__file__).resolve())
    restore = _systemd_exec([
        sys.executable, script, "--token-file", str(token_file),
        "--state-dir", str(state_dir), "--restore", alarm_id,
    ])
    argv = [
        "systemd-run", "--user", "--quiet", "--no-block", "--collect",
        "--unit=" + _unit_name(alarm_id),
        "--on-calendar=" + _systemd_calendar(datetime.fromisoformat(alarm["at"])),
        "--timer-property=AccuracySec=1us", "--timer-property=Persistent=true",
        "--property=RuntimeMaxSec=%ss" % (alarm["duration_seconds"] + 15),
        "--property=TimeoutStopSec=15s", "--property=ExecStopPost=" + restore, "--",
        sys.executable, script, "--token-file", str(token_file), "--state-dir", str(state_dir), "--play", alarm_id,
    ]
    _run(argv, timeout=8)


def _stop_units(alarm_id):
    unit = _unit_name(alarm_id)
    for suffix in (".timer", ".service"):
        name = unit + suffix
        stopped = _run(["systemctl", "--user", "stop", name], timeout=8, check=False)
        if stopped.returncode != 0:
            active = _run(["systemctl", "--user", "is-active", name], timeout=3, check=False)
            if active.returncode == 0:
                raise BridgeError(503, "Could not stop alarm")


def _create(state_dir, token_file, request):
    values = _validate_create(request)
    if not _systemd_available() or not _audio_available():
        raise BridgeError(503, "Alarm scheduling or audio is unavailable")
    alarm_id = str(uuid.uuid4())
    alarm = {
        "id": alarm_id,
        "owner": values["owner"],
        "at": values["at"].isoformat(),
        "status": "scheduled",
        "volume_percent": values["volume_percent"],
        "duration_seconds": values["duration_seconds"],
        "label": values["label"],
    }
    with _locked_state(state_dir):
        state = _load_state(state_dir)
        owned_active = [a for a in state["alarms"].values() if a.get("owner") == alarm["owner"] and a.get("status") in {"scheduled", "firing"}]
        if len(owned_active) >= 100:
            raise BridgeError(429, "Too many active alarms")
        state["alarms"][alarm_id] = alarm
        _save_state(state_dir, state)
    try:
        _schedule(alarm, token_file, state_dir)
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        with _locked_state(state_dir):
            state = _load_state(state_dir)
            if alarm_id in state["alarms"]:
                state["alarms"][alarm_id]["status"] = "failed"
                _save_state(state_dir, state)
        raise BridgeError(503, "Could not schedule alarm") from exc
    return {"alarm": _alarm_view(alarm)}


def _list(state_dir, owner):
    owner = _owner(owner)
    with _locked_state(state_dir):
        state = _load_state(state_dir)
    alarms = [_alarm_view(alarm) for alarm in state["alarms"].values() if alarm.get("owner") == owner]
    alarms.sort(key=lambda item: item["at"])
    return {"alarms": alarms}


def _stop(state_dir, alarm_id, owner):
    owner = _owner(owner)
    if not _ID_RE.fullmatch(alarm_id):
        raise BridgeError(404, "Alarm not found")
    with _locked_state(state_dir):
        state = _load_state(state_dir)
        alarm = state["alarms"].get(alarm_id)
        if not alarm or alarm.get("owner") != owner:
            raise BridgeError(404, "Alarm not found")
        if alarm.get("status") in {"scheduled", "firing"}:
            alarm["status"] = "stopped"
            _save_state(state_dir, state)
        alarm = dict(alarm)
    _stop_units(alarm_id)
    return {"alarm": _alarm_view(alarm)}


def _parse_raw_volumes(output):
    values = []
    for segment in output.split(","):
        match = re.search(r"(\d+)\s*/\s*[0-9]+(?:\.[0-9]+)?%", segment)
        if match:
            values.append(int(match.group(1)))
    if not values:
        raise RuntimeError("Could not capture sink volume")
    return values


def _audio_lock(state_dir, *, blocking=False):
    lock_path = state_dir / ".audio.lock"
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
    info = os.fstat(fd)
    if not os.path.isfile(lock_path) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        os.close(fd)
        raise ValueError("Unsafe audio lock")
    stream = os.fdopen(fd, "r+")
    try:
        fcntl.flock(stream, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        return stream
    except Exception:
        stream.close()
        raise


def _audio_snapshot_path(state_dir, alarm_id):
    if not _ID_RE.fullmatch(alarm_id):
        raise ValueError("Invalid alarm id")
    return state_dir / ("audio-" + alarm_id + ".json")


def _write_audio_snapshot(state_dir, alarm_id, snapshot):
    target = _audio_snapshot_path(state_dir, alarm_id)
    temp = state_dir / (".audio." + uuid.uuid4().hex)
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(snapshot, stream, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, target)
    finally:
        try:
            temp.unlink()
        except FileNotFoundError:
            pass


def _read_audio_snapshot(state_dir, alarm_id):
    path = _audio_snapshot_path(state_dir, alarm_id)
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if path.is_symlink() or not path.is_file() or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("Unsafe audio snapshot")
    snapshot = json.loads(path.read_text(encoding="utf-8"))
    if (not isinstance(snapshot, dict) or not isinstance(snapshot.get("sink"), str)
            or not snapshot["sink"] or any(c in snapshot["sink"] for c in "\r\n\x00")
            or type(snapshot.get("muted")) is not bool
            or not isinstance(snapshot.get("volumes"), list)
            or not snapshot["volumes"]
            or any(type(value) is not int or value < 0 for value in snapshot["volumes"])):
        raise ValueError("Audio snapshot is invalid")
    return snapshot


def _restore_audio_locked(state_dir, alarm_id):
    snapshot = _read_audio_snapshot(state_dir, alarm_id)
    if snapshot is None:
        return
    failure = None
    try:
        _pactl("set-sink-volume", snapshot["sink"], *[str(value) for value in snapshot["volumes"]])
    except Exception as exc:
        failure = exc
    try:
        _pactl("set-sink-mute", snapshot["sink"], "1" if snapshot["muted"] else "0")
    except Exception as exc:
        if failure is None:
            failure = exc
    if failure is not None:
        raise failure
    _audio_snapshot_path(state_dir, alarm_id).unlink(missing_ok=True)


def _restore_audio(state_dir, alarm_id):
    with _audio_lock(state_dir, blocking=True):
        _restore_audio_locked(state_dir, alarm_id)
    with _locked_state(state_dir):
        state = _load_state(state_dir)
        alarm = state["alarms"].get(alarm_id)
        if alarm and alarm.get("status") == "firing":
            alarm["status"] = "failed"
            _save_state(state_dir, state)


def _restore_stale_audio_snapshots(state_dir, current_alarm_id=None):
    for path in state_dir.glob("audio-*.json"):
        match = re.fullmatch(r"audio-(.+)\.json", path.name)
        alarm_id = match.group(1) if match else None
        if alarm_id and _ID_RE.fullmatch(alarm_id) and alarm_id != current_alarm_id:
            _restore_audio_locked(state_dir, alarm_id)
            with _locked_state(state_dir):
                state = _load_state(state_dir)
                alarm = state["alarms"].get(alarm_id)
                if alarm and alarm.get("status") == "firing":
                    alarm["status"] = "failed"
                    _save_state(state_dir, state)


def _recover_audio(state_dir):
    # A live alarm owns this lock; startup must not restore its in-progress snapshot.
    try:
        audio_lock = _audio_lock(state_dir)
    except BlockingIOError:
        return
    try:
        _restore_stale_audio_snapshots(state_dir)
    finally:
        audio_lock.close()


def _pactl(*args):
    return _run(["pactl", *map(str, args)], timeout=5,
                env={**os.environ, "LC_ALL": "C"})


def _play_sound(alarm, state_dir, alarm_id):
    sink = _pactl("get-default-sink").stdout.strip()
    if not sink or "\n" in sink or "\x00" in sink:
        raise RuntimeError("No default audio sink")
    old_mute = _pactl("get-sink-mute", sink).stdout.strip().lower().endswith("yes")
    old_volumes = _parse_raw_volumes(_pactl("get-sink-volume", sink).stdout)
    _write_audio_snapshot(state_dir, alarm_id, {"sink": sink, "muted": old_mute, "volumes": old_volumes})
    child = None
    try:
        _pactl("set-sink-volume", sink, *([str(alarm["volume_percent"]) + "%"] * len(old_volumes)))
        _pactl("set-sink-mute", sink, "0")
        deadline = time.monotonic() + alarm["duration_seconds"]
        while time.monotonic() < deadline and not _STOP_EVENT.is_set():
            child = subprocess.Popen(["paplay", "--device=" + sink, _SOUND], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            while child.poll() is None and time.monotonic() < deadline and not _STOP_EVENT.is_set():
                time.sleep(min(0.1, max(0.01, deadline - time.monotonic())))
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=1)
            elif child.returncode != 0 and not _STOP_EVENT.is_set():
                raise RuntimeError("Alarm audio playback failed")
            child = None
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=1)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=1)
        _restore_audio_locked(state_dir, alarm_id)


def _play(state_dir, alarm_id):
    if not _ID_RE.fullmatch(alarm_id):
        return 2
    try:
        audio_lock = _audio_lock(state_dir)
    except BlockingIOError:
        with _locked_state(state_dir):
            state = _load_state(state_dir)
            alarm = state["alarms"].get(alarm_id)
            if alarm and alarm.get("status") == "scheduled":
                alarm["status"] = "skipped"
                _save_state(state_dir, state)
        return 0
    except OSError:
        return 1
    with _locked_state(state_dir):
        state = _load_state(state_dir)
        alarm = state["alarms"].get(alarm_id)
        if not alarm or alarm.get("status") != "scheduled":
            audio_lock.close()
            return 0
        alarm["status"] = "firing"
        _save_state(state_dir, state)
        alarm = dict(alarm)
    _STOP_EVENT.clear()
    previous_handler = signal.signal(signal.SIGTERM, lambda *_args: _STOP_EVENT.set())
    failure = False
    try:
        _restore_stale_audio_snapshots(state_dir, alarm_id)
        _play_sound(alarm, state_dir, alarm_id)
    except Exception:
        failure = True
    finally:
        signal.signal(signal.SIGTERM, previous_handler)
        with _locked_state(state_dir):
            state = _load_state(state_dir)
            current = state["alarms"].get(alarm_id)
            if current and current.get("status") == "firing":
                current["status"] = "failed" if failure else ("stopped" if _STOP_EVENT.is_set() else "fired")
                _save_state(state_dir, state)
        audio_lock.close()
    return 1 if failure else 0


def _recover(state_dir, token_file):
    try:
        _recover_audio(state_dir)
    except (OSError, subprocess.SubprocessError, ValueError):
        # Leave failed snapshots in place so a later startup can retry restoration.
        pass
    with _locked_state(state_dir):
        state = _load_state(state_dir)
        pending = [dict(a) for a in state["alarms"].values() if a.get("status") == "scheduled"]
    for alarm in pending:
        alarm_id = alarm.get("id", "")
        if not isinstance(alarm_id, str) or not _ID_RE.fullmatch(alarm_id):
            continue
        if datetime.fromisoformat(alarm["at"]) <= datetime.now(timezone.utc):
            with _locked_state(state_dir):
                state = _load_state(state_dir)
                if state["alarms"].get(alarm["id"], {}).get("status") == "scheduled":
                    state["alarms"][alarm["id"]]["status"] = "missed"
                    _save_state(state_dir, state)
            continue
        try:
            active = _run(["systemctl", "--user", "is-active", _unit_name(alarm_id) + ".timer"],
                          timeout=3, check=False)
            if active.returncode == 0:
                continue
            _schedule(alarm, token_file, state_dir)
        except (OSError, subprocess.SubprocessError, ValueError):
            with _locked_state(state_dir):
                state = _load_state(state_dir)
                if state["alarms"].get(alarm["id"], {}).get("status") == "scheduled":
                    state["alarms"][alarm["id"]]["status"] = "failed"
                    _save_state(state_dir, state)


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, token, state_dir, token_file, address=(HOST, PORT)):
        self.token = token
        self.state_dir = state_dir
        self.token_file = token_file
        super().__init__(address, _Handler)


class _Handler(BaseHTTPRequestHandler):
    server: _Server

    def log_message(self, _format, *_args):
        return

    def send_error(self, code, _message=None, _explain=None):
        self._send(code, {"error": "Invalid HTTP request"})

    def _send(self, status, value):
        data = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self):
        supplied = self.headers.get("Authorization", "")
        prefix = "Bearer "
        return supplied.startswith(prefix) and hmac.compare_digest(supplied[len(prefix):], self.server.token)

    def _body(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("Invalid Content-Length") from exc
        if length < 1 or length > 16_384:
            raise ValueError("Request body is required and must be at most 16 KiB")
        if self.headers.get_content_type() != "application/json":
            raise ValueError("Content-Type must be application/json")
        try:
            return json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise ValueError("Request body must be valid JSON") from exc

    def _request(self, method):
        if not self._authorized():
            self._send(401, {"error": "Unauthorized"})
            return
        try:
            parsed = urllib.parse.urlsplit(self.path)
            if method == "GET" and parsed.path == "/v1/alarms":
                query = urllib.parse.parse_qs(parsed.query, strict_parsing=True)
                if set(query) != {"owner"} or len(query["owner"]) != 1:
                    raise ValueError("owner query parameter is required")
                self._send(200, _list(self.server.state_dir, query["owner"][0]))
                return
            if method == "GET" and parsed.path == "/health" and not parsed.query:
                self._send(200, health())
                return
            if method == "POST" and parsed.path == "/v1/alarms":
                self._send(201, _create(self.server.state_dir, self.server.token_file, self._body()))
                return
            match = re.fullmatch(r"/v1/alarms/([0-9a-f-]+)/stop", parsed.path)
            if method == "POST" and match and not parsed.query:
                body = self._body()
                if not isinstance(body, dict) or set(body) != {"owner"}:
                    raise ValueError("Stop request must contain only owner")
                self._send(200, _stop(self.server.state_dir, match.group(1), body["owner"]))
                return
            self._send(404, {"error": "Not found"})
        except BridgeError as exc:
            self._send(exc.status, {"error": str(exc)})
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            self._send(400, {"error": str(exc)})
        except Exception:
            self._send(500, {"error": "Alarm bridge request failed"})

    def do_GET(self):
        self._request("GET")

    def do_POST(self):
        self._request("POST")

    def do_PUT(self):
        self._send(405, {"error": "Method not allowed"})

    def do_PATCH(self):
        self._send(405, {"error": "Method not allowed"})

    def do_DELETE(self):
        self._send(405, {"error": "Method not allowed"})

    def do_OPTIONS(self):
        self._send(405, {"error": "Method not allowed"})


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--play", metavar="UUID")
    parser.add_argument("--restore", metavar="UUID")
    args = parser.parse_args(argv)
    try:
        state_dir = _private_dir(args.state_dir)
        if args.play:
            return _play(state_dir, args.play)
        if args.restore:
            _restore_audio(state_dir, args.restore)
            return 0
        token = _read_or_create_token(args.token_file)
        _recover(state_dir, Path(args.token_file).expanduser().resolve())
        _Server(token, state_dir, Path(args.token_file).expanduser().resolve()).serve_forever()
        return 0
    except OSError as exc:
        reason = exc.strerror or "OS error"
        print(f"Novum alarm bridge could not start ({reason}); check loopback port 8127 and private state paths.",
              file=sys.stderr)
        return 1
    except ValueError:
        print("Novum alarm bridge could not start (invalid private path or state); check its local configuration.",
              file=sys.stderr)
        return 1
    except subprocess.SubprocessError:
        print("Novum alarm bridge could not start (a required system command failed).", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
