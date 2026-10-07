"""Upstream-error formatting for provider setup (REAL src.llm_core).

Split from `test_provider_classification.py` to keep error-message formatting
separate from provider identification.

  * `_format_upstream_error` — turns a raw upstream HTTP status + body into the
    one-line, provider-aware message the UI shows ("Provider probes" degraded
    reporting in the roadmap).

conftest.py stubs the heavy deps (sqlalchemy, src.database), so importing the
real module is side-effect free.
"""
from src.llm_core import _format_upstream_error, _safe_error_url


# ── _format_upstream_error ──
# Status + body → one-line provider-aware sentence.

class TestFormatUpstreamError:
    def test_401_rejects_key_with_provider_and_detail(self):
        msg = _format_upstream_error(
            401, '{"error": {"message": "Invalid API key"}}', "https://api.x.ai/v1"
        )
        assert msg.startswith("xAI rejected the API key")
        assert "Invalid API key" in msg
        assert "re-paste the key" in msg

    def test_403_denies_access(self):
        msg = _format_upstream_error(
            403, '{"error": {"message": "Forbidden"}}', "https://api.openai.com/v1"
        )
        assert "OpenAI denied access (403)" in msg
        assert "Forbidden" in msg

    def test_404_points_at_base_url(self):
        msg = _format_upstream_error(404, "", "https://api.groq.com/openai/v1")
        assert msg == "Groq returned 404 — check the base URL and model name."

    def test_429_rate_limited(self):
        msg = _format_upstream_error(
            429, '{"error": {"message": "slow down"}}', "https://api.anthropic.com"
        )
        assert msg.startswith("Anthropic rate-limited the request (429).")
        assert "slow down" in msg

    def test_5xx_reported_as_outage(self):
        msg = _format_upstream_error(503, "", "https://api.deepseek.com")
        assert msg == "DeepSeek is having an outage (HTTP 503)."

    def test_other_status_passthrough(self):
        msg = _format_upstream_error(418, "", "https://api.openai.com/v1")
        assert msg == "OpenAI returned HTTP 418"

    def test_string_error_field(self):
        msg = _format_upstream_error(401, '{"error": "bad key"}', "https://api.openai.com/v1")
        assert "bad key" in msg

    def test_plain_text_body_used_as_detail(self):
        msg = _format_upstream_error(500, "upstream exploded", "https://api.openai.com/v1")
        assert "OpenAI is having an outage (HTTP 500)." in msg
        assert "upstream exploded" in msg

    def test_bytes_body_is_decoded(self):
        msg = _format_upstream_error(
            401, b'{"error": {"message": "nope"}}', "https://api.openai.com/v1"
        )
        assert "nope" in msg

    def test_bearer_echo_is_redacted_but_status_guidance_remains(self):
        msg = _format_upstream_error(
            502,
            '{"error":{"message":"proxy echoed Bearer synthetic-secret-123"}}',
            "https://api.openai.com/v1",
        )
        assert "HTTP 502" in msg
        assert "proxy echoed Bearer [redacted]" in msg
        assert "synthetic-secret-123" not in msg

    def test_current_sensitive_header_value_is_redacted(self):
        msg = _format_upstream_error(
            500,
            '{"error":{"message":"proxy received synthetic-api-secret"}}',
            "https://api.openai.com/v1",
            headers={"x-api-key": "synthetic-api-secret"},
        )
        assert "OpenAI is having an outage (HTTP 500)." in msg
        assert "proxy received [redacted]" in msg
        assert "synthetic-api-secret" not in msg

    def test_url_key_echo_and_nonstring_error_detail_are_safe(self):
        url = "https://generativelanguage.googleapis.com/v1beta/models?key=synthetic-gemini-key"
        msg = _format_upstream_error(
            429,
            '{"error":{"message":{"detail":"synthetic-gemini-key"}}}',
            url,
        )
        assert "429" in msg
        assert "synthetic-gemini-key" not in msg
        assert "detail" in msg
        assert "key=%5Bredacted%5D" in _safe_error_url(url)

    def test_unknown_url_falls_back_to_generic_label(self):
        msg = _format_upstream_error(401, "", "")
        assert msg.startswith("provider rejected the API key")
