import asyncio
import json
from types import SimpleNamespace

import pytest

import src.agent_loop as al
from src.coding_grounding import CodingGrounding
from src.tool_approval_scopes import TASK_APPROVAL_DECISION
from src.tool_approvals import ToolApprovalStore
from src.tool_capabilities import capabilities_for_action
from test_agent_rounds_exhausted import _collect, _patch_common

TASK = 'Repair the existing Electron GUI app using local files, offline.'
NAMES = ('ui-design', 'visual-verification')


def evidence():
    gate = CodingGrounding(TASK)
    gate.set_skill_candidates(NAMES)
    assert gate.observe('read_file', {'exit_code': 0, 'output': 'Electron package metadata'}, 'nflix/package.json')
    for name in NAMES:
        assert gate.observe('manage_skills', {'results': f'Complete procedure {name}'},
                            json.dumps({'action': 'view', 'name': name}))
    return gate.checkpoint_evidence()


def test_evidence_replay_preserves_current_requirements_and_no_retry_escape():
    gate = CodingGrounding(TASK)
    gate.set_skill_candidates(NAMES)
    assert len(gate.restore_evidence(evidence())) == 3
    assert gate.may_mutate
    assert (gate.attempts, gate.failures, gate.skill_view_attempts) == (0, 0, 0)
    assert not gate.skill_review_skipped

    gate = CodingGrounding('Build a GUI app using https://different.example/docs')
    gate.set_skill_candidates(NAMES)
    gate.restore_evidence(evidence())
    assert not gate.may_mutate
    assert not gate.has_evidence
    assert gate.attempts == 0

    gate = CodingGrounding(TASK, disabled_tools={'read_file', 'manage_skills'})
    assert gate.restore_evidence(evidence()) == []
    assert not gate.evidence
    assert not gate.viewed_skills


@pytest.mark.parametrize('flag', ['blocked', 'approval_required', 'error'])
def test_replay_rejects_unsuccessful_and_missing_skill_bodies(flag):
    data = evidence()
    for record in data['records']:
        record['result'][flag] = True
    gate = CodingGrounding(TASK)
    gate.set_skill_candidates(NAMES)
    assert gate.restore_evidence(data) == []
    assert not gate.may_mutate
    data = evidence()
    data['records'][1]['result']['results'] = ''
    gate.restore_evidence(data)
    assert not gate.may_mutate
    assert 'ui-design' not in gate.viewed_skills


def test_grounding_restore_bound_to_approval_origin_owner_session_workspace(monkeypatch, tmp_path):
    monkeypatch.setenv('ODYSSEUS_RUN_CHECKPOINTS_DB', str(tmp_path / 'runs.db'))
    from src import run_checkpoints
    store = run_checkpoints.CheckpointStore(str(tmp_path / 'runs.db'))
    monkeypatch.setattr(run_checkpoints, '_STORE', store)
    store.begin('origin', 'chat', 'alice', {'workspace': '/workspace'})
    assert store.record_coding_grounding('origin', 'chat', 'alice', evidence())
    assert not store.record_coding_grounding('origin', 'chat', 'bob', evidence())
    pending = SimpleNamespace(origin_run_id='origin', owner='alice', session_id='chat', workspace='/workspace')
    approval = SimpleNamespace(pending=pending)
    assert asyncio.run(al._restore_approved_grounding(approval, 'alice', 'chat', '/workspace')) == evidence()
    for owner, session, workspace in [('bob', 'chat', '/workspace'), ('alice', 'other', '/workspace'),
                                      ('alice', 'chat', '/other')]:
        assert asyncio.run(al._restore_approved_grounding(approval, owner, session, workspace)) is None
    assert asyncio.run(al._restore_approved_grounding(None, 'alice', 'chat', '/workspace')) is None
    pending.origin_run_id = 'different-run'
    assert asyncio.run(al._restore_approved_grounding(approval, 'alice', 'chat', '/workspace')) is None


