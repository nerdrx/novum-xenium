import http.client
import json
import socket
import threading
import time
import pytest

from scripts.managed_image_engine import create_server


FAKE_SERVER = r'''#!/usr/bin/env python3
import argparse, json, time
from http.server import BaseHTTPRequestHandler, HTTPServer
p = argparse.ArgumentParser()
p.add_argument("--listen-ip", required=True)
p.add_argument("--listen-port", required=True, type=int)
p.add_argument("--flavor", default="default")
a, _ = p.parse_known_args()
class H(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self):
        body = json.dumps({"data": [{"id": "sd-cpp-local"}]}).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        if b'"prompt":"hold"' in body: time.sleep(.7)
        out = json.dumps({"flavor": a.flavor, "path": self.path, "body": body.decode("latin1")}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out))); self.end_headers(); self.wfile.write(out)
HTTPServer((a.listen_ip, a.listen_port), H).serve_forever()
'''


def _port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _write_catalog(tmp_path, *, models=None, idle_seconds=300):
    binary = tmp_path / "sd-server"
    binary.write_text(FAKE_SERVER, encoding="utf-8")
    binary.chmod(0o700)
    if models is None:
        models = [{"id": "model-a", "name": "A", "command": [str(binary), "--flavor", "A"]}]
    catalog = tmp_path / "catalog.json"
    catalog.write_text(json.dumps({"version": 1, "models": models, "idle_seconds": idle_seconds,
                                   "startup_timeout": 5, "request_timeout": 5}), encoding="utf-8")
    catalog.chmod(0o600)
    return catalog


@pytest.fixture
def gateway(tmp_path):
    catalog = _write_catalog(tmp_path)
    token = b"test-token-that-is-long-enough-000000000000"
    port = _port()
    server, manager = create_server(catalog, token, port)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"127.0.0.1:{port}", token, manager, catalog
    finally:
        server.shutdown()
        server.server_close()
        manager.close()
        thread.join(timeout=2)


def _request(address, token, method="GET", path="/health", body=None, headers=None):
    host, port = address.split(":")
    conn = http.client.HTTPConnection(host, int(port), timeout=8)
    request_headers = {"Authorization": "Bearer " + token.decode()}
    if body is not None:
        request_headers["Content-Type"] = "application/json"
        request_headers["Content-Length"] = str(len(body))
    request_headers.update(headers or {})
    conn.request(method, path, body=body, headers=request_headers)
    response = conn.getresponse()
    payload = response.read()
    result = (response.status, response.getheader("Content-Type"), payload)
    conn.close()
    return result


def test_gateway_starts_without_child_and_authenticates_catalog_and_health(gateway):
    address, token, manager, _ = gateway
    assert manager.process is None
    assert _request(address, b"")[0] == 401
    assert _request(address, token, path="/health")[0] == 200
    status = json.loads(_request(address, token, path="/health")[2])
    assert status == {"status": "ready", "loaded_model": None, "models_count": 1,
                      "engine": "novum-image-engine", "generation_active": False}
    assert json.loads(_request(address, token, path="/v1/models")[2])["data"][0]["id"] == "model-a"
    assert _request(address, b"wrong-token")[0] == 401
    assert manager.process is None


def test_empty_catalog_still_serves_ready_gateway_without_starting_child(tmp_path):
    catalog = _write_catalog(tmp_path, models=[])
    token, port = b"test-token-that-is-long-enough-000000000000", _port()
    server, manager = create_server(catalog, token, port)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    try:
        address = f"127.0.0.1:{port}"
        status = json.loads(_request(address, token, path="/health")[2])
        assert status["status"] == "ready" and status["models_count"] == 0
        assert json.loads(_request(address, token, path="/v1/models")[2])["data"] == []
        body = json.dumps({"model": "sd-cpp-local", "prompt": "x"}).encode()
        assert _request(address, token, "POST", "/v1/images/generations", body)[0] == 400
        assert manager.process is None
    finally:
        server.shutdown(); server.server_close(); manager.close(); thread.join(timeout=2)
def test_generation_lazily_starts_and_dispatches_exact_catalog_model(gateway):
    address, token, manager, _ = gateway
    body = json.dumps({"model": "model-a", "prompt": "small blue square", "size": "512x512"}).encode()
    status, _, payload = _request(address, token, "POST", "/v1/images/generations", body)
    result = json.loads(payload)
    assert status == 200
    assert result["path"] == "/v1/images/generations"
    assert json.loads(result["body"])["model"] == "sd-cpp-local"
    assert result["flavor"] == "A"
    assert manager.process is not None


