"""Loop integration for research-first coding turns."""
import json
import copy

import src.agent_loop as al
from test_agent_rounds_exhausted import _collect, _patch_common, _types


def _call(name, args, call_id):
    return "data: " + json.dumps({"type": "tool_calls", "calls": [{
        "id": call_id, "name": name, "arguments": json.dumps(args),
    }]}) + "\n\n"


def _schemas(kwargs):
    return {
        schema.get("function", {}).get("name")
        for schema in (kwargs.get("tools") or [])
    }


def _run(monkeypatch, tmp_path, task_text, replies, tool_results, *, disabled_tools=None,
         exact_approval=None, schema_details=None):
    _patch_common(monkeypatch)
    monkeypatch.setattr(al, "blocked_tools_for_owner", lambda _owner: set())
    monkeypatch.setenv("ODYSSEUS_RUN_CHECKPOINTS_DB", str(tmp_path / "runs.db"))
    requests, histories, executed = [], [], []

    async def stream(_candidates, _messages, **kwargs):
        factory = kwargs.get("candidate_request_factory")
        if factory:
            request = await factory(0, *_candidates[0])
            request_kwargs = request.get("kwargs", {})
            tool_schemas = request_kwargs.get("tools") or []
            if schema_details is not None:
                schema_details.append(tool_schemas)
            requests.append(_schemas(request_kwargs))
            histories.append(list(request.get("messages") or []))
        else:
            tool_schemas = kwargs.get("tools") or []
            if schema_details is not None:
                schema_details.append(tool_schemas)
            requests.append(_schemas(kwargs))
            histories.append(list(_messages))
        reply = replies[len(requests) - 1]
        yield reply
        yield "data: [DONE]\n\n"

    async def execute(block, *args, **kwargs):
        executed.append(block.tool_type)
        return block.tool_type, tool_results[block.tool_type].pop(0)

    monkeypatch.setattr(al, "stream_llm_with_fallback", stream)
    monkeypatch.setattr(al, "execute_tool_block", execute)
    events = _types(_collect(al.stream_agent_loop(
        "http://x/v1", "gpt-4o", [{"role": "user", "content": task_text}],
        workspace="/workspace", approval_mode="full", max_rounds=len(replies) + 1,
        disabled_tools=disabled_tools or set(),
        exact_approval=exact_approval,
    )))
    return events, requests, histories, executed


def _approval(tool_name, arguments):
    from src.tool_approval_scopes import TASK_APPROVAL_DECISION
    from src.tool_approvals import ToolApprovalStore
    from src.tool_capabilities import capabilities_for_action

    content = json.dumps(arguments)
    store = ToolApprovalStore()
    pending = store.create(
        owner=None, session_id=None, origin_run_id="run-1", tool_name=tool_name,
        content=content, workspace="/workspace", external_untrusted_context_seen=True,
        capabilities=capabilities_for_action(tool_name, content),
    )
    return store.consume(
        pending.approval_id, decision=TASK_APPROVAL_DECISION,
        owner=None, session_id=None,
    )


def _no_suggested_skills(monkeypatch):
    # These cases isolate documentation gating; skill consultation has its own
    # loop coverage below with an explicit candidate fixture.
    from services.memory.skills import SkillsManager
    monkeypatch.setattr(SkillsManager, "load", lambda self, owner=None: [])


def test_fetching_task_docs_opens_coding_tools(monkeypatch, tmp_path):
    _no_suggested_skills(monkeypatch)
    url = "https://vendor.example/docs/api"
    events, requests, histories, executed = _run(
        monkeypatch,
        tmp_path,
        f"Build a GUI app using this framework; follow {url}.",
        [_call("web_fetch", {"url": url}, "fetch"),
         _call("write_file", {"path": "app.py", "content": "print('ok')"}, "write"),
         'data: {"delta":"Implemented and checked."}\n\n'],
        {"web_fetch": [{"output": "Official API documentation", "exit_code": 0}],
         "write_file": [{"output": "saved", "exit_code": 0}]},
    )
    assert "web_fetch" in requests[0]
    assert not ({"bash", "write_file"} & requests[0])
    assert {"bash", "write_file"} <= requests[1]
    assert executed == ["web_fetch", "write_file"]
    assert all(sum(bool(message.get("_coding_guidance")) for message in history) == 1
               for history in histories)
    assert any(event.get("type") == "coding_research"
               and event.get("status") == "sources_read" for event in events)


