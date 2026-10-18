import json
import os
import socket
import struct
import threading
from types import SimpleNamespace
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import routes.local_engine_routes as engine_routes
from src.local_image_engine import LocalImageEngine, image_catalog


def test_cache_scan_does_not_block_controls_or_duplicate_scans(tmp_path, monkeypatch):
    entered, release, configured = threading.Event(), threading.Event(), threading.Event()
    def scanner():
        entered.set()
        assert release.wait(3)
        return []
    engine = LocalImageEngine(tmp_path, scanner=scanner)
    monkeypatch.setattr(engine, "_binary", lambda: ("/usr/local/bin/sd-server", "cpu"))
    monkeypatch.setattr(engine, "register_endpoint", lambda: None)
    scan = threading.Thread(target=engine.refresh)
    scan.start()
    try:
        assert entered.wait(1)
        assert engine.refresh() is False
        control = threading.Thread(target=lambda: (engine.configure({"auto_start": False}), configured.set()))
        control.start()
        assert configured.wait(1), "a blocked cache scanner must not hold the settings lock"
        control.join(1)
    finally:
        release.set()
        scan.join(3)
        engine.close()


def _patch_start_without_worker(monkeypatch, engine):
    launches = []

    class FakeSocket:
        def __enter__(self): return self
        def __exit__(self, *_args): return False
        def setsockopt(self, *_args): pass
        def bind(self, *_args): pass

    class FakeProcess:
        returncode = None
        def poll(self): return self.returncode
        def terminate(self): self.returncode = 0
        def wait(self, **_kwargs): return self.returncode

    monkeypatch.setattr(socket, "socket", FakeSocket)
    monkeypatch.setattr(engine, "_binary", lambda: ("/unused/sd-server", "cpu"))
    monkeypatch.setattr(engine, "health", lambda: {})
    monkeypatch.setattr(engine, "register_endpoint", lambda: None)
    monkeypatch.setattr(
        "src.local_image_engine.subprocess.Popen",
        lambda *_args, **_kwargs: launches.append(FakeProcess()) or launches[-1],
    )
    return launches


def test_first_start_scan_and_catalog_build_do_not_block_configure(tmp_path, monkeypatch):
    entered, release, catalog_entered, catalog_release = (threading.Event() for _ in range(4))
    configured_scan, configured_catalog = threading.Event(), threading.Event()

    def scanner():
        entered.set()
        assert release.wait(3)
        return []

    def catalog(*_args):
        catalog_modes.append(_args[2])
        catalog_entered.set()
        if len(catalog_modes) == 1:
            assert catalog_release.wait(3)
        return [], []

    engine = LocalImageEngine(tmp_path, scanner=scanner)
    launches = _patch_start_without_worker(monkeypatch, engine)
    catalog_modes = []
    engine._binary = lambda: ("/unused/sd-server", engine.settings["mode"])
    monkeypatch.setattr("src.local_image_engine.image_catalog", catalog)
    errors = []
    start = threading.Thread(target=lambda: _capture_error(engine.start, errors))
    start.start()
    try:
        assert entered.wait(1)
        configure = threading.Thread(
            target=lambda: (engine.configure({"auto_start": False}), configured_scan.set())
        )
        configure.start()
        assert configured_scan.wait(1), "initial scan must not hold the control lock"
        release.set()
        assert catalog_entered.wait(1)
        configure = threading.Thread(
            target=lambda: (engine.configure({"mode": "cpu", "idle_seconds": 600}), configured_catalog.set())
        )
        configure.start()
        assert configured_catalog.wait(1), "catalog building must not hold the control lock"
        catalog_release.set()
        start.join(2)
        configure.join(2)
        assert not start.is_alive()
        assert len(errors) == 1
        assert "settings changed during refresh" in str(errors[0])
        assert launches == []
        assert catalog_modes == ["auto"]
        assert not (engine.home / "image-models.json").exists()
    finally:
        release.set()
        catalog_release.set()
        start.join(3)
        engine.close()


