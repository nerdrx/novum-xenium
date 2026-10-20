import json

import src.agent_loop as al


def test_native_archive_batch_keeps_one_converted_call_per_block():
    offered = {
        schema["function"]["name"]
        for schema in al.FUNCTION_TOOL_SCHEMAS
        if schema["function"]["name"] == "archive_email"
    }
    calls = [
        {"id": "archive-a", "name": "archive_email", "arguments": '{"uid":"a"}'},
        {"id": "archive-b", "name": "archive_email", "arguments": '{"uid":"b"}'},
    ]

    blocks, used_native, converted = al._resolve_tool_blocks(
        "", calls, 1, is_api_model=True, offered_tool_names=offered,
    )

    assert used_native
    assert [block.tool_type for block in blocks] == [
        "mcp__email__archive_email", "mcp__email__archive_email",
    ]
    assert [call["id"] for call in converted] == ["archive-a", "archive-b"]
    assert len(converted) == len(calls)


def test_native_batch_with_unconvertible_sibling_remains_detectable():
    offered = {"archive_email"}
    calls = [
        {"id": "archive-a", "name": "archive_email", "arguments": '{"uid":"a"}'},
        {"id": "bad", "name": "not_offered", "arguments": "{}"},
    ]

    blocks, used_native, converted = al._resolve_tool_blocks(
        "", calls, 1, is_api_model=True, offered_tool_names=offered,
    )

    assert used_native
    assert [block.tool_type for block in blocks] == ["mcp__email__archive_email"]
    assert [call["id"] for call in converted] == ["archive-a"]
    assert len(converted) != len(calls)


def test_textual_delete_collapse_preserves_mixed_permanent_intent():
    text = "".join(
        '<tool_call>{"name":"delete_email","arguments":'
        + json.dumps({"uid": uid, "permanent": permanent})
        + "}</tool_call>"
        for uid, permanent in (("normal", False), ("permanent", True))
    )

    blocks, used_native, converted = al._resolve_tool_blocks(text, [], 1)

    assert not used_native
    assert converted == []
    assert len(blocks) == 2
    assert [json.loads(block.content)["permanent"] for block in blocks] == [False, True]


def test_textual_delete_collapse_preserves_uniform_permanent_intent():
    for permanent in (False, True):
        text = "".join(
            '<tool_call>{"name":"delete_email","arguments":'
            + json.dumps({"uid": uid, "permanent": permanent})
            + "}</tool_call>"
            for uid in ("a", "b")
        )

        collapsed, used_native, converted = al._resolve_tool_blocks(text, [], 1)

        assert not used_native
        assert converted == []
        assert len(collapsed) == 1
        args = json.loads(collapsed[0].content)
        assert args["uids"] == ["a", "b"]
        assert args.get("permanent", False) is permanent
