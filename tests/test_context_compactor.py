"""Tests for context_compactor.py — constants and prompt templates.
Uses mock imports to avoid loading the full app stack."""

import asyncio
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from src.model_context import estimate_tokens

# Mock heavy dependencies before importing
for mod in [
    'sqlalchemy', 'sqlalchemy.orm', 'sqlalchemy.ext', 'sqlalchemy.ext.declarative',
    'sqlalchemy.ext.hybrid', 'sqlalchemy.sql', 'sqlalchemy.sql.expression',
    'src.database',
    'core.models', 'core.database',
]:
    if mod not in sys.modules:
        sys.modules[mod] = MagicMock()

import src.context_compactor as cc
from src.context_compactor import (
    COMPACT_THRESHOLD,
    SELF_SUMMARY_SYSTEM_PROMPT,
    SUMMARY_MAX_TOKENS,
    _content_as_text,
    maybe_compact,
    native_tool_exchange_fits,
    trim_for_context,
)


@pytest.mark.parametrize("with_exchange", [False, True])
def test_large_preset_cannot_displace_current_request_or_latest_exchange(with_exchange):
    request = {"role": "user", "content": "couldnt you just use the browser?"}
    tail = [request]
    if with_exchange:
        tail += [
            {"role": "assistant", "content": None, "tool_calls": [{
                "id": "open", "type": "function", "function": {
                    "name": "browser_navigate", "arguments": '{"url":"https://github.com/nerdrx/zVram"}',
                },
            }]},
            {"role": "tool", "tool_call_id": "open", "content": "Opened project page.",
             "metadata": {"trusted": False}},
        ]
    messages = [{"role": "system", "content": "Long persona instructions. " * 1000}] + tail
    original_system = messages[0]["content"]
    result = trim_for_context(messages, 800, reserve_tokens=512)
    assert result[-len(tail):] == tail
    assert estimate_tokens(result) + 512 <= 800
    assert messages[0]["content"] == original_system
    assert "Current user message omitted" not in result[0]["content"]


def test_large_latest_native_result_truncates_after_preserving_call_and_notice():
    call = {"role": "assistant", "content": None, "tool_calls": [{
        "id": "latest", "type": "function", "function": {
            "name": "read_file", "arguments": '{"path":"src/app.py"}',
        },
    }]}
    result = {"role": "tool", "tool_call_id": "latest", "content": "source body " * 20_000}
    messages = [
        {"role": "system", "content": "Current instructions. " * 1000},
        {"role": "system", "content": "Protected coding guidance. " * 100, "_protected": True},
        {"role": "user", "content": "Inspect and fix the source."},
        call,
        result,
    ]

    trimmed = trim_for_context(messages, context_length=2800, reserve_tokens=1800)
    actual_call = next(message for message in trimmed if message.get("role") == "assistant")
    actual_result = next(message for message in trimmed if message.get("role") == "tool")

    assert actual_call == call
    assert actual_result["tool_call_id"] == "latest"
    assert actual_result["content"] != result["content"]
    assert "truncated to fit context" in actual_result["content"].lower()
    assert estimate_tokens(trimmed) + 1800 <= 2800


