import httpx
import pytest
from fastapi import FastAPI

from routes import stt_routes
from services.stt.stt_service import STTService


def _app(monkeypatch, *, provider="local", enabled=True, model_available=True):
    monkeypatch.setattr(stt_routes, "STT_MAX_AUDIO_BYTES", 4)
    service = STTService()
    monkeypatch.setattr(service, "_load_settings", lambda: {
        "stt_enabled": enabled,
        "stt_provider": provider,
        "stt_model": "synthetic",
        "stt_language": "",
    })
    calls = {"initialize": 0, "transcribe": []}

    def fake_get_whisper():
        calls["initialize"] += 1
        return object() if model_available else None

    def fake_transcribe(data, **metadata):
        calls["transcribe"].append((data, metadata))
        return "synthetic transcript"

    monkeypatch.setattr(service, "_get_whisper", fake_get_whisper)
    monkeypatch.setattr(service, "transcribe", fake_transcribe)
    app = FastAPI()
    app.include_router(stt_routes.setup_stt_routes(service))
    return app, calls


async def _post(app, payload):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://fixture"
    ) as client:
        return await client.post(
            "/api/stt/transcribe",
            files={"file": ("synthetic.wav", payload, "audio/wav")},
        )


@pytest.mark.parametrize(("payload", "status"), [(b"", 400), (b"12345", 413)])
async def test_disabled_provider_rejects_invalid_upload_before_availability(
    monkeypatch, payload, status
):
    app, calls = _app(monkeypatch, provider="disabled")

    response = await _post(app, payload)

    assert response.status_code == status
    assert calls == {"initialize": 0, "transcribe": []}


@pytest.mark.parametrize(("payload", "status"), [(b"", 400), (b"12345", 413)])
async def test_invalid_local_upload_does_not_initialize_model(monkeypatch, payload, status):
    app, calls = _app(monkeypatch)

    response = await _post(app, payload)

    assert response.status_code == status
    assert calls == {"initialize": 0, "transcribe": []}


async def test_valid_local_upload_initializes_and_transcribes(monkeypatch):
    app, calls = _app(monkeypatch)

    response = await _post(app, b"1234")

    assert response.status_code == 200
    assert response.json() == {"text": "synthetic transcript"}
    assert calls == {
        "initialize": 1,
        "transcribe": [(b"1234", {"content_type": "audio/wav", "filename": "synthetic.wav"})],
    }


async def test_disabled_provider_still_returns_503_for_valid_upload(monkeypatch):
    app, calls = _app(monkeypatch, provider="disabled")

    response = await _post(app, b"1234")

    assert response.status_code == 503
    assert calls == {"initialize": 0, "transcribe": []}


async def test_unavailable_local_model_still_returns_503_for_valid_upload(monkeypatch):
    app, calls = _app(monkeypatch, model_available=False)

    response = await _post(app, b"1234")

    assert response.status_code == 503
    assert calls == {"initialize": 1, "transcribe": []}