def test_stop_during_first_start_scan_prevents_gateway_launch(tmp_path, monkeypatch):
    entered, release = threading.Event(), threading.Event()

    def scanner():
        entered.set()
        assert release.wait(3)
        return []

    engine = LocalImageEngine(tmp_path, scanner=scanner)
    launches = _patch_start_without_worker(monkeypatch, engine)
    start = threading.Thread(target=engine.start)
    start.start()
    try:
        assert entered.wait(1)
        engine.stop()
        release.set()
        start.join(2)
        assert not start.is_alive()
        assert launches == []
        assert engine.process is None
    finally:
        release.set()
        start.join(3)
        engine.close()


def test_stop_and_configure_during_readiness_do_not_block_or_publish(tmp_path, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    engine = LocalImageEngine(tmp_path, scanner=lambda: [])
    (engine.home / "image-models.json").write_text("{}")
    launches = _patch_start_without_worker(monkeypatch, engine)
    registered = []

    def health():
        entered.set()
        assert release.wait(3)
        return {}

    monkeypatch.setattr(engine, "health", health)
    monkeypatch.setattr(engine, "register_endpoint", lambda: registered.append(True))
    errors = []
    start = threading.Thread(target=lambda: _capture_error(engine.start, errors))
    start.start()
    try:
        assert entered.wait(1)
        # These controls must be able to invalidate the in-flight readiness wait.
        engine.configure({"idle_seconds": 600})
        engine.stop()
        release.set()
        start.join(2)
        assert not start.is_alive()
        assert not errors
        assert len(launches) == 1 and launches[0].returncode == 0
        assert engine.process is None
        assert registered == []
    finally:
        release.set()
        start.join(3)
        engine.close()


def test_status_snapshots_process_before_concurrent_stop(tmp_path, monkeypatch):
    process_read, release_read = threading.Event(), threading.Event()

    class GatedProcessRead(LocalImageEngine):
        def __getattribute__(self, name):
            value = object.__getattribute__(self, name)
            if name == "process" and object.__getattribute__(self, "_gate_process_read"):
                object.__setattr__(self, "_gate_process_read", False)
                process_read.set()
                assert release_read.wait(3)
            return value

    class FakeProcess:
        returncode = None
        def poll(self): return self.returncode
        def terminate(self): self.returncode = 0
        def wait(self, **_kwargs): return self.returncode

    engine = LocalImageEngine(tmp_path, scanner=lambda: [])
    engine.__class__ = GatedProcessRead
    engine._gate_process_read = True
    engine.process = FakeProcess()
    monkeypatch.setattr(engine, "health", lambda: {})
    result, errors = [], []
    status = threading.Thread(target=lambda: _capture_error(lambda: result.append(engine.status()), errors))
    status.start()
    try:
        assert process_read.wait(1)
        stopped = threading.Event()
        stop = threading.Thread(target=lambda: (engine.stop(), stopped.set()))
        stop.start()
        # Let Stop contend with the status snapshot before releasing the fake read.
        stopped.wait(0.05)
        release_read.set()
        status.join(2)
        stop.join(2)
        assert not status.is_alive() and not stop.is_alive()
        assert not errors
        assert result[0]["running"] is True  # consistent snapshot from before Stop
        assert engine.status()["running"] is False
    finally:
        release_read.set()
        status.join(3)
        engine.close()


def test_close_during_first_start_scan_prevents_gateway_launch(tmp_path, monkeypatch):
    entered, release = threading.Event(), threading.Event()

    def scanner():
        entered.set()
        assert release.wait(3)
        return []

    engine = LocalImageEngine(tmp_path, scanner=scanner)
    launches = _patch_start_without_worker(monkeypatch, engine)
    start = threading.Thread(target=engine.start)
    start.start()
    try:
        assert entered.wait(1)
        engine.close()
        release.set()
        start.join(2)
        assert not start.is_alive()
        assert launches == []
        assert engine.process is None
    finally:
        release.set()
        start.join(3)
        engine.close()


def test_concurrent_first_starts_scan_and_launch_once(tmp_path, monkeypatch):
    entered, release = threading.Event(), threading.Event()

    def scanner():
        entered.set()
        assert release.wait(3)
        return []

    engine = LocalImageEngine(tmp_path, scanner=scanner)
    launches = _patch_start_without_worker(monkeypatch, engine)
    errors = []
    starts = [threading.Thread(target=lambda: _capture_error(engine.start, errors)) for _ in range(2)]
    for start in starts:
        start.start()
    try:
        assert entered.wait(1)
        release.set()
        for start in starts:
            start.join(2)
        assert all(not start.is_alive() for start in starts)
        assert not errors
        assert len(launches) == 1
    finally:
        release.set()
        for start in starts:
            start.join(3)
        engine.close()


def test_failed_first_start_scan_does_not_launch_gateway(tmp_path, monkeypatch):
    def scanner():
        raise ValueError("scan failed")

    engine = LocalImageEngine(tmp_path, scanner=scanner)
    launches = _patch_start_without_worker(monkeypatch, engine)
    try:
        try:
            engine.start()
        except ValueError as exc:
            assert str(exc) == "scan failed"
        else:
            raise AssertionError("failed initial scan must abort start")
        assert launches == []
        assert engine.process is None
    finally:
        engine.close()


def test_failed_first_start_catalog_does_not_launch_gateway(tmp_path, monkeypatch):
    engine = LocalImageEngine(tmp_path, scanner=lambda: [])
    launches = _patch_start_without_worker(monkeypatch, engine)
    monkeypatch.setattr(
        "src.local_image_engine.image_catalog",
        lambda *_args: (_ for _ in ()).throw(ValueError("catalog failed")),
    )
    try:
        try:
            engine.start()
        except ValueError as exc:
            assert str(exc) == "catalog failed"
        else:
            raise AssertionError("failed initial catalog must abort start")
        assert launches == []
        assert engine.process is None
    finally:
        engine.close()


def _capture_error(action, errors):
    try:
        action()
    except Exception as exc:
        errors.append(exc)


def _gguf(architecture):
    key = b"general.architecture"
    value = architecture.encode()
    return (b"GGUF" + struct.pack("<IQQQ", 3, 0, 1, len(key)) + key
            + struct.pack("<IQ", 8, len(value)) + value)


def _safetensors(*keys):
    header = json.dumps({key: {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]}
                         for key in keys}).encode()
    return struct.pack("<Q", len(header)) + header + b"data"