def test_hidden_write_before_fetch_is_blocked_without_execution(monkeypatch, tmp_path):
    _no_suggested_skills(monkeypatch)
    url = "https://vendor.example/docs/api"
    events, requests, histories, executed = _run(
        monkeypatch,
        tmp_path,
        f"Build a GUI app using this framework; follow {url}.",
        [_call("write_file", {"path": "app.py", "content": "bad"}, "early-write"),
         _call("web_fetch", {"url": url}, "fetch"),
         'data: {"delta":"Ready."}\n\n'],
        {"web_fetch": [{"output": "Official API documentation", "exit_code": 0}]},
    )
    assert not ({"bash", "write_file"} & requests[0])
    assert executed == ["web_fetch"]
    assert any("RESEARCH FIRST" in json.dumps(history) for history in histories)


def test_explicit_url_fetch_schema_is_narrow_and_shared_schema_is_unchanged(monkeypatch, tmp_path):
    _no_suggested_skills(monkeypatch)
    url = 'https://github.com/nerdrx/nx-hub/blob/main/docs/DESIGN.md'
    raw_alias = 'https://raw.githubusercontent.com/nerdrx/nx-hub/main/docs/DESIGN.md'
    wrong_url = 'https://raw.githubusercontent.com/nerdrx/nx-hub/v0.13.0/styles.css'
    original_schemas = copy.deepcopy(al.FUNCTION_TOOL_SCHEMAS)
    schema_details = []
    events, requests, _, executed = _run(
        monkeypatch, tmp_path, f'Build a GUI app following {url}.',
        [_call('web_fetch', {'url': wrong_url}, 'wrong-fetch'),
         _call('web_fetch', {'url': raw_alias}, 'right-fetch'),
         _call('write_file', {'path': 'app.py', 'content': 'ready'}, 'write'),
         'data: {"delta":"Implemented after the requested guide was read."}\n\n'],
        {'web_fetch': [{'output': 'NX design guide contents', 'exit_code': 0}],
         'write_file': [{'output': 'saved', 'exit_code': 0}]},
        schema_details=schema_details,
    )

    fetch_schema = next(schema for schema in schema_details[0]
                        if schema.get('function', {}).get('name') == 'web_fetch')
    url_schema = fetch_schema['function']['parameters']['properties']['url']
    assert url_schema['enum'] == sorted([url, raw_alias])
    assert 'web_fetch' in requests[1] and 'write_file' not in requests[1]
    assert 'write_file' in requests[2]
    assert executed == ['web_fetch', 'write_file']  # wrong URL never reached the network tool
    assert al.FUNCTION_TOOL_SCHEMAS == original_schemas
    blocked = [event for event in events if event.get('type') == 'tool_output'
               and event.get('tool') == 'web_fetch']
    assert len(blocked) == 2 and 'Coding research gate' in blocked[0]['output']


def test_two_failed_lookups_open_bounded_escape(monkeypatch, tmp_path):
    _no_suggested_skills(monkeypatch)
    url = "https://vendor.example/docs/api"
    events, requests, _, executed = _run(
        monkeypatch,
        tmp_path,
        f"Build a GUI app using this framework; follow {url}.",
        [_call("web_fetch", {"url": url}, "fetch-1"),
         _call("web_fetch", {"url": url}, "fetch-2"),
         _call("write_file", {"path": "app.py", "content": "small experiment"}, "write"),
         'data: {"delta":"Finished with unavailable docs noted."}\n\n'],
        {"web_fetch": [
             {"error": "timeout", "exit_code": 1},
             {"error": "not found", "exit_code": 1},
         ], "write_file": [{"output": "saved", "exit_code": 0}]},
    )
    assert not ({"bash", "write_file"} & requests[0])
    assert not ({"bash", "write_file"} & requests[1])
    assert "write_file" in requests[2]
    assert executed == ["web_fetch", "web_fetch", "write_file"]
    assert any(event.get("type") == "coding_research"
               and event.get("status") == "sources_unavailable" for event in events)


