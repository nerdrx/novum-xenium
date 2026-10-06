import json

from src.stream_errors import describe_sse_failure, describe_stream_failure, explain_sse_failure


def test_read_timeout_has_actionable_idle_timeout_and_keeps_machine_fields():
    event = "event: error\ndata: " + json.dumps({
        "error": "Read timeout",
        "status": 504,
        "text": "provider explanation",
        "timeout_seconds": 37,
    })

    failure = describe_sse_failure(event)

    assert failure["status"] == 504
    assert failure["timeout_seconds"] == 37
    assert "37-second idle read timeout" in failure["message"]
    assert "HTTP 504" in failure["message"]
    assert "loading or queued" in failure["message"]


def test_http_statuses_get_safe_actionable_reasons():
    expected = {
        401: "Check the configured credentials",
        403: "Check account permissions",
        404: "requested model or endpoint",
        429: "rate limit reached",
        503: "service failed (HTTP 503)",
    }
    for status, reason in expected.items():
        failure = describe_stream_failure("opaque provider response", status)
        assert failure["status"] == status
        assert reason.lower() in failure["message"].lower()


def test_unknown_provider_body_is_never_returned_or_persisted():
    secret_body = "Authorization: Bearer super-secret-token"
    failure = describe_sse_failure(
        "event: error\ndata: " + json.dumps({"text": secret_body, "status": 418})
    )

    assert failure["status"] == 418
    assert secret_body not in json.dumps(failure)


def test_safe_terminal_message_is_stable_when_route_revalidates_it():
    for initial_error, status, timeout in (
        ("Read timeout", 504, 30),
        ("Cannot reach provider", 503, None),
        ("Connection pool timeout", 504, None),
        ("Network error", 502, None),
    ):
        first = describe_stream_failure(initial_error, status, timeout)
        second = describe_stream_failure(
            first["message"], first["status"], first.get("timeout_seconds")
        )
        assert second == first


def test_error_guidance_preserves_transport_fields_and_normal_tokens():
    payload = {"status": 401, "error": "invalid key", "fallback_eligible": False}
    explained = explain_sse_failure("event: error\ndata: " + json.dumps(payload) + "\n\n")
    result = json.loads(explained.split("data: ", 1)[1])
    assert {key: result[key] for key in payload} == payload
    assert "configured credentials" in result["hint"]
    token = 'data: {"delta":"Hello"}\n\n'
    assert explain_sse_failure(token) == token
    assert explain_sse_failure("event: error\ndata: not-json\n\n").endswith("not-json\n\n")


def test_provider_timeout_event_reports_actual_idle_read_budget():
    import httpx
    from src.llm_core import _stream_read_timeout_event

    event = _stream_read_timeout_event(httpx.Timeout(connect=10, read=37, write=30, pool=5))
    payload = json.loads(event.split("data: ", 1)[1])
    assert payload["error"] == "Read timeout"
    assert payload["status"] == 504
    assert payload["timeout_seconds"] == 37
    assert "37-second idle read timeout" in payload["text"]