def _cached_file(cache, repo, name, contents, *, role="model", suffix_dir="revision"):
    path = cache / ("models--" + repo.replace("/", "--")) / "snapshots" / suffix_dir / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(contents)
    return {"name": name, "rel_path": f"{suffix_dir}/{name}", "role": role}


def _cache_row(cache, repo, files, **flags):
    return {
        "repo_id": repo,
        "path": str(cache),
        "has_incomplete": False,
        "is_local_dir": False,
        "is_gguf": True,
        "is_diffusion": False,
        "is_video": False,
        "is_adapter": False,
        **flags,
        "gguf_files": [file for file in files if file["name"].lower().endswith(".gguf")],
        "safetensors_files": [file for file in files if file["name"].lower().endswith(".safetensors")],
    }


def test_catalog_admits_only_complete_diffusion_models(tmp_path):
    cache = tmp_path / "cache"
    rows = []
    rows.append(_cache_row(cache, "owner/sd-xl", [
        _cached_file(cache, "owner/sd-xl", "model.gguf", _gguf("sdxl"))
    ]))
    rows.append(_cache_row(cache, "owner/text", [
        _cached_file(cache, "owner/text", "text.gguf", _gguf("llama"))
    ]))
    rows.append(_cache_row(cache, "owner/clip", [
        _cached_file(cache, "owner/clip", "clip.gguf", _gguf("clip"))
    ]))
    rows.append(_cache_row(cache, "owner/adapter", [
        _cached_file(cache, "owner/adapter", "adapter.gguf", _gguf("sdxl")),
    ], is_adapter=True))
    rows.append(_cache_row(cache, "owner/incomplete", [
        _cached_file(cache, "owner/incomplete", "incomplete.gguf", _gguf("sdxl")),
    ], has_incomplete=True))
    traversal = _cache_row(cache, "owner/traversal", [{
        "name": "escape.gguf", "rel_path": "../../../../outside.gguf", "role": "model",
    }])
    rows.append(traversal)
    rows.append(_cache_row(cache, "owner/projector", [
        _cached_file(cache, "owner/projector", "projector.gguf", _gguf("sdxl"), role="projector"),
    ]))
    rows.append(_cache_row(cache, "owner/flux2-text-model", [
        _cached_file(cache, "owner/flux2-text-model", "flux2.gguf", _gguf("flux2")),
    ]))

    models, pending = image_catalog(rows, "/unused/sd-server", "cpu")
    assert pending == []
    assert len(models) == 1
    assert models[0]["id"].startswith("sd-cpp-local:owner--sd-xl:")
    assert models[0]["command"][:2] == ["/unused/sd-server", "-m"]
    assert models[0]["command"][2].endswith("model.gguf")