def test_explicit_no_web_hides_search_and_fetch_during_research(monkeypatch, tmp_path):
    _no_suggested_skills(monkeypatch)
    events, requests, _, executed = _run(
        monkeypatch,
        tmp_path,
        "Build a GUI app using the framework in this repo; do not use the web or internet.",
        [_call("read_file", {"path": "README.md"}, "read"),
         _call("write_file", {"path": "app.py", "content": "local"}, "write"),
         'data: {"delta":"Done."}\n\n'],
        {"read_file": [{"output": "Local framework documentation", "exit_code": 0}],
         "write_file": [{"output": "saved", "exit_code": 0}]},
    )
    assert not ({"web_search", "web_fetch", "bash", "write_file"} & requests[0])
    assert not any({"web_search", "web_fetch"} & schema for schema in requests)
    assert executed == ["read_file", "write_file"]
    assert any(event.get("type") == "coding_research"
               and event.get("status") == "sources_read" for event in events)


def test_research_can_load_owned_skill_but_cannot_edit_it(monkeypatch, tmp_path):
    from services.memory.skills import SkillsManager
    monkeypatch.setattr(SkillsManager, 'load', lambda self, owner=None: [{
        'name': 'ui-design', 'description': 'Build a GUI app', 'status': 'published',
        'category': 'design', 'tags': ['gui'], 'procedure': [],
        'when_to_use': 'Build a GUI app following a framework documentation guide.',
    }])
    url = 'https://vendor.example/docs/gui'
    events, requests, _, executed = _run(
        monkeypatch, tmp_path, f'Build a GUI app following {url}.',
        [_call('manage_skills', {'action': 'view', 'name': 'ui-design'}, 'view'),
         _call('manage_skills', {'action': 'delete', 'name': 'ui-design'}, 'delete'),
         _call('web_fetch', {'url': url}, 'fetch'),
         'data: {"delta":"Ready."}\n\n'],
        {'manage_skills': [{'results': 'Inspect design tokens and render the interface.'},
                           {'error': 'Cannot edit a skill during research.', 'exit_code': 1}],
         'web_fetch': [{'output': 'Official GUI documentation', 'exit_code': 0}]},
    )
    assert 'manage_skills' in requests[0]
    assert not ({'bash', 'write_file'} & requests[1])
    assert executed == ['manage_skills', 'web_fetch']
    assert any(event.get('type') == 'coding_research' and event.get('status') == 'sources_read' for event in events)


def test_read_only_skill_approval_keeps_research_gate(monkeypatch, tmp_path):
    from services.memory.skills import SkillsManager
    monkeypatch.setattr(SkillsManager, 'load', lambda self, owner=None: [{
        'name': 'ui-design', 'description': 'Build a GUI app', 'status': 'published',
        'category': 'design', 'tags': ['gui'], 'procedure': [],
    }])
    url = 'https://vendor.example/docs/gui'
    approved_view = {'action': 'view', 'name': 'ui-design'}
    events, requests, _, executed = _run(
        monkeypatch, tmp_path, f'Build a GUI app following {url}.',
        [_call('web_fetch', {'url': url}, 'fetch'),
         _call('write_file', {'path': 'app.py', 'content': 'ready'}, 'write'),
         'data: {"delta":"Ready."}\n\n'],
        {'manage_skills': [{'results': 'Read-only skill contents.'}],
         'web_fetch': [{'output': 'Official GUI documentation', 'exit_code': 0}],
         'write_file': [{'output': 'saved', 'exit_code': 0}]},
        exact_approval=_approval('manage_skills', approved_view),
    )
    assert not ({'bash', 'write_file'} & requests[0])
    assert {'bash', 'write_file'} <= requests[1]
    assert executed == ['manage_skills', 'web_fetch', 'write_file']


