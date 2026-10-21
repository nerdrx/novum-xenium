import src.settings as settings_module
from services.stt.stt_service import STTService


def _settings(monkeypatch, provider, enabled=True):
    values = {
        "stt_enabled": enabled,
        "stt_provider": provider,
        "stt_model": "base",
        "stt_language": "",
    }
    monkeypatch.setattr(settings_module, "load_settings", lambda: values)


def test_malformed_and_empty_provider_values_fail_closed(monkeypatch):
    def no_provider_io(*args, **kwargs):
        raise AssertionError("malformed provider must not load a model or call an endpoint")

    monkeypatch.setattr(STTService, "_get_whisper", no_provider_io)
    monkeypatch.setattr(STTService, "_transcribe_api", no_provider_io)
    for provider in (None, False, True, 7, [], {}, ""):
        _settings(monkeypatch, provider)
        service = STTService()

        assert service.available is False
        stats = service.get_stats()
        assert stats["provider"] == "disabled"
        assert stats["available"] is False
        assert service.transcribe(b"synthetic", "audio/webm", "fixture.webm") is None

        _settings(monkeypatch, provider, enabled=False)
        assert service.available is False
        stats = service.get_stats()
        assert stats["provider"] == "disabled"
        assert stats["available"] is False
        assert service.transcribe(b"synthetic", "audio/webm", "fixture.webm") is None


def test_valid_provider_controls_keep_existing_behavior_without_io(monkeypatch):
    calls = {"endpoint": 0, "whisper": 0}
    service = STTService()

    def no_endpoint(*args, **kwargs):
        calls["endpoint"] += 1
        raise AssertionError("provider stats must not call an endpoint")

    def no_whisper(*args, **kwargs):
        calls["whisper"] += 1
        raise AssertionError("provider stats must not load Whisper")

    monkeypatch.setattr(service, "_transcribe_api", no_endpoint)
    monkeypatch.setattr(service, "_get_whisper", no_whisper)

    _settings(monkeypatch, "disabled")
    assert service.available is False
    assert service.get_stats()["provider"] == "disabled"
    assert service.transcribe(b"synthetic") is None

    _settings(monkeypatch, "browser")
    assert service.available is True
    assert service.get_stats()["available"] is True
    assert service.transcribe(b"synthetic") is None

    _settings(monkeypatch, "endpoint:fixture-id")
    assert service.available is True
    stats = service.get_stats()
    assert stats["provider"] == "endpoint:fixture-id"
    assert stats["endpoint_id"] == "fixture-id"
    assert stats["available"] is True

    _settings(monkeypatch, "future-provider")
    assert service.available is False
    assert service.get_stats()["provider"] == "future-provider"
    assert service.transcribe(b"synthetic") is None
    assert calls == {"endpoint": 0, "whisper": 0}