def test_flux_klein_requires_supported_cached_encoder_and_vae(tmp_path):
    cache = tmp_path / "cache"
    model_repo = "comfy-org/flux2-klein-4b"
    encoder_repo = "comfy-org/vae-text-encorder-for-flux-klein-4b"
    vae_repo = "black-forest-labs/flux.2-dev"
    target = _cache_row(cache, model_repo, [
        _cached_file(cache, model_repo, "flux2-klein-4b.safetensors",
                     _safetensors("model.diffusion_model.input.weight")),
    ], is_gguf=False)
    models, pending = image_catalog([target], "/sd-server", "zvram")
    assert models == []
    assert pending == [{"name": model_repo, "reason": "Waiting for cached Qwen3 4B encoder and FLUX.2 VAE components."}]

    encoder_file = "qwen_3_4b.safetensors"
    vae_file = "flux2-vae.safetensors"
    encoder = _cache_row(cache, encoder_repo, [
        _cached_file(cache, encoder_repo, encoder_file, _safetensors("model.layers.0.weight"))
    ], is_gguf=False)
    vae = _cache_row(cache, vae_repo, [
        _cached_file(cache, vae_repo, vae_file, _safetensors("decoder.conv_in.weight"))
    ], is_gguf=False)
    models, pending = image_catalog([target, encoder, vae], "/sd-server", "zvram")
    assert pending == []
    assert len(models) == 1
    command = models[0]["command"]
    assert command[command.index("--llm") + 1].endswith(encoder_file)
    assert command[command.index("--vae") + 1].endswith(vae_file)
    assert command[command.index("--params-backend") + 1] == "diffusion=cpu"


def test_catalog_skips_malformed_cache_rows_and_invalid_component_headers(tmp_path):
    cache = tmp_path / "cache"
    malformed_rows = [
        None,
        {"repo_id": "owner/bad", "path": str(cache), "has_incomplete": False,
         "gguf_files": [None], "safetensors_files": [[]]},
    ]
    assert image_catalog(malformed_rows, "/sd-server", "cpu") == ([], [])

    target_repo = "comfy-org/flux2-klein-4b"
    encoder_repo = "comfy-org/vae-text-encorder-for-flux-klein-4b"
    vae_repo = "black-forest-labs/flux.2-dev"
    target = _cache_row(cache, target_repo, [
        _cached_file(cache, target_repo, "flux2-klein-4b.safetensors",
                     _safetensors("model.diffusion_model.input.weight")),
    ], is_gguf=False)
    encoder = _cache_row(cache, encoder_repo, [
        _cached_file(cache, encoder_repo, "qwen_3_4b.safetensors",
                     struct.pack("<Q", len(b'{"__metadata__":{"format":"pt"}}'))
                     + b'{"__metadata__":{"format":"pt"}}'),
    ], is_gguf=False)
    vae = _cache_row(cache, vae_repo, [
        _cached_file(cache, vae_repo, "flux2-vae.safetensors", b"not-a-safetensors-header"),
    ], is_gguf=False)
    models, pending = image_catalog([target, encoder, vae], "/sd-server", "cpu")
    assert models == []
    assert [item["name"] for item in pending] == [target_repo]