def test_approved_workspace_mutation_keeps_resume_behavior(monkeypatch, tmp_path):
    approved_write = {'path': 'app.py', 'content': 'approved'}
    later_write = {'path': 'next.py', 'content': 'later'}
    url = 'https://vendor.example/docs/gui'
    events, requests, _, executed = _run(
        monkeypatch, tmp_path, f'Build a GUI app following {url}.',
        [_call('write_file', later_write, 'unapproved-write'),
         _call('web_fetch', {'url': url}, 'fetch'),
         _call('write_file', later_write, 'later-write'),
         'data: {"delta":"Continuing the approved change."}\n\n'],
        {'write_file': [{'output': 'approved file saved', 'exit_code': 0},
                        {'output': 'later file saved', 'exit_code': 0}],
         'web_fetch': [{'output': 'Official GUI documentation', 'exit_code': 0}]},
        exact_approval=_approval('write_file', approved_write),
    )
    # The exact sealed write executes once. It does not unlock a different
    # model-proposed write on the resumed task before documentation research.
    assert not ({'bash', 'write_file'} & requests[0])
    assert not ({'bash', 'write_file'} & requests[1])
    assert 'write_file' in requests[2]
    assert executed == ['write_file', 'web_fetch', 'write_file']


def test_documentation_evidence_still_waits_for_suggested_skill_view(monkeypatch, tmp_path):
    from services.memory.skills import SkillsManager
    monkeypatch.setattr(SkillsManager, 'load', lambda self, owner=None: [{
        'name': 'ui-design', 'description': 'Build a GUI app', 'status': 'published',
        'category': 'design', 'tags': ['gui'], 'procedure': [],
        'when_to_use': 'Build a GUI app following a framework documentation guide.',
    }])
    url = 'https://vendor.example/docs/gui'
    events, requests, _, executed = _run(
        monkeypatch, tmp_path, f'Build a GUI app following {url}.',
        [_call('web_fetch', {'url': url}, 'fetch'),
         _call('write_file', {'path': 'too-early.py', 'content': 'no'}, 'early'),
         _call('manage_skills', {'action': 'view', 'name': 'ui-design'}, 'view'),
         _call('write_file', {'path': 'app.py', 'content': 'ok'}, 'write'),
         'data: {"delta":"Implemented after reading both references."}\n\n'],
        {'web_fetch': [{'output': 'Official GUI documentation', 'exit_code': 0}],
         'manage_skills': [{'results': 'Use a compact GUI layout.'}],
         'write_file': [{'output': 'saved', 'exit_code': 0}]},
    )

    assert not ({'bash', 'write_file'} & requests[1])
    assert 'manage_skills' in requests[1]
    assert 'write_file' in requests[3]
    assert executed == ['web_fetch', 'manage_skills', 'write_file']


def test_documentation_ready_schema_focuses_on_pending_skill(monkeypatch, tmp_path):
    _seed_ui_skill(monkeypatch)
    url = 'https://vendor.example/docs/gui'
    events, requests, _, executed = _run(
        monkeypatch, tmp_path, f'Build a GUI app following {url}.',
        [_call('web_fetch', {'url': url}, 'fetch'),
         _call('manage_skills', {'action': 'view', 'name': 'ui-design'}, 'view'),
         _call('write_file', {'path': 'app.py', 'content': 'ready'}, 'write'),
         'data: {"delta":"Implemented after reading both references."}\n\n'],
        {'web_fetch': [{'output': 'Official GUI documentation', 'exit_code': 0}],
         'manage_skills': [{'results': 'Use a compact GUI layout.'}],
         'write_file': [{'output': 'saved', 'exit_code': 0}]},
    )

    focused = requests[1]
    assert 'manage_skills' in focused
    assert 'ask_user' in focused
    assert not ({'web_search', 'web_fetch', 'read_file', 'grep', 'glob', 'ls',
                 'get_workspace', 'write_file', 'bash'} & focused)
    assert 'write_file' in requests[2]
    assert executed == ['web_fetch', 'manage_skills', 'write_file']


