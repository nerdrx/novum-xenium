import asyncio
import json
import re
from types import SimpleNamespace

import pytest

from src.agent_runtime.authority import ExactOperation, create_request_authority, request_authority_for_http
from src.agent_tools import TOOL_HANDLERS
from src.agent_tools import ToolBlock
from src.agent_tools.handbook_tools import (
    HANDBOOK_ROOT,
    ReadHandbookTool,
    read_handbook,
)
from src.agent_loop import _assemble_prompt
from src.tool_capabilities import ResultIntegrity, ToolEffect, capabilities_for_tool
from src.tool_parsing import parse_tool_blocks
from src.tool_schemas import FUNCTION_TOOL_SCHEMAS, function_call_to_tool_block
from src.tool_security import PLAN_MODE_READONLY_TOOLS, is_public_blocked_tool
from src.tool_types import TOOL_TAGS
from src.tool_policy import ToolPolicy, build_effective_tool_policy
from src.tool_execution import NO_TOOL_SECURITY_CONTEXT, execute_tool_block
from src.turn_contract import resolve_full_inventory_contract, resolve_turn_contract


def _execute(args):
    return asyncio.run(ReadHandbookTool().execute(json.dumps(args), {}))


def _function_schema():
    return next(
        schema["function"]
        for schema in FUNCTION_TOOL_SCHEMAS
        if schema.get("function", {}).get("name") == "read_handbook"
    )


def test_handbook_tool_searches_index_and_reads_bounded_cited_pages():
    assert "read_handbook" in TOOL_HANDLERS
    assert TOOL_HANDLERS["read_handbook"].__func__ is ReadHandbookTool.execute

    index = _execute({})
    assert index["exit_code"] == 0
    assert index["untrusted_content"] is True
    assert "Page index" in index["output"]
    assert "troubleshooting/models.md" in index["output"]
    assert "documentation, not live diagnostics" in index["output"]
    assert len(index["output"]) <= 12_000

    search = _execute({"query": "troubleshooting model endpoint"})
    assert search["exit_code"] == 0
    assert "troubleshooting/models.md" in search["output"]
    assert "Search snippets" in search["output"]
    assert len(search["output"]) <= 12_000

    page = _execute({"page": "troubleshooting/models.md"})
    assert page["exit_code"] == 0
    assert "https://nerdrx.github.io/novum-xenium/troubleshooting/models/" in page["output"]
    match = re.search(r"lines (\d+):(\d+) of (\d+); (next_offset=\d+|end\.)", page["output"])
    assert match
    start, end, total = map(int, match.group(1, 2, 3))
    assert start == 0
    assert end <= min(total, 100)
    assert len(page["output"]) <= 12_500
    if match.group(4).startswith("next_offset="):
        offset = int(match.group(4).split("=", 1)[1])
        next_page = _execute({"page": "troubleshooting/models.md", "offset": offset})
        assert f"lines {offset}:" in next_page["output"]
        assert len(next_page["output"]) <= 12_500


@pytest.mark.parametrize(
    "content",
    [
        "{",
        "[]",
        json.dumps({"query": 42}),
        json.dumps({"page": "../README.md"}),
        json.dumps({"page": str(HANDBOOK_ROOT / "troubleshooting/models.md")}),
        json.dumps({"query": "models", "page": "troubleshooting/models.md"}),
        json.dumps({"page": "troubleshooting/models.md", "offset": True}),
        json.dumps({"page": "troubleshooting/models.md", "offset": -1}),
        json.dumps({"page": "troubleshooting/models.md", "unknown": "value"}),
    ],
)
def test_handbook_tool_rejects_malformed_or_out_of_scope_arguments(content):
    result = asyncio.run(ReadHandbookTool().execute(content, {}))
    assert result["exit_code"] == 1
    assert "error" in result
    assert "untrusted_content" not in result


def test_handbook_tool_rejects_symlink_pages_and_missing_bundle(tmp_path, monkeypatch):
    root = tmp_path / "handbook"
    root.mkdir()
    (root / "safe.md").write_text("Safe page", encoding="utf-8")
    outside = tmp_path / "secret.md"
    outside.write_text("PRIVATE_SENTINEL", encoding="utf-8")
    (root / "linked.md").symlink_to(outside)
    monkeypatch.setitem(read_handbook.__globals__, "HANDBOOK_ROOT", root)

    symlink_result = _execute({"page": "linked.md"})
    assert symlink_result["exit_code"] == 1
    assert "PRIVATE_SENTINEL" not in symlink_result["error"]

    missing_root = tmp_path / "missing"
    monkeypatch.setitem(read_handbook.__globals__, "HANDBOOK_ROOT", missing_root)
    missing_result = _execute({})
    assert missing_result["exit_code"] == 1
    assert "bundled handbook is unavailable" in missing_result["error"]


def test_handbook_tool_caps_page_size_and_pagination_output(tmp_path, monkeypatch):
    root = tmp_path / "handbook"
    root.mkdir()
    (root / "large.md").write_text("x" * 256_001, encoding="utf-8")
    monkeypatch.setitem(read_handbook.__globals__, "HANDBOOK_ROOT", root)
    too_large = _execute({"page": "large.md"})
    assert too_large["exit_code"] == 1
    assert "exceeds the supported size" in too_large["error"]

    (root / "large.md").write_text("\n".join(f"line {i}: short" for i in range(250)), encoding="utf-8")
    first = read_handbook({"page": "large.md"})
    assert len(first) <= 12_500
    assert "next_offset=100" in first
    second = read_handbook({"page": "large.md", "offset": 100})
    assert "lines 100:200 of 250" in second


