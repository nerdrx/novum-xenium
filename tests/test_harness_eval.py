"""Deterministic checks for the same-model benchmark's evidence gates."""
import importlib.util
from pathlib import Path

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "harness_eval.py"
spec = importlib.util.spec_from_file_location("harness_eval", SCRIPT)
harness_eval = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness_eval)


@pytest.mark.parametrize("payload,expected", [
    ("[DONE]", {"done": True}),
    ('{"type":"tool_start","tool":"write_file"}', {"tool_calls": 1}),
    ('{"type":"budget_exceeded"}', {"incomplete": "budget_exceeded"}),
    ('{"type":"loop_breaker_triggered"}', {"incomplete": "loop_breaker_triggered"}),
    ('{"type":"intent_nudge_exhausted"}', {"incomplete": "intent_nudge_exhausted"}),
    ('{"type":"agent_terminal","data":{"failed":true,"failure":{"message":"secret"}}}',
     {"incomplete": "agent_terminal_failed"}),
    ('{"type":"ask_user","data":{"kind":"tool_approval"}}', {"incomplete": "ask_user"}),
    ('{"error":"secret provider payload","status":503}',
     {"stream_error": True, "error_status": 503}),
])
def test_event_parser_records_only_safe_run_facts(payload, expected):
    facts = harness_eval.parse_event("message", payload)
    assert facts == expected
    assert "secret provider payload" not in repr(facts)


def test_sse_error_event_does_not_copy_provider_text():
    facts = harness_eval.parse_event("error", '{"error":"secret","status":500}')
    assert facts == {"stream_error": True, "error_status": 500}
    assert "secret" not in repr(facts)


def test_timeout_stop_targets_only_stream_run():
    seen = []

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    def request(path, **kwargs):
        seen.append((path, kwargs))
        return Response()

    assert harness_eval.stop_exact_run(request, "session-a", "run-a") is True
    assert seen == [("/api/chat/stop/session-a", {
        "headers": {"X-Odysseus-Run-Id": "run-a"}, "timeout": 10,
    })]
    assert harness_eval.stop_exact_run(request, "session-a", None) is False
    assert len(seen) == 1


@pytest.mark.parametrize("case", harness_eval.CASES, ids=lambda case: case["name"])
def test_each_benchmark_case_requires_real_file_assertions(tmp_path, case):
    fixture = tmp_path / case["name"]
    fixture.mkdir()
    for name, content in case["files"].items():
        (fixture / name).write_text(content)
    assert harness_eval.run_file_check(case, fixture).returncode != 0
    assert not harness_eval.case_passes(done=True, errors=[], check_returncode=1, tool_calls=1)
    assert not harness_eval.case_passes(done=True, errors=[], check_returncode=0, tool_calls=0)
    assert not harness_eval.case_passes(done=True, errors=["budget_exceeded"], check_returncode=0, tool_calls=1)
    assert harness_eval.case_passes(done=True, errors=[], check_returncode=0, tool_calls=1)