def test_out_of_phase_fetch_is_blocked_without_spending_research_budget(monkeypatch, tmp_path):
    _seed_ui_skill(monkeypatch)
    url = 'https://vendor.example/docs/gui'
    events, requests, _, executed = _run(
        monkeypatch, tmp_path, f'Build a GUI app following {url}.',
        [_call('web_fetch', {'url': url}, 'fetch'),
         _call('web_fetch', {'url': url}, 'repeat-fetch'),
         _call('manage_skills', {'action': 'view', 'name': 'ui-design'}, 'view'),
         _call('write_file', {'path': 'app.py', 'content': 'ready'}, 'write'),
         'data: {"delta":"Implemented after reading both references."}\n\n'],
        {'web_fetch': [{'output': 'Official GUI documentation', 'exit_code': 0}],
         'manage_skills': [{'results': 'Use a compact GUI layout.'}],
         'write_file': [{'output': 'saved', 'exit_code': 0}]},
    )

    assert 'web_fetch' not in requests[1]
    assert 'manage_skills' in requests[1]
    assert executed == ['web_fetch', 'manage_skills', 'write_file']
    fetch_results = [event for event in events
                     if event.get('type') == 'tool_output' and event.get('tool') == 'web_fetch']
    assert len(fetch_results) == 2
    assert 'Coding research gate' in fetch_results[1]['output']


def test_failed_skill_views_release_only_after_bounded_attempts(monkeypatch, tmp_path):
    _seed_ui_skill(monkeypatch)
    url = 'https://vendor.example/docs/gui'
    events, requests, _, executed = _run(
        monkeypatch, tmp_path, f'Build a GUI app following {url}.',
        [_call('web_fetch', {'url': url}, 'fetch'),
         _call('manage_skills', {'action': 'view', 'name': 'ui-design'}, 'view-1'),
         _call('manage_skills', {'action': 'view', 'name': 'ui-design'}, 'view-2'),
         _call('write_file', {'path': 'app.py', 'content': 'ready'}, 'write'),
         'data: {"delta":"Implemented; the suggested procedure was unavailable."}\n\n'],
        {'web_fetch': [{'output': 'Official GUI documentation', 'exit_code': 0}],
         'manage_skills': [{'error': 'not found', 'exit_code': 1},
                           {'error': 'not found', 'exit_code': 1}],
         'write_file': [{'output': 'saved', 'exit_code': 0}]},
    )

    assert all('write_file' not in requests[index] for index in range(3))
    assert 'write_file' in requests[3]
    assert executed == ['web_fetch', 'manage_skills', 'manage_skills', 'write_file']
    assert any(event.get('type') == 'coding_research' and event.get('status') == 'sources_read'
               for event in events)


def test_missing_skill_candidate_keeps_documentation_phase_and_opens_after_lookup(monkeypatch, tmp_path):
    _no_suggested_skills(monkeypatch)
    url = 'https://vendor.example/docs/gui'
    events, requests, _, executed = _run(
        monkeypatch, tmp_path, f'Build a GUI app following {url}.',
        [_call('web_fetch', {'url': url}, 'fetch'),
         _call('write_file', {'path': 'app.py', 'content': 'ready'}, 'write'),
         'data: {"delta":"Implemented after documentation lookup."}\n\n'],
        {'web_fetch': [{'output': 'Official GUI documentation', 'exit_code': 0}],
         'write_file': [{'output': 'saved', 'exit_code': 0}]},
    )

    assert 'write_file' in requests[1]
    assert executed == ['web_fetch', 'write_file']