def test_small_multi_result_shares_fall_back_to_notice_without_dropping_calls(monkeypatch):
    call = {"role": "assistant", "content": None, "tool_calls": [
        {"id": f"latest-{index}", "type": "function", "function": {
            "name": "read_file", "arguments": f'{{"path":"src/{index}.py"}}',
        }}
        for index in range(3)
    ]}
    results = [
        {"role": "tool", "tool_call_id": f"latest-{index}", "content": "SOURCE-EVIDENCE " * 1000}
        for index in range(3)
    ]
    marker = "[Tool result truncated to fit context.]"
    baseline = [
        {"role": "system", "content": "System."},
        {"role": "system", "content": "Protected guidance " * 100, "_protected": True},
        {"role": "user", "content": "Inspect the source."},
        call,
        *[{**message, "content": marker} for message in results],
    ]
    # Leave about 45 content tokens per result. The shared truncator's
    # 200-character floor would exceed that slice, so each output must use the
    # short omission notice while retaining every native result id.
    context_length = estimate_tokens(baseline) + 3 * 45 + 512
    original_truncate = cc._truncate_message_to_token_budget
    result_shares = []

    def record_result_share(message, share):
        if message.get("role") == "tool":
            result_shares.append(share)
        return original_truncate(message, share)

    monkeypatch.setattr(cc, "_truncate_message_to_token_budget", record_result_share)

    trimmed = trim_for_context(baseline[:4] + results, context_length, reserve_tokens=512)

    actual_call = next(message for message in trimmed if message.get("role") == "assistant")
    actual_results = [message for message in trimmed if message.get("role") == "tool"]
    assert actual_call == call
    assert [message["tool_call_id"] for message in actual_results] == [
        f"latest-{index}" for index in range(3)
    ]
    assert all(message["content"] == marker for message in actual_results)
    assert result_shares and all(33 <= share <= 63 for share in result_shares)
    assert estimate_tokens(trimmed) + 512 <= context_length


class TestCompactThreshold:
    def test_value(self):
        assert COMPACT_THRESHOLD == 0.85

    def test_summary_max_tokens(self):
        assert SUMMARY_MAX_TOKENS == 1024


class TestSelfSummaryPrompt:
    def test_contains_goal_section(self):
        assert "### User Goal" in SELF_SUMMARY_SYSTEM_PROMPT

    def test_contains_what_was_done_section(self):
        assert "### What Was Done" in SELF_SUMMARY_SYSTEM_PROMPT

    def test_contains_current_state_section(self):
        assert "### Current State" in SELF_SUMMARY_SYSTEM_PROMPT

    def test_contains_pending_section(self):
        assert "### Pending / Next Steps" in SELF_SUMMARY_SYSTEM_PROMPT

    def test_contains_key_context_section(self):
        assert "### Key Context" in SELF_SUMMARY_SYSTEM_PROMPT

    def test_count_placeholder(self):
        assert "{count}" in SELF_SUMMARY_SYSTEM_PROMPT

    def test_n_placeholder(self):
        assert "{n}" in SELF_SUMMARY_SYSTEM_PROMPT

    def test_mentions_compactions(self):
        assert "Compactions so far" in SELF_SUMMARY_SYSTEM_PROMPT