def test_handbook_index_has_bounded_entries_and_offsets(tmp_path, monkeypatch):
    root = tmp_path / "handbook"
    root.mkdir()
    for i in range(95):
        (root / f"index-{i:03}.md").write_text(f"# Handbook page {i}\n", encoding="utf-8")
    monkeypatch.setitem(read_handbook.__globals__, "HANDBOOK_ROOT", root)

    first = read_handbook({})
    second = read_handbook({"offset": 40})
    third = read_handbook({"offset": 80})
    for output in (first, second, third):
        assert len(output) <= 12_000
    assert "Entries 0:40 of 95; next_offset=40" in first
    assert "Entries 40:80 of 95; next_offset=80" in second
    assert "Entries 80:95 of 95; end." in third
    assert len(re.findall(r"^index-\d{3}\.md —", first, re.MULTILINE)) == 40
    assert len(re.findall(r"^index-\d{3}\.md —", second, re.MULTILINE)) == 40
    assert len(re.findall(r"^index-\d{3}\.md —", third, re.MULTILINE)) == 15


def test_handbook_dispatch_uses_minted_public_read_authority_and_obeys_policy():
    owner, session_id = "fixture-owner", "handbook-tool-dispatch"
    message = "Troubleshoot why my local model is unavailable"
    operation = ExactOperation.normalize("read_handbook", "{}")
    authority = create_request_authority(
        message, owner=owner, session_id=session_id, policy=ToolPolicy())
    assert authority.permits(operation)

    description, result = asyncio.run(execute_tool_block(
        ToolBlock("read_handbook", "{}"),
        owner=owner,
        session_id=session_id,
        security_context=NO_TOOL_SECURITY_CONTEXT,
        request_authority=authority,
    ))
    assert description.startswith("registry: read_handbook")
    assert result["exit_code"] == 0
    assert result["untrusted_content"] is True
    assert "Page index" in result["output"]

    disabled_policy = ToolPolicy(disabled_tools=frozenset({"read_handbook"}))
    disabled_authority = create_request_authority(
        message, owner=owner, session_id=session_id, policy=disabled_policy)
    assert not disabled_authority.permits(operation)
    denied_description, denied = asyncio.run(execute_tool_block(
        ToolBlock("read_handbook", "{}"),
        owner=owner,
        session_id=session_id,
        security_context=NO_TOOL_SECURITY_CONTEXT,
        tool_policy=disabled_policy,
        request_authority=disabled_authority,
    ))
    assert denied_description.endswith(": BLOCKED")
    assert denied["blocked"] is True
    assert denied["exit_code"] == 1

    guide_policy = build_effective_tool_policy(last_user_message="Do not use tools.")
    guide_authority = create_request_authority(
        message, owner=owner, session_id=session_id, policy=guide_policy)
    assert not guide_authority.permits(operation)

    internal_request = SimpleNamespace(
        headers={}, state=SimpleNamespace(current_user="internal-tool"))
    internal_authority = request_authority_for_http(
        internal_request, message, owner=owner, session_id=session_id,
        policy=ToolPolicy())
    assert not internal_authority.permits(operation)


def test_handbook_tool_is_registered_for_native_fenced_and_readonly_surfaces():
    schema = _function_schema()
    assert schema["name"] == "read_handbook"
    assert schema["parameters"]["additionalProperties"] is False
    assert {"query", "page", "offset"} == set(schema["parameters"]["properties"])

    native = function_call_to_tool_block("read_handbook", '{"query":"models"}')
    assert native is not None and native.tool_type == "read_handbook"
    fenced = parse_tool_blocks('```read_handbook {"page":"troubleshooting/models.md"}\n```')
    assert len(fenced) == 1
    assert fenced[0].tool_type == "read_handbook"
    assert json.loads(fenced[0].content)["page"] == "troubleshooting/models.md"
    assert "read_handbook" in TOOL_TAGS

    capabilities = capabilities_for_tool("read_handbook")
    assert capabilities.known is True
    assert capabilities.effects == frozenset({ToolEffect.READ_CONTEXT})
    assert capabilities.result_integrity == ResultIntegrity.EXTERNAL_UNTRUSTED
    assert "read_handbook" in PLAN_MODE_READONLY_TOOLS
    assert not is_public_blocked_tool("read_handbook")

    routed = resolve_turn_contract(
        capabilities={"cookbook_admin"},
        schemas=FUNCTION_TOOL_SCHEMAS,
        policy=ToolPolicy(),
        always_available_tools={"read_handbook"},
    )
    assert routed.permits("read_handbook")
    full_inventory = resolve_full_inventory_contract(
        schemas=FUNCTION_TOOL_SCHEMAS,
        policy=ToolPolicy(),
    )
    assert full_inventory.permits("read_handbook")
    denied = resolve_turn_contract(
        capabilities={"cookbook_admin"},
        schemas=FUNCTION_TOOL_SCHEMAS,
        policy=ToolPolicy(disabled_tools=frozenset({"read_handbook"})),
        always_available_tools={"read_handbook"},
    )
    assert not denied.permits("read_handbook")

    full_prompt = _assemble_prompt({"read_handbook"})
    compact_prompt = _assemble_prompt({"read_handbook"}, compact=True)
    assert "read_handbook" in full_prompt
    assert "consult read_handbook" in compact_prompt


