import sys
import types

from services.stt.stt_service import STTService


def test_stats_are_metadata_only_and_local_readiness_stays_lazy(monkeypatch):
    cases = [
        ({"stt_enabled": False, "stt_provider": "local", "stt_model": "base", "stt_language": ""}, None,
         {"available": False, "provider": "disabled", "model_loaded": False}),
        ({"stt_enabled": True, "stt_provider": "local", "stt_model": "base", "stt_language": ""}, None,
         {"available": False, "provider": "local", "model_loaded": False}),
        ({"stt_enabled": True, "stt_provider": "local", "stt_model": "base", "stt_language": ""}, object(),
         {"available": True, "provider": "local", "model_loaded": True}),
        ({"stt_enabled": False, "stt_provider": "local", "stt_model": "base", "stt_language": ""}, object(),
         {"available": False, "provider": "disabled", "model_loaded": True}),
        ({"stt_enabled": True, "stt_provider": "browser", "stt_model": "base", "stt_language": ""}, None,
         {"available": True, "provider": "browser", "model": "Browser (Web Speech API)"}),
        ({"stt_enabled": True, "stt_provider": "endpoint:remote", "stt_model": "base", "stt_language": ""}, None,
         {"available": True, "provider": "endpoint:remote", "endpoint_id": "remote"}),
        ({"stt_enabled": True, "stt_provider": "disabled", "stt_model": "base", "stt_language": ""}, None,
         {"available": False, "provider": "disabled"}),
        ({"stt_enabled": True, "stt_provider": "unknown", "stt_model": "base", "stt_language": ""}, None,
         {"available": False, "provider": "unknown"}),
    ]

    for settings, model, expected in cases:
        service = STTService()
        service._whisper_model = model
        service._whisper_model_size = "base" if model is not None else None
        monkeypatch.setattr(service, "_load_settings", lambda settings=settings: settings)

        def no_load_allowed():
            raise AssertionError("get_stats must not initialize Whisper")

        monkeypatch.setattr(service, "_get_whisper", no_load_allowed)
        stats = service.get_stats()
        for key, value in expected.items():
            assert stats[key] == value

    settings = {"stt_enabled": True, "stt_provider": "local", "stt_model": "base", "stt_language": ""}
    service = STTService()
    monkeypatch.setattr(service, "_load_settings", lambda: settings)
    loads = []

    def fake_lazy_load():
        loads.append(True)
        service._whisper_model = object()
        service._whisper_model_size = settings["stt_model"]
        return service._whisper_model

    monkeypatch.setattr(service, "_get_whisper", fake_lazy_load)
    assert service.available is True
    assert loads == [True]


def _install_fake_whisper(monkeypatch):
    constructors = []
    failures = set()

    class FakeWhisperModel:
        def __init__(self, model_size, device, compute_type):
            constructors.append(model_size)
            if model_size in failures:
                raise RuntimeError("synthetic constructor failure")
            self.model_size = model_size
            self.device = device
            self.compute_type = compute_type

    faster_whisper = types.ModuleType("faster_whisper")
    faster_whisper.WhisperModel = FakeWhisperModel
    torch = types.ModuleType("torch")
    torch.cuda = types.SimpleNamespace(is_available=lambda: False)
    monkeypatch.setitem(sys.modules, "faster_whisper", faster_whisper)
    monkeypatch.setitem(sys.modules, "torch", torch)
    return constructors, failures


def test_whisper_cache_tracks_configured_model_and_retries_failed_replacement(monkeypatch):
    constructors, failures = _install_fake_whisper(monkeypatch)
    settings = {"stt_enabled": True, "stt_provider": "local", "stt_model": "base", "stt_language": ""}
    service = STTService()
    monkeypatch.setattr(service, "_load_settings", lambda: dict(settings))

    base_model = service._get_whisper()
    assert service._get_whisper() is base_model
    assert base_model.model_size == "base"
    assert service._whisper_model_size == "base"
    assert constructors == ["base"]

    settings["stt_model"] = "small"
    stale_stats = service.get_stats()
    assert stale_stats["model"] == "small"
    assert stale_stats["model_loaded"] is False
    assert stale_stats["available"] is False
    assert constructors == ["base"]

    failures.add("small")
    assert service._get_whisper() is None
    assert service._whisper_model is None
    assert service._whisper_model_size is None
    assert service.get_stats()["model_loaded"] is False

    failures.remove("small")
    small_model = service._get_whisper()
    assert small_model is not None
    assert small_model.model_size == "small"
    assert small_model is not base_model
    assert service._whisper_model_size == "small"
    assert service._get_whisper() is small_model
    assert constructors == ["base", "small", "small"]
