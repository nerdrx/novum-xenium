"""A custom rename must win even after the background title eligibility check."""
import asyncio
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import core.session_manager as session_manager_module
from core.session_manager import SessionManager
from core.database import Session as DbSession
import routes.chat_helpers as chat_helpers


@pytest.fixture
def title_manager(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'titles.db'}")
    DbSession.__table__.create(engine)
    local = sessionmaker(bind=engine)
    monkeypatch.setattr(session_manager_module, 'SessionLocal', local)
    sess = SimpleNamespace(id='title-race', owner='alice', name='Chat: First request',
                           model='fixture-model', name_is_custom=False,
                           endpoint_url='http://fixture.invalid', headers={},
                           history=[SimpleNamespace(role='user', content='First request')])
    with local() as db:
        db.add(DbSession(id=sess.id, owner=sess.owner, name=sess.name,
                         name_is_custom=False, model=sess.model, endpoint_url=sess.endpoint_url))
        db.commit()
    manager = SessionManager.__new__(SessionManager)
    manager.sessions = {sess.id: sess}
    yield manager, sess, local
    engine.dispose()


def test_custom_rename_after_auto_name_check_is_preserved(title_manager, monkeypatch):
    manager, sess, local = title_manager
    import src.llm_core as llm_core
    import src.task_endpoint as task_endpoint
    monkeypatch.setattr(task_endpoint, 'resolve_task_endpoint', lambda *_a, **_k: ('http://fixture.invalid', 'fixture-model', {}))
    async def generated(*_a, **_k):
        return 'Generated title'
    monkeypatch.setattr(llm_core, 'llm_call_async', generated)
    original_check = chat_helpers.needs_auto_name
    def rename_after_check(*args, **kwargs):
        eligible = original_check(*args, **kwargs)
        # Deterministically schedule the manual request in the gap between
        # the background eligibility check and its database write.
        manager.update_session_name(sess.id, 'My chosen title')
        return eligible
    monkeypatch.setattr(chat_helpers, 'needs_auto_name', rename_after_check)
    asyncio.run(chat_helpers.auto_name_session(manager, sess))
    with local() as db:
        row = db.get(DbSession, sess.id)
        assert row.name == 'My chosen title'
        assert row.name_is_custom is True
    assert sess.name == 'My chosen title'
    assert sess.name_is_custom is True


def test_conditional_name_write_checks_persisted_provenance(title_manager):
    manager, sess, local = title_manager
    old_name = sess.name
    # Another process can persist a rename while this cache is still stale.
    with local() as db:
        db.query(DbSession).filter(DbSession.id == sess.id).update(
            {DbSession.name: 'Persisted custom title', DbSession.name_is_custom: True})
        db.commit()
    assert manager.update_session_name(sess.id, 'Generated title', name_is_custom=False,
                                       expected_name=old_name) is False
    with local() as db:
        assert db.get(DbSession, sess.id).name == 'Persisted custom title'


def test_conditional_name_write_still_updates_auto_title(title_manager):
    manager, sess, local = title_manager
    assert manager.update_session_name(sess.id, 'Generated title', name_is_custom=False,
                                       expected_name=sess.name) is True
    assert sess.name == 'Generated title'
    with local() as db:
        row = db.get(DbSession, sess.id)
        assert row.name == 'Generated title'
        assert row.name_is_custom is False


def test_request_title_cannot_replace_persisted_custom_name(title_manager):
    manager, sess, local = title_manager
    with local() as db:
        db.query(DbSession).filter(DbSession.id == sess.id).update(
            {DbSession.name: 'Persisted custom title', DbSession.name_is_custom: True})
        db.commit()
    assert manager.update_session_name(sess.id, 'Chat: First request', name_is_custom=False) is False
    with local() as db:
        assert db.get(DbSession, sess.id).name == 'Persisted custom title'