class TestTrimForContext:
    def test_near_full_budget_keeps_complete_latest_small_file_read(self):
        file_text = "{\"name\":\"nflix\",\"scripts\":{},\"note\":\"" + ("x" * 1300) + "\"}"
        formatted = f"### Read file\n```\n{file_text}\n```"
        user_request = {"role": "user", "content": "Inspect package.json."}
        tool_call = {
            "role": "assistant", "content": None, "tool_calls": [{
                "id": "read-1", "type": "function",
                "function": {"name": "read_file", "arguments": '{"path":"package.json"}'},
            }],
        }
        tool_result = {"role": "tool", "tool_call_id": "read-1", "content": formatted}
        messages = [
            {"role": "system", "_agent_injected": "prompt", "content": "Agent instructions. " * 600},
            {"role": "system", "_coding_guidance": True, "content": "Read in small steps."},
            {"role": "system", "content": "Relevant memory context."},
            *[
                item
                for _ in range(18)
                for item in (
                    {"role": "user", "content": f"Old request {_}"},
                    {"role": "assistant", "content": "Old conversation detail. " * 350},
                )
            ],
            user_request,
            tool_call,
            tool_result,
        ]

        base_messages = messages[:-2]
        candidate = [*base_messages, tool_call, tool_result]
        assert native_tool_exchange_fits(
            base_messages, candidate, input_budget=15_534, schema_tokens=300,
        )
        assert not native_tool_exchange_fits(
            base_messages, candidate, input_budget=128,
        )
        trimmed = trim_for_context(
            [
                {**message, "_protected": True} if message.get("role") == "system" else message
                for message in candidate
            ],
            context_length=15_234,
            reserve_tokens=0,
        )

        assert estimate_tokens(trimmed) <= 15_234
        assert tool_call in trimmed
        assert tool_result in trimmed
        assert messages[0] in [{key: value for key, value in item.items() if key != "_protected"} for item in trimmed]
        assert messages[1] in [{key: value for key, value in item.items() if key != "_protected"} for item in trimmed]
        assert messages[2] in [{key: value for key, value in item.items() if key != "_protected"} for item in trimmed]
        assert user_request in trimmed
        assert file_text in next(m["content"] for m in trimmed if m.get("tool_call_id") == "read-1")
        assert not any("truncated" in str(m.get("content", "")).lower() for m in trimmed[-2:])

    def test_native_exchange_fit_requires_every_tool_result_in_batch(self):
        messages = [
            {"role": "system", "content": "Instructions."},
            {"role": "user", "content": "Read both files."},
        ]
        assistant = {
            "role": "assistant", "content": None,
            "tool_calls": [
                {"id": "one", "type": "function", "function": {"name": "read_file", "arguments": "{}"}},
                {"id": "two", "type": "function", "function": {"name": "read_file", "arguments": "{}"}},
            ],
        }
        first = {"role": "tool", "tool_call_id": "one", "content": "first result"}
        second = {"role": "tool", "tool_call_id": "two", "content": "second result"}

        assert not native_tool_exchange_fits(
            messages, [*messages, assistant, first], input_budget=4096,
        )
        assert native_tool_exchange_fits(
            messages, [*messages, assistant, first, second], input_budget=4096,
        )

    def test_injected_datetime_does_not_replace_current_user(self):
        question = {"role": "user", "content": "Find me a free online image generator."}
        messages = [
            {"role": "system", "content": "Help the user."},
            question,
            {"role": "user", "content": "Current date and time. " * 1500,
             "_agent_injected": "context"},
        ]
        trimmed = trim_for_context(messages, context_length=1024, reserve_tokens=256)
        assert question in trimmed
        assert estimate_tokens(trimmed) <= 768

    def test_system_truncation_preserves_internal_route_metadata(self):
        messages = [
            {
                "role": "system",
                "content": "persona\n\n" + ("agent prompt " * 2000),
                "_agent_injected": "merged_prompt",
                "_agent_base_message": {"role": "system", "content": "persona"},
            },
            {"role": "user", "content": "latest"},
        ]

        trimmed = trim_for_context(messages, context_length=1024, reserve_tokens=256)

        system = next(message for message in trimmed if message.get("role") == "system")
        assert system["_agent_injected"] == "merged_prompt"
        assert system["_agent_base_message"] == {"role": "system", "content": "persona"}

    def test_keeps_current_large_user_message_by_truncating(self):
        huge = "A" * 20000
        messages = [
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": huge},
        ]

        trimmed = trim_for_context(messages, context_length=2048, reserve_tokens=512)

        user_msgs = [m for m in trimmed if m.get("role") == "user"]
        assert len(user_msgs) == 1
        content = user_msgs[0]["content"]
        assert "pasted message was too large" in content
        assert content.startswith("A")
        assert len(content) < len(huge)

    def test_drops_older_messages_before_latest_user_paste(self):
        huge = "B" * 12000
        messages = [{"role": "system", "content": "You are helpful."}]
        messages.extend({"role": "user", "content": f"old-{i} " + ("x" * 1000)} for i in range(8))
        messages.append({"role": "user", "content": huge})

        trimmed = trim_for_context(messages, context_length=2048, reserve_tokens=512)

        assert trimmed[-1]["role"] == "user"
        assert "pasted message was too large" in trimmed[-1]["content"]
        assert "old-0" not in "\n".join(str(m.get("content", "")) for m in trimmed)

    def test_keeps_latest_user_and_complete_recent_tool_batches_within_budget(self):
        messages = [{"role": "system", "content": "You are helpful."}]
        messages.extend(
            {"role": "user", "content": f"old-{i} " + ("x" * 900)}
            for i in range(8)
        )
        messages.append({"role": "user", "content": "LATEST_USER_REQUEST_MARKER"})
        for round_no in range(8):
            calls = [
                {"id": f"r{round_no}-c{call_no}", "type": "function",
                 "function": {"name": "web_fetch", "arguments": "{}"}}
                for call_no in range(3)
            ]
            messages.append({"role": "assistant", "content": None, "tool_calls": calls})
            messages.extend(
                {"role": "tool", "tool_call_id": call["id"],
                 "content": f"round-{round_no}-result " + ("result " * 450)}
                for call in calls
            )

        budget = 2048 - 256
        trimmed = trim_for_context(messages, context_length=2048, reserve_tokens=256)

        assert estimate_tokens(trimmed) <= budget
        assert any(
            m.get("role") == "user" and "LATEST_USER_REQUEST_MARKER" in m.get("content", "")
            for m in trimmed
        )
        assert not any(
            "old-" in str(message.get("content", ""))
            and message.get("_agent_injected") != "task_anchor"
            for message in trimmed
        )
        for i, message in enumerate(trimmed):
            if message.get("role") == "tool":
                assert i > 0 and trimmed[i - 1].get("role") in {"assistant", "tool"}
            if message.get("role") == "assistant" and message.get("tool_calls"):
                call_ids = {call["id"] for call in message["tool_calls"]}
                tool_results = []
                for following in trimmed[i + 1:]:
                    if following.get("role") != "tool":
                        break
                    tool_results.append(following.get("tool_call_id"))
                assert set(tool_results) == call_ids
        assert "round-7-result" in "\n".join(str(m.get("content", "")) for m in trimmed)

    def test_preserves_bounded_original_task_with_short_followup_and_recent_tools(self):
        original = {
            "role": "user",
            "content": "Find recent news about me, excluding DeviantArt and unrelated mentions. " * 80,
            "metadata": {"request_id": "original-task", "trusted": True},
        }
        calls = [
            {"id": f"browser-{index}", "type": "function", "function": {
                "name": "browser_navigate", "arguments": "{}",
            }}
            for index in range(2)
        ]
        messages = [
            {"role": "system", "content": "Long agent instructions. " * 360},
            original,
            {"role": "assistant", "content": "Old search and tool output. " * 1800},
            {"role": "user", "content": "you can do it"},
            {"role": "assistant", "content": None, "tool_calls": calls},
            *[
                {"role": "tool", "tool_call_id": call["id"],
                 "content": f"Recent browser result {index}. " + ("page detail " * 120)}
                for index, call in enumerate(calls)
            ],
        ]

        budget = 4096 - 512
        trimmed = trim_for_context(messages, context_length=4096, reserve_tokens=512)

        user_messages = [message for message in trimmed if message.get("role") == "user"]
        assert len(user_messages) == 2
        assert user_messages[0]["metadata"] == original["metadata"]
        assert "Find recent news about me" in user_messages[0]["content"]
        assert estimate_tokens([user_messages[0]]) <= 512
        assert user_messages[-1]["content"] == "you can do it"
        assert estimate_tokens(trimmed) <= budget
        assert not any(
            message.get("role") == "assistant"
            and "Old search and tool output" in str(message.get("content", ""))
            for message in trimmed
        )
        anchor_index = trimmed.index(user_messages[0])
        latest_index = trimmed.index(user_messages[-1])
        assert anchor_index < latest_index
        tool_call_index = next(
            i for i, message in enumerate(trimmed)
            if message.get("role") == "assistant" and message.get("tool_calls")
        )
        assert tool_call_index > latest_index
        assert [message.get("tool_call_id") for message in trimmed[tool_call_index + 1:]] == [
            call["id"] for call in calls
        ]

    def test_tight_budget_truncates_but_never_drops_latest_user_prompt(self):
        messages = [
            {"role": "system", "content": "Be helpful."},
            {"role": "user", "content": "latest " + ("important " * 2000)},
            {"role": "assistant", "content": "old reply " * 300},
            {"role": "user", "content": "new request marker " + ("details " * 2000)},
        ]

        budget = 256 - 128
        trimmed = trim_for_context(messages, context_length=256, reserve_tokens=128)

        latest = next(m for m in trimmed if m.get("role") == "user")
        assert "new request marker" in latest["content"]
        assert len(latest["content"]) < len(messages[-1]["content"])
        assert estimate_tokens(trimmed) <= budget
        assert not any(m.get("role") == "assistant" for m in trimmed)

    def test_legacy_tool_result_wrappers_do_not_replace_user_anchor(self):
        from src.prompt_security import untrusted_context_message
        messages = [
            {"role": "user", "content": "MY_ACTUAL_QUESTION"},
            {"role": "assistant", "content": "fetching pages"},
            untrusted_context_message("tool execution results", "page data " * 3000),
        ]
        trimmed = trim_for_context(messages, context_length=1024, reserve_tokens=128)
        assert any(m.get("content") == "MY_ACTUAL_QUESTION" for m in trimmed)
        assert estimate_tokens(trimmed) <= 896

    @pytest.mark.parametrize("context_length", [16, 32, 64])
    def test_very_small_budget_keeps_nonempty_user_query(self, context_length):
        trimmed = trim_for_context([{"role": "user", "content": "question " * 1000}],
                                   context_length=context_length, reserve_tokens=8)
        assert trimmed[0]["content"].strip()
        assert estimate_tokens(trimmed) <= context_length - 8


