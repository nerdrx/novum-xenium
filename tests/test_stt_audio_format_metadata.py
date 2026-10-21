from services.stt.stt_service import _audio_format


def test_mp4_mime_and_filename_alias_use_allowlisted_metadata():
    assert _audio_format("audio/mp4;codecs=opus", "audio.m4a") == ("m4a", "audio/mp4")
    assert _audio_format("", "audio.mp4") == ("m4a", "audio/mp4")


def test_legacy_missing_metadata_remains_webm():
    assert _audio_format() == ("webm", "audio/webm")


def test_unknown_metadata_never_becomes_a_path_suffix_or_content_type():
    assert _audio_format("application/x-untrusted", "../../voice.bad/../../payload") == (
        "bin",
        "application/octet-stream",
    )
    assert _audio_format("", "voice.untrusted") == ("bin", "application/octet-stream")


def test_service_passes_detected_container_to_provider_dispatch(monkeypatch):
    from services.stt.stt_service import STTService

    service = STTService()
    monkeypatch.setattr(service, "_load_settings", lambda: {
        "stt_enabled": True,
        "stt_provider": "local",
        "stt_model": "base",
        "stt_language": "",
    })
    seen = []
    monkeypatch.setattr(service, "_transcribe_local", lambda *args: seen.append(args) or "ok")
    assert service.transcribe(b"mp4-bytes", "audio/mp4;codecs=opus", "audio.m4a") == "ok"
    assert seen == [(b"mp4-bytes", "", "m4a")]


def test_local_stt_tempfile_uses_the_native_audio_container():
    from types import SimpleNamespace
    from services.stt.stt_service import STTService

    service = STTService()
    seen = []

    class FakeWhisper:
        def transcribe(self, path, **_kwargs):
            from pathlib import Path

            candidate = Path(path)
            seen.append((candidate.suffix, candidate.read_bytes()))
            return [SimpleNamespace(text="synthetic")], SimpleNamespace(language="en", language_probability=1.0)

    service._get_whisper = lambda: FakeWhisper()
    assert service._transcribe_local(b"mp4-container", extension="m4a") == "synthetic"
    assert seen == [(".m4a", b"mp4-container")]


def test_endpoint_stt_multipart_uses_allowlisted_filename_and_mime(monkeypatch):
    import sys
    from types import SimpleNamespace
    import services.stt.stt_service as module

    captured = {}

    class Query:
        def filter(self, *_args):
            return self

        def first(self):
            return SimpleNamespace(base_url="http://fixture.invalid/v1", api_key="")

    class Database:
        def query(self, *_args):
            return Query()

        def close(self):
            pass

    class FakeEndpoint:
        id = object()

    def fake_post(url, **kwargs):
        captured.update(url=url, **kwargs)
        return SimpleNamespace(raise_for_status=lambda: None, json=lambda: {"text": "fixture"})

    monkeypatch.setitem(
        sys.modules,
        "src.database",
        SimpleNamespace(SessionLocal=Database, ModelEndpoint=FakeEndpoint),
    )
    monkeypatch.setattr(module.httpx, "post", fake_post)
    result = module.STTService()._transcribe_api(
        b"mp4-container", "fixture-id", "whisper-fixture", extension="m4a", content_type="audio/mp4"
    )
    assert result == "fixture"
    assert captured["url"] == "http://fixture.invalid/v1/audio/transcriptions"
    filename, stream, content_type = captured["files"]["file"]
    assert (filename, content_type, stream.read()) == ("audio.m4a", "audio/mp4", b"mp4-container")


def test_stt_route_passes_upload_format_metadata_to_service():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routes.stt_routes import setup_stt_routes

    class FakeService:
        available = True

        def __init__(self):
            self.call = None

        def transcribe(self, audio_bytes, **metadata):
            self.call = (audio_bytes, metadata)
            return "fixture"

    service = FakeService()
    app = FastAPI()
    app.include_router(setup_stt_routes(service))
    response = TestClient(app).post(
        "/api/stt/transcribe",
        files={"file": ("audio.m4a", b"synthetic-mp4", "audio/mp4")},
    )
    assert response.status_code == 200
    assert service.call == (
        b"synthetic-mp4",
        {"content_type": "audio/mp4", "filename": "audio.m4a"},
    )