def test_disabled_skill_tool_does_not_create_a_pending_skill_phase(monkeypatch, tmp_path):
    _seed_ui_skill(monkeypatch)
    url = 'https://vendor.example/docs/gui'
    events, requests, _, executed = _run(
        monkeypatch, tmp_path, f'Build a GUI app following {url}.',
        [_call('web_fetch', {'url': url}, 'fetch'),
         _call('write_file', {'path': 'app.py', 'content': 'ready'}, 'write'),
         'data: {"delta":"Implemented after documentation lookup."}\n\n'],
        {'web_fetch': [{'output': 'Official GUI documentation', 'exit_code': 0}],
         'write_file': [{'output': 'saved', 'exit_code': 0}]},
        disabled_tools={'manage_skills'},
    )

    assert 'manage_skills' not in requests[1]
    assert 'write_file' in requests[1]
    assert executed == ['web_fetch', 'write_file']


def _seed_ui_skill(monkeypatch):
    from services.memory.skills import SkillsManager
    monkeypatch.setattr(SkillsManager, 'load', lambda self, owner=None: [{
        'name': 'ui-design', 'description': 'Build a GUI app', 'status': 'published',
        'category': 'design', 'tags': ['gui'], 'procedure': [],
        'when_to_use': 'Build a GUI app following a framework documentation guide.',
    }])


def test_exhausted_search_allowance_reminds_about_skill_without_claiming_sources(monkeypatch, tmp_path):
    _seed_ui_skill(monkeypatch)
    searches = [
        _call('web_search', {'query': f'Electron GUI detail {i}'}, f'search-{i}')
        for i in range(6)
    ]
    events, requests, histories, executed = _run(
        monkeypatch, tmp_path,
        'Build a GUI app following https://vendor.example/docs/gui.',
        [*searches,
         _call('manage_skills', {'action': 'view', 'name': 'ui-design'}, 'view'),
         _call('write_file', {'path': 'app.py', 'content': 'ready'}, 'write'),
         'data: {"delta":"Implemented with documentation uncertainty noted."}\n\n'],
        {'web_search': [{'output': f'Search result snippet {i}', 'exit_code': 0}
                        for i in range(6)],
         'manage_skills': [{'results': 'Use a compact GUI layout.', 'exit_code': 0}],
         'write_file': [{'output': 'saved', 'exit_code': 0}]},
    )

    reminder = 'The bounded documentation lookup allowance is exhausted; no source was verified.'
    assert reminder in str(histories[6])
    assert 'Documentation has been read' not in str(histories[6])
    assert all('write_file' not in requests[i] for i in range(7))
    assert 'write_file' in requests[7]
    assert executed == ['web_search'] * 6 + ['manage_skills', 'write_file']
    assert str(histories[7]).count(reminder) == 1  # retained, not re-injected
    assert any(event.get('type') == 'coding_research'
               and event.get('status') == 'sources_unavailable' for event in events)


def test_exhausted_search_without_skill_candidate_gets_no_skill_reminder(monkeypatch, tmp_path):
    _no_suggested_skills(monkeypatch)
    searches = [
        _call('web_search', {'query': f'Electron GUI detail {i}'}, f'search-{i}')
        for i in range(6)
    ]
    events, requests, histories, executed = _run(
        monkeypatch, tmp_path,
        'Build a GUI app following https://vendor.example/docs/gui.',
        [*searches,
         _call('write_file', {'path': 'app.py', 'content': 'ready'}, 'write'),
         'data: {"delta":"Implemented with uncertainty noted."}\n\n'],
        {'web_search': [{'output': f'Search result snippet {i}', 'exit_code': 0}
                        for i in range(6)],
         'write_file': [{'output': 'saved', 'exit_code': 0}]},
    )

    assert all('The bounded documentation lookup allowance is exhausted'
               not in str(history) for history in histories)
    assert 'write_file' in requests[6]
    assert executed == ['web_search'] * 6 + ['write_file']