class TestContentAsText:
    def test_string_passthrough(self):
        assert _content_as_text("hello") == "hello"

    def test_none_returns_empty(self):
        # Assistant turns that carried only native tool_calls persist
        # content as None — flattening must not raise.
        assert _content_as_text(None) == ""

    def test_list_content_joins_text_blocks(self):
        content = [
            {"type": "text", "text": "describe this"},
            {"type": "image_url", "image_url": {"url": "data:..."}},
        ]
        assert _content_as_text(content) == "describe this"

    def test_unknown_type_returns_empty(self):
        assert _content_as_text(42) == ""


class TestMaybeCompactFourthMessage:
    """Regression: a multi-message conversation must not crash compaction when
    a prior assistant turn used native tool_calls (content == None). This was
    the '4th message stops working' bug — on a small-context model the soft
    85% threshold is crossed after a few turns, and the older half being
    summarized contained a None-content assistant message, which raised
    TypeError: 'NoneType' object is not subscriptable and broke the request."""

    def _run(self, messages, *, context_length=500):
        # Force compaction to trigger and stub the summary LLM call so the test
        # is hermetic (no network, no real endpoint resolution).
        orig_ctx = cc.get_context_length
        orig_call = cc.llm_call_async
        orig_resolve = cc.resolve_endpoint
        orig_update = cc._update_session_history

        async def _fake_summary(*a, **k):
            return "compact summary text"

        cc.get_context_length = lambda url, model: context_length
        cc.llm_call_async = _fake_summary
        cc.resolve_endpoint = lambda which, owner=None: (None, None, None)
        cc._update_session_history = lambda *a, **k: None
        try:
            return asyncio.run(
                maybe_compact(
                    session=None,
                    endpoint_url="http://local/v1/chat/completions",
                    model="local-model",
                    messages=list(messages),
                    headers={},
                )
            )
        finally:
            cc.get_context_length = orig_ctx
            cc.llm_call_async = orig_call
            cc.resolve_endpoint = orig_resolve
            cc._update_session_history = orig_update

    def _four_turn_history_with_tool_call(self):
        # Large system prompt so the conversation crosses the 85% threshold of
        # the tiny (context_length=500) window used in _run, forcing the real
        # compaction branch to execute.
        return [
            {"role": "system", "content": "You are a helpful agent. " * 200},
            {"role": "user", "content": "turn 1: search the web"},
            # Native tool call → content is None (matches agent_loop persistence)
            {"role": "assistant", "content": None,
             "tool_calls": [{"id": "c1", "type": "function",
                             "function": {"name": "web_search", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "c1", "content": "search results"},
            {"role": "assistant", "content": "Here is what I found."},
            {"role": "user", "content": "turn 2"},
            {"role": "assistant", "content": "reply 2"},
            {"role": "user", "content": "turn 3"},
            {"role": "assistant", "content": "reply 3"},
            {"role": "user", "content": "turn 4 — previously broke here"},
        ]

    def test_does_not_crash_on_none_content_turn(self):
        # Must not raise TypeError; returns the 3-tuple contract.
        result = self._run(self._four_turn_history_with_tool_call())
        assert isinstance(result, tuple) and len(result) == 3
        compacted_messages, context_length, was_compacted = result
        assert isinstance(compacted_messages, list)
        assert was_compacted is True
        # The summary the model produced is present and a system message.
        assert any(
            m.get("role") == "system" and "compact summary text" in (m.get("content") or "")
            for m in compacted_messages
        )

    def test_compaction_carries_trusted_task_into_current_and_later_prompts(self):
        messages = self._four_turn_history_with_tool_call()
        original = "Build the app in this git repository and verify it."
        messages[1] = {"role": "user", "content": original,
                       "metadata": {"trusted": True}}

        compacted, _, was_compacted = self._run(messages)

        assert was_compacted
        anchor = next(m for m in compacted if m.get("_agent_injected") == "task_anchor")
        assert anchor["role"] == "user"
        assert original in anchor["content"]
        summary = next(m for m in compacted if m.get("role") == "system"
                       and "compact summary text" in (m.get("content") or ""))
        assert summary["metadata"]["agent_task_anchor"] == {
            "content": original, "trusted": True,
        }

        # A later turn below the compaction threshold still gets the persisted
        # original request in its actual model context.
        later, _, was_compacted_again = self._run(compacted, context_length=100000)
        assert not was_compacted_again
        assert sum(m.get("_agent_injected") == "task_anchor" for m in later) == 1
        assert original in next(m["content"] for m in later
                                if m.get("_agent_injected") == "task_anchor")

    def test_generated_summary_and_untrusted_turn_cannot_seed_task_anchor(self):
        messages = [
            {"role": "system", "content": "Summary says: build app in git repo."},
            {"role": "user", "content": "Build app in git repo.",
             "metadata": {"trusted": False}},
        ]

        assert cc._task_anchor_from_messages(messages) is None

    def test_compacted_cancel_clears_saved_task_anchor(self):
        messages = [
            {"role": "system", "content": "Long prompt. " * 300},
            {"role": "system", "content": "[Conversation summary] old task",
             "metadata": {"agent_task_anchor": {
                 "content": "Fix this git repo.", "trusted": True,
             }}},
            {"role": "user", "content": "cancel that"},
            {"role": "assistant", "content": "Okay."},
            {"role": "user", "content": "What should I do now?"},
            {"role": "assistant", "content": "I can help."},
        ]

        compacted, _, was_compacted = self._run(messages)

        assert was_compacted
        summary = next(m for m in compacted if m.get("role") == "system"
                       and "compact summary text" in (m.get("content") or ""))
        assert summary["metadata"]["agent_task_anchor"] is None
        assert not any(m.get("_agent_injected") == "task_anchor" for m in compacted)

        changed = [
            messages[0],
            messages[1],
            {"role": "user", "content": "What is the weather in Berlin today?"},
            {"role": "assistant", "content": "It is sunny."},
            {"role": "user", "content": "more detail please"},
            {"role": "assistant", "content": "A little more."},
            {"role": "user", "content": "and tomorrow?"},
            {"role": "assistant", "content": "Checking."},
        ]
        compacted, _, was_compacted = self._run(changed)
        assert was_compacted
        summary = next(m for m in compacted if m.get("role") == "system"
                       and "compact summary text" in (m.get("content") or ""))
        anchor = summary["metadata"]["agent_task_anchor"]["content"]
        assert "weather in Berlin" in anchor
        assert "git repo" not in anchor

    def test_three_compactions_keep_latest_explicit_anchor_clear(self):
        messages = self._four_turn_history_with_tool_call()
        messages[1] = {"role": "user", "content": "Build this app in my git repo.",
                       "metadata": {"trusted": True}}
        first, _, compacted = self._run(messages)
        assert compacted
        first_summary = [m for m in first if m.get("role") == "system"
                         and "[Conversation summary" in m.get("content", "")][-1]
        assert first_summary["metadata"]["agent_task_anchor"]["trusted"] is True

        second_input = first + [
            {"role": "user", "content": "cancel that"},
            {"role": "assistant", "content": "Okay."},
            {"role": "user", "content": "What should I do now?"},
            {"role": "assistant", "content": "I can help."},
            {"role": "user", "content": "tell me more"},
            {"role": "assistant", "content": "More detail."},
            {"role": "user", "content": "and then?"},
            {"role": "assistant", "content": "Then this."},
            {"role": "user", "content": "keep going"},
        ]
        second, _, compacted = self._run(second_input)
        assert compacted
        second_summary = [m for m in second if m.get("role") == "system"
                          and "[Conversation summary" in m.get("content", "")][-1]
        assert second_summary["metadata"]["agent_task_anchor"] is None

        third_input = second + [
            {"role": "user", "content": "do your thing"},
            {"role": "assistant", "content": "Sure."},
            {"role": "user", "content": "continue"},
            {"role": "assistant", "content": "Continuing."},
        ]
        third, _, compacted = self._run(third_input)
        assert compacted
        summaries = [m for m in third if m.get("role") == "system"
                     and "[Conversation summary" in m.get("content", "")]
        assert len(summaries) >= 3
        latest_anchor = summaries[-1]["metadata"]["agent_task_anchor"]
        assert not latest_anchor or "git repo" not in latest_anchor["content"]

    def test_repeated_compaction_keeps_history_indexes_aligned(self, monkeypatch):
        messages = self._four_turn_history_with_tool_call()
        messages[1] = {"role": "user", "content": "Build this app in my git repo.",
                       "metadata": {"trusted": True}}
        session = SimpleNamespace(history=list(messages), id=None)
        monkeypatch.setattr(cc, "get_context_length", lambda *args: 500)
        monkeypatch.setattr(cc, "resolve_endpoint", lambda *args, **kwargs: (None, None, None))
        monkeypatch.setattr(cc, "llm_call_async", lambda *args, **kwargs: None)
        monkeypatch.setattr(cc, "ChatMessage", lambda **kwargs: kwargs)
        monkeypatch.setattr(sys.modules["core.models"], "get_session_manager_instance",
                            lambda: None, raising=False)

        async def compact(messages_to_compact):
            async def summary(*args, **kwargs):
                return "compact summary text"
            monkeypatch.setattr(cc, "llm_call_async", summary)
            return await cc.maybe_compact(
                session, "http://local/v1", "local", messages_to_compact,
            )

        compacted, _, first = asyncio.run(compact(messages))
        assert first
        assert session.history[-1]["content"] == "turn 4 — previously broke here"
        assert not any(m.get("_agent_injected") == "task_anchor" for m in session.history)

        compacted_again, _, second = asyncio.run(compact(compacted))
        assert second
        assert session.history[-1]["content"] == "turn 4 — previously broke here"
        assert not any(m.get("_agent_injected") == "task_anchor" for m in session.history)
        summary = next(m for m in session.history if m.get("role") == "system"
                       and "[Conversation summary]" in m.get("content", ""))
        assert summary["metadata"]["agent_task_anchor"]["trusted"] is True

    def test_handles_multimodal_list_content(self):
        messages = self._four_turn_history_with_tool_call()
        messages[1] = {"role": "user", "content": [
            {"type": "text", "text": "look at this image"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,xxxx"}},
        ]}
        result = self._run(messages)
        assert len(result) == 3 and result[2] is True


@pytest.mark.asyncio
async def test_deferred_compaction_persists_only_after_route_commit(monkeypatch):
    updates = []
    state = {}
    messages = [
        {"role": "system", "content": "system " * 100},
        {"role": "user", "content": "one"},
        {"role": "assistant", "content": "two"},
        {"role": "user", "content": "three"},
        {"role": "assistant", "content": "four"},
        {"role": "user", "content": "five"},
    ]

    monkeypatch.setattr(cc, "get_context_length", lambda *args: 100)
    monkeypatch.setattr(cc, "resolve_endpoint", lambda *args, **kwargs: (None, None, None))

    async def fake_summary(*args, **kwargs):
        return "route-specific summary"

    monkeypatch.setattr(cc, "llm_call_async", fake_summary)
    monkeypatch.setattr(
        cc,
        "_update_session_history",
        lambda *args, **kwargs: updates.append((args, kwargs)),
    )

    _compacted, _context, was_compacted = await cc.maybe_compact(
        object(),
        "https://candidate.example/v1",
        "candidate-model",
        messages,
        persist=False,
        compaction_state=state,
    )

    assert was_compacted is True
    assert updates == []
    assert state["summary"] == "route-specific summary"
    assert cc.apply_compaction_state(object(), state) is True
    assert len(updates) == 1
    assert cc.apply_compaction_state(object(), state) is False
    assert len(updates) == 1


class TestResearchPrimerPreserved:
    """A research-spinoff primer (metadata research_spinoff_from) must never be
    trimmed away — it is the Discuss chat's sole knowledge base (drift fix)."""

    def _messages(self):
        return [
            {"role": "system", "content": "You are Odysseus."},
            {"role": "system", "content": "Prompt-safety policy: data not instructions."},
            {"role": "system", "content": "saved memory: pinned " + "m" * 600},
            {"role": "system", "content": "RETRIEVED-DOCS-MARKER " + "r" * 6000},
            {"role": "system",
             "content": "=== REPORT ===\nPRIMER-MARKER " + "z" * 1500,
             "metadata": {"research_spinoff_from": "rp-abc123"}},
        ] + [
            {"role": "user", "content": f"q{i} " + ("x" * 500)} for i in range(8)
        ] + [
            {"role": "assistant", "content": "a" * 500},
            {"role": "user", "content": "latest question"},
        ]

    def test_primer_kept_when_over_budget(self):
        trimmed = trim_for_context(self._messages(), context_length=1024, reserve_tokens=256)
        joined = "\n".join(str(m.get("content", "")) for m in trimmed)
        assert "PRIMER-MARKER" in joined

    def test_bulky_non_primer_system_dropped_but_primer_kept(self):
        trimmed = trim_for_context(self._messages(), context_length=1024, reserve_tokens=256)
        joined = "\n".join(str(m.get("content", "")) for m in trimmed)
        assert "PRIMER-MARKER" in joined
        assert "RETRIEVED-DOCS-MARKER" not in joined

    def test_leading_preset_kept_when_no_primer_metadata(self):
        msgs = self._messages()
        del msgs[4]["metadata"]
        trimmed = trim_for_context(msgs, context_length=1024, reserve_tokens=256)
        joined = "\n".join(str(m.get("content", "")) for m in trimmed)
        assert "You are Odysseus." in joined