def test_unknown_model_oversize_and_unsupported_fields_do_not_start_child(gateway):
    address, token, manager, _ = gateway
    for obj in (
        {"model": "missing", "prompt": "x"},
        {"model": "model-a", "prompt": "x", "arbitrary_url": "http://127.0.0.1/"},
        {"model": "model-a", "prompt": "x", "n": 999},
    ):
        body = json.dumps(obj).encode()
        assert _request(address, token, "POST", "/v1/images/generations", body)[0] == 400
    host, port = address.split(":")
    conn = http.client.HTTPConnection(host, int(port), timeout=3)
    conn.putrequest("POST", "/v1/images/generations")
    conn.putheader("Authorization", "Bearer " + token.decode())
    conn.putheader("Content-Length", str(20 * 1024 * 1024 + 1))
    conn.putheader("Content-Type", "application/json")
    conn.endheaders()
    assert conn.getresponse().status == 413
    conn.close()
    assert manager.process is None


def test_model_switch_stops_only_owned_child_and_idle_reclaims_it(tmp_path):
    binary = tmp_path / "sd-server"
    binary.write_text(FAKE_SERVER, encoding="utf-8")
    binary.chmod(0o700)
    models = [
        {"id": "model-a", "name": "A", "command": [str(binary), "--flavor", "A"]},
        {"id": "model-b", "name": "B", "command": [str(binary), "--flavor", "B"]},
    ]
    catalog = _write_catalog(tmp_path, models=models, idle_seconds=30)
    token, port = b"test-token-that-is-long-enough-000000000000", _port()
    server, manager = create_server(catalog, token, port)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    try:
        address = f"127.0.0.1:{port}"
        for model, flavor in (("model-a", "A"), ("model-b", "B")):
            previous = manager.process
            body = json.dumps({"model": model, "prompt": "switch"}).encode()
            status, _, payload = _request(address, token, "POST", "/v1/images/generations", body)
            assert status == 200 and json.loads(payload)["flavor"] == flavor
            if previous is not None:
                assert previous.poll() is not None
        manager.last_used = time.monotonic() - 31
        deadline = time.monotonic() + 5
        while manager.process is not None and time.monotonic() < deadline:
            time.sleep(.05)
        assert manager.process is None
    finally:
        server.shutdown(); server.server_close(); manager.close(); thread.join(timeout=2)


def test_generation_lock_rejects_overlapping_requests(gateway):
    address, token, _manager, _ = gateway
    slow = json.dumps({"model": "model-a", "prompt": "hold"}).encode()
    result = []
    worker = threading.Thread(target=lambda: result.append(
        _request(address, token, "POST", "/v1/images/generations", slow)[0]))
    worker.start()
    time.sleep(.3)
    second = json.dumps({"model": "model-a", "prompt": "other"}).encode()
    assert _request(address, token, "POST", "/v1/images/generations", second)[0] == 503
    worker.join(timeout=5)
    assert result == [200]


def test_shutdown_during_generation_terminates_only_the_owned_engine(gateway):
    address, token, manager, _ = gateway
    body = json.dumps({"model": "model-a", "prompt": "hold"}).encode()
    result = []
    worker = threading.Thread(target=lambda: result.append(
        _request(address, token, "POST", "/v1/images/generations", body)[0]))
    worker.start()
    deadline = time.monotonic() + 5
    while manager.process is None and time.monotonic() < deadline:
        time.sleep(.02)
    process = manager.process
    assert process is not None
    manager.close()
    worker.join(timeout=5)
    assert process.poll() is not None
    assert result == [503]


def test_gateway_rejects_foreign_host_and_origin(gateway):
    address, token, _manager, _ = gateway
    host, port = address.split(":")
    conn = http.client.HTTPConnection(host, int(port), timeout=3)
    conn.request("GET", "/health", headers={"Authorization": "Bearer " + token.decode(), "Host": "example.org"})
    assert conn.getresponse().status == 400
    conn.close()
    assert _request(address, token, headers={"Origin": "https://example.org"})[0] == 403
    conn = http.client.HTTPConnection(host, int(port), timeout=3)
    conn.request("OPTIONS", "/v1/images/generations", headers={
        "Host": address, "Origin": "http://localhost:8111",
        "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type",
    })
    preflight = conn.getresponse()
    assert preflight.status == 204
    assert preflight.getheader("Access-Control-Allow-Origin") == "http://localhost:8111"
    conn.close()