def test_select_default_only_fills_unset_or_dead_owned_legacy_selection(monkeypatch, tmp_path):
    engine = LocalImageEngine(tmp_path, scanner=lambda: [])
    saved = []
    settings_module = __import__("src.settings", fromlist=["load_settings"])
    monkeypatch.setattr(settings_module, "load_settings", lambda: {"image_model": "", "image_gen_enabled": False})
    monkeypatch.setattr(settings_module, "save_settings", lambda values: saved.append(dict(values)))

    class Query:
        def __init__(self, value):
            self.value = value

        def filter(self, *_args, **_kwargs):
            return self

        def first(self):
            return self.value

    class DB:
        def __init__(self, endpoint=None):
            self.endpoint = endpoint

        def query(self, _model):
            return Query(self.endpoint)

    ids = ["sd-cpp-local:owner--model:checkpoint"]
    engine._select_default(DB(), ids)
    assert saved[-1]["image_model"] == f"{ids[0]}@Local images"
    assert saved[-1]["image_gen_enabled"] is False

    saved.clear()
    monkeypatch.setattr(settings_module, "load_settings", lambda: {"image_model": "cloud@remote"})
    engine._select_default(DB(), ids)
    assert saved == []
    monkeypatch.setattr(settings_module, "load_settings", lambda: {"image_model": "manual-selection"})
    engine._select_default(DB(), ids)
    assert saved == []

    legacy = SimpleNamespace(id="img-sdcpp-a1b2c3d4e5f6", name="Legacy images",
                             model_type="image", base_url="http://127.0.0.1:38761/v1")
    monkeypatch.setattr(settings_module, "load_settings",
                        lambda: {"image_model": "sd-cpp-local@Legacy images"})
    monkeypatch.setattr("socket.create_connection", lambda *_args, **_kwargs:
                        (_ for _ in ()).throw(OSError("not listening")))
    engine._select_default(DB(legacy), ids)
    assert saved[-1]["image_model"] == f"{ids[0]}@Local images"

    saved.clear()
    class Connected:
        def __enter__(self): return self
        def __exit__(self, *_args): return False
    monkeypatch.setattr("socket.create_connection", lambda *_args, **_kwargs: Connected())
    engine._select_default(DB(legacy), ids)
    assert saved == []
    engine.close()


class _EngineStub:
    native_token = "native-test-token"

    def __init__(self):
        self.actions = []

    def native_authorized(self, value):
        return value == self.native_token

    def status(self):
        return {"available": True, "running": False, "state": "stopped", "models": []}

    def configure(self, values):
        if "idle_seconds" in values and not 30 <= values["idle_seconds"] <= 3600:
            raise ValueError("Invalid image engine settings")
        self.actions.append(("configure", values))

    def refresh(self):
        self.actions.append(("refresh",))

    def start(self):
        self.actions.append(("start",))

    def stop(self):
        self.actions.append(("stop",))

    def register_endpoint(self):
        self.actions.append(("register",))


def _route_client(monkeypatch, *, admin=None, delegated=False):
    engine = _EngineStub()
    app = FastAPI()
    app.state.local_image_engine = engine
    app.include_router(engine_routes.setup_local_engine_routes())
    admin_calls = []

    def require_admin(request):
        admin_calls.append(request)
        if admin:
            raise admin

    monkeypatch.setattr(engine_routes, "_require_admin", require_admin)
    monkeypatch.setattr(engine_routes, "is_delegated_credential", lambda _request: delegated)
    return TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 43123)), engine, admin_calls