def test_first_resumed_request_has_grounding_and_real_skill_references(monkeypatch, tmp_path):
    from services.memory.skills import SkillsManager
    from src.agent_tools import coding_tools
    _patch_common(monkeypatch)
    monkeypatch.setattr(al, 'blocked_tools_for_owner', lambda _owner: set())
    monkeypatch.setattr(al, 'get_setting', lambda key, default=None: True if key == 'agent_milestone_workflow' else default)
    monkeypatch.setattr(coding_tools, 'read_todos', lambda ctx: [])
    skills = [{'name': name, 'description': 'Repair Electron GUI app', 'status': 'published',
               'audit_verdict': 'pass', 'confidence': 1.0,
               'category': 'design', 'tags': ['gui'], 'procedure': []} for name in NAMES]
    monkeypatch.setattr(SkillsManager, 'load', lambda self, owner=None: skills)
    monkeypatch.setattr(SkillsManager, 'get_relevant_skills', lambda self, *args, **kwargs: skills)
    set_candidates = CodingGrounding.set_skill_candidates
    monkeypatch.setattr(CodingGrounding, 'set_skill_candidates',
                        lambda gate, names, available=True: set_candidates(gate, NAMES, available=available))
    workspace = str(tmp_path)
    monkeypatch.setenv('ODYSSEUS_RUN_CHECKPOINTS_DB', str(tmp_path / 'runs.db'))
    from src import run_checkpoints
    store = run_checkpoints.CheckpointStore(str(tmp_path / 'runs.db'))
    monkeypatch.setattr(run_checkpoints, '_STORE', store)
    store.begin('origin', 'chat', 'alice', {'workspace': workspace})
    store.record_coding_grounding('origin', 'chat', 'alice', evidence())
    store.begin('resumed', 'chat', 'alice', {'workspace': workspace})
    args = {'todos': [{'content': 'Repair GUI', 'status': 'in_progress'}], 'work_packet': {
        'objective': 'Repair GUI', 'files': ['main.js'], 'reproduce_command': 'node qa.js',
        'acceptance_command': 'node qa.js', 'acceptance_condition': 'GUI conversion passes'}}
    content = json.dumps(args)
    approvals = ToolApprovalStore()
    pending = approvals.create(owner='alice', session_id='chat', origin_run_id='origin',
                               tool_name='todowrite', content=content, workspace=workspace,
                               selected_tools={'todowrite', 'bash', 'write_file', 'manage_skills'},
                               external_untrusted_context_seen=True,
                               capabilities=capabilities_for_action('todowrite', content))
    grant = approvals.consume(pending.approval_id, decision=TASK_APPROVAL_DECISION, owner='alice', session_id='chat')
    executed, requests = [], []
    async def execute(block, *a, **kw):
        executed.append(block.tool_type)
        if block.tool_type == 'todowrite':
            return 'saved', {'exit_code': 0, **args}
        assert block.tool_type == 'bash' and block.content == 'node qa.js'
        return 'baseline', {'exit_code': 1, 'output': 'Expected GUI failure'}
    async def stream(candidates, messages, **kwargs):
        assert executed == ['todowrite']
        request = await kwargs['candidate_request_factory'](0, *candidates[0])
        requests.append(request)
        names = {schema['function']['name'] for schema in request['kwargs']['tools']}
        assert 'write_file' in names
        text = json.dumps(request['messages'])
        for name in NAMES:
            assert f'Complete procedure {name}' in text
        refs = [message for message in request['messages'] if message.get('_required_skill_reference')]
        assert len(refs) == 2
        assert all(message['metadata']['trusted'] is False for message in refs)
        yield 'data: {"delta":"Baseline failed; ready to repair."}\n\n'
        yield 'data: [DONE]\n\n'
    monkeypatch.setattr(al, 'execute_tool_block', execute)
    monkeypatch.setattr(al, 'stream_llm_with_fallback', stream)
    _collect(al.stream_agent_loop('http://x/v1', 'gpt-4o', [{'role': 'user', 'content': TASK}],
                                 workspace=workspace, owner='alice', session_id='chat',
                                 exact_approval=grant, approval_mode='auto', server_run_id='resumed', max_rounds=1,
                                 relevant_tools={'todowrite', 'bash', 'write_file', 'manage_skills', 'read_file'}))
    assert len(requests) == 1
    restored = run_checkpoints.get_run_checkpoint('resumed', 'chat', 'alice')
    assert len(restored['coding_grounding']['records']) == 3


def test_unretained_skill_procedure_never_restores_as_read():
    gate = CodingGrounding(TASK)
    gate.set_skill_candidates(NAMES)
    gate.observe('read_file', {'output': 'package metadata', 'exit_code': 0}, 'package.json')
    for name in NAMES:
        gate.observe('manage_skills', {'results': 'x' * 12_000},
                     json.dumps({'action': 'view', 'name': name}))
    restored = CodingGrounding(TASK)
    restored.set_skill_candidates(NAMES)
    restored.restore_evidence(gate.checkpoint_evidence())
    assert len(restored.viewed_skills) == 1
    assert not restored.may_mutate


@pytest.mark.parametrize('data', [None, [], {'version': 1, 'records': 'bad'},
                                 {'version': 1, 'records': [None, {'tool': 'read_file'}]},
                                 {'version': 1, 'records': [{'tool': []}]}])
def test_corrupt_evidence_fails_closed(data):
    gate = CodingGrounding(TASK)
    assert gate.restore_evidence(data) == []
    assert not gate.may_mutate


def test_corrupt_origin_context_fails_closed(monkeypatch, tmp_path):
    monkeypatch.setenv('ODYSSEUS_RUN_CHECKPOINTS_DB', str(tmp_path / 'runs.db'))
    from src import run_checkpoints
    monkeypatch.setattr(run_checkpoints, 'get_run_checkpoint', lambda *args: {
        'run_id': 'origin', 'owner': 'alice', 'session_id': 'chat', 'context': ['bad'],
    })
    approval = SimpleNamespace(pending=SimpleNamespace(origin_run_id='origin', owner='alice',
                                                      session_id='chat', workspace='/workspace'))
    assert asyncio.run(al._restore_approved_grounding(approval, 'alice', 'chat', '/workspace')) is None