def test_edit_model_is_rewritten_and_binary_part_preserved(gateway):
    address, token, _manager, _ = gateway
    boundary = "x-test-boundary"
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nmodel-a\r\n"
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"prompt\"\r\n\r\nkeep color\r\n"
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"image[]\"; filename=\"x.png\"\r\n"
            "Content-Type: image/png\r\n\r\n\x00PNG\xff\r\n"
            f"--{boundary}--\r\n").encode("latin1")
    status, _, payload = _request(
        address, token, "POST", "/v1/images/edits", body,
        {"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    result = json.loads(payload)
    assert status == 200 and result["path"] == "/v1/images/edits"
    assert 'name="model"\r\n\r\nsd-cpp-local' in result["body"]
    assert "\x00PNGÿ" in result["body"]


def test_occupied_loopback_port_is_never_adopted(tmp_path, monkeypatch):
    from http.server import BaseHTTPRequestHandler, HTTPServer
    import scripts.managed_image_engine as engine

    state = {"posts": 0}
    class Occupant(BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def do_GET(self):
            body = b'{"data":[{"id":"sd-cpp-local"}]}'
            self.send_response(200); self.send_header("Content-Length", str(len(body)))
            self.end_headers(); self.wfile.write(body)
        def do_POST(self):
            state["posts"] += 1
            self.send_response(200); self.send_header("Content-Length", "2")
            self.end_headers(); self.wfile.write(b"{}")

    occupied = HTTPServer(("127.0.0.1", 0), Occupant)
    occupied_thread = threading.Thread(target=occupied.serve_forever, daemon=True)
    occupied_thread.start()
    monkeypatch.setattr(engine, "_loopback_port", lambda: occupied.server_port)
    catalog = _write_catalog(tmp_path)
    token = b"test-token-that-is-long-enough-000000000000"
    gateway_port = _port()
    server, manager = create_server(catalog, token, gateway_port)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    try:
        body = json.dumps({"model": "model-a", "prompt": "must not reach occupant"}).encode()
        status, _, _ = _request(f"127.0.0.1:{gateway_port}", token,
                                "POST", "/v1/images/generations", body)
        assert status == 503
        assert state["posts"] == 0
        assert manager.process is None
    finally:
        server.shutdown(); server.server_close(); manager.close(); thread.join(timeout=2)
        occupied.shutdown(); occupied.server_close(); occupied_thread.join(timeout=2)


def test_catalog_rejects_link_or_unsafe_command(tmp_path):
    catalog = _write_catalog(tmp_path)
    linked = tmp_path / "linked.json"
    linked.symlink_to(catalog)
    from scripts.managed_image_engine import GatewayError, load_catalog
    with pytest.raises(GatewayError, match="symlink"):
        load_catalog(linked)
    data = json.loads(catalog.read_text())
    data["models"][0]["command"].extend(["--listen-port", "9999"])
    catalog.write_text(json.dumps(data))
    with pytest.raises(GatewayError, match="listen address"):
        load_catalog(catalog)


def test_legacy_model_alias_requires_unambiguous_selection(tmp_path):
    from scripts.managed_image_engine import GatewayError, _select_model, load_catalog
    binary = tmp_path / "sd-server"
    binary.write_text(FAKE_SERVER, encoding="utf-8")
    binary.chmod(0o700)
    catalog_path = _write_catalog(tmp_path)
    catalog = load_catalog(catalog_path)
    assert _select_model(catalog, "sd-cpp-local").id == "model-a"

    models = [
        {"id": "model-a", "name": "A", "command": [str(binary), "--flavor", "A"]},
        {"id": "model-b", "name": "B", "command": [str(binary), "--flavor", "B"]},
    ]
    catalog_path = _write_catalog(tmp_path, models=models)
    with pytest.raises(GatewayError, match="unknown image model"):
        _select_model(load_catalog(catalog_path), "sd-cpp-local")
    catalog_path.write_text(json.dumps({"version": 1, "models": models, "default_model": "model-b"}))
    catalog_path.chmod(0o600)
    assert _select_model(load_catalog(catalog_path), "sd-cpp-local").id == "model-b"