def test_native_route_requires_loopback_no_origin_and_private_token(monkeypatch):
    client, engine, admin_calls = _route_client(monkeypatch)
    path = "/api/local-engines/image"
    assert client.get(path, headers={"X-Novum-Engine-Token": engine.native_token}).status_code == 200
    assert admin_calls == []

    denied = HTTPException(401, "interactive login required")
    monkeypatch.setattr(engine_routes, "_require_admin", lambda _request: (_ for _ in ()).throw(denied))
    assert client.get(path, headers={"X-Novum-Engine-Token": engine.native_token,
                                     "Origin": "http://127.0.0.1"}).status_code == 401
    for proxy_header in ("X-Forwarded-For", "X-Real-IP", "Forwarded", "CF-Connecting-IP"):
        assert client.get(path, headers={"X-Novum-Engine-Token": engine.native_token,
                                         proxy_header: "192.0.2.4"}).status_code == 401
    remote = TestClient(client.app, base_url="http://192.0.2.4", client=("192.0.2.4", 43124))
    assert remote.get(path, headers={"X-Novum-Engine-Token": engine.native_token}).status_code == 401
    assert client.get(path).status_code == 401


def test_native_capability_passes_app_auth_middleware_without_session(monkeypatch):
    import app as application

    if not application.AUTH_ENABLED:
        return
    engine = _EngineStub()
    monkeypatch.setattr(application.app.state, "local_image_engine", engine, raising=False)
    client = TestClient(application.app, base_url="http://127.0.0.1", client=("127.0.0.1", 43125))
    response = client.get("/api/local-engines/image",
                          headers={"X-Novum-Engine-Token": engine.native_token})
    assert response.status_code == 200
    assert response.json()["state"] == "stopped"
    assert client.get("/api/local-engines/image").status_code == 401


def test_delegated_route_cannot_use_admin_fallback(monkeypatch):
    denied = HTTPException(401, "interactive login required")
    client, engine, admin_calls = _route_client(monkeypatch, admin=denied, delegated=True)
    response = client.post("/api/local-engines/image", json={"action": "stop"})
    assert response.status_code == 403
    assert admin_calls == []
    assert engine.actions == []


def test_interactive_controls_validate_actions_and_idle_bounds(monkeypatch):
    client, engine, _ = _route_client(monkeypatch)
    monkeypatch.setattr(engine_routes, "is_delegated_credential", lambda _request: False)
    admin_calls = []
    monkeypatch.setattr(engine_routes, "_require_admin", lambda request: admin_calls.append(request))
    path = "/api/local-engines/image"
    assert client.post(path, json={"action": "start", "mode": "cpu"}).status_code == 400
    assert client.post(path, json={"action": "configure", "idle_seconds": 29}).status_code == 409
    assert client.post(path, json={"action": "configure", "idle_seconds": 30,
                                   "mode": "vulkan", "auto_start": False}).status_code == 200
    assert engine.actions == [("configure", {"mode": "vulkan", "auto_start": False, "idle_seconds": 30}),
                              ("refresh",)]
    assert admin_calls


def test_native_tokens_are_owned_private_files(tmp_path):
    engine = LocalImageEngine(tmp_path)
    token_dir = tmp_path / "engine-manager"
    for name in ("image.token", "native.token"):
        path = token_dir / name
        info = path.stat()
        assert info.st_uid == os.getuid()
        assert info.st_mode & 0o077 == 0
        assert len(path.read_text().strip()) >= 32
    (token_dir / "native.token").chmod(0o644)
    try:
        LocalImageEngine(tmp_path)
    except ValueError as exc:
        assert "Unsafe engine credential storage" in str(exc)
    else:
        raise AssertionError("permissive native token file was accepted")


def test_empty_gateway_starts_stops_and_restarts_without_loading_a_model(tmp_path, monkeypatch):
    engine = LocalImageEngine(tmp_path, scanner=lambda: [])
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        engine.port = sock.getsockname()[1]
    monkeypatch.setattr(engine, "_binary", lambda: ("/bin/false", "cpu"))
    monkeypatch.setattr(engine, "register_endpoint", lambda: None)
    engine.refresh(rows=[])
    try:
        engine.start()
        status = engine.status()
        assert status["running"] is True
        assert status["healthy"] is True
        assert status["models"] == []
        assert status["loaded_model"] is None
        assert status["generation_active"] is False
        assert engine.process is not None
        assert engine.process.poll() is None
        engine.stop()
        assert engine.process is None
        engine.start()
        assert engine.health()["loaded_model"] is None
    finally:
        engine.close()
