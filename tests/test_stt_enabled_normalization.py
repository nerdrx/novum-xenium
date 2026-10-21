import pytest

import src.settings as settings_module
from services.stt.stt_service import STTService


@pytest.mark.parametrize("enabled", [None, 0, "", [], {}, "false", 1])
@pytest.mark.parametrize("provider", ["local", "endpoint:fixture-id", "browser"])
def test_malformed_enabled_values_fail_closed(monkeypatch, enabled, provider):
    saved = {
        "stt_enabled": enabled,
        "stt_provider": provider,
        "stt_model": "base",
        "stt_language": "",
    }
    monkeypatch.setattr(settings_module, "load_settings", lambda: saved)
    service = STTService()

    def unexpected_io(*_args, **_kwargs):
        raise AssertionError("disabled STT must not load a model or call an endpoint")

    monkeypatch.setattr(service, "_get_whisper", unexpected_io)
    monkeypatch.setattr(service, "_transcribe_local", unexpected_io)
    monkeypatch.setattr(service, "_transcribe_api", unexpected_io)

    assert service.available is False
    assert service.get_stats()["provider"] == "disabled"
    assert service.get_stats()["available"] is False
    assert service.transcribe(b"synthetic", "audio/webm", "fixture.webm") is None


def test_missing_enabled_defaults_off_and_true_keeps_provider_dispatch(monkeypatch):
    saved = {
        "stt_provider": "endpoint:fixture-id",
        "stt_model": "fixture-model",
        "stt_language": "",
    }
    monkeypatch.setattr(settings_module, "load_settings", lambda: saved)
    service = STTService()
    assert service.available is False
    assert service.get_stats()["provider"] == "disabled"
    assert service.transcribe(b"synthetic") is None

    saved["stt_enabled"] = True
    calls = []
    monkeypatch.setattr(service, "_transcribe_api", lambda *args: calls.append(args) or "fixture transcript")
    assert service.available is True
    assert service.get_stats()["provider"] == "endpoint:fixture-id"
    assert service.transcribe(b"synthetic") == "fixture transcript"
    assert len(calls) == 1
