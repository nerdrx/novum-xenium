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
        return service._whisper_model

    monkeypatch.setattr(service, "_get_whisper", fake_lazy_load)
    assert service.available is True
    assert loads == [True]
