"""Request-derived session title behavior and legacy migration coverage."""
import sqlite3

import core.database as cdb
from src.session_titles import display_title, needs_auto_name, request_title


def test_legacy_title_migration_is_idempotent_and_preserves_existing_name(monkeypatch, tmp_path):
    path = tmp_path / "sessions.db"
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL)")
        db.execute("INSERT INTO sessions VALUES ('legacy', 'gpt-6.1-sol')")
    monkeypatch.setattr(cdb, "DATABASE_URL", f"sqlite:///{path}")

    cdb._migrate_add_session_name_provenance_column()
    cdb._migrate_add_session_name_provenance_column()

    with sqlite3.connect(path) as db:
        columns = [row[1] for row in db.execute("PRAGMA table_info(sessions)")]
        name, custom = db.execute(
            "SELECT name, name_is_custom FROM sessions WHERE id='legacy'"
        ).fetchone()
    assert columns.count("name_is_custom") == 1
    assert (name, custom) == ("gpt-6.1-sol", None)


def test_display_fallback_preserves_group_prefix_and_manual_exact_model_name():
    assert display_title("gpt-6.1-sol", "gpt-6.1-sol", None, "Summarize my workspace") == (
        "Chat: Summarize my workspace"
    )
    assert display_title("[GRP] huihui, gpt-6.1-sol", "gpt-6.1-sol", None,
                         "Compare our approaches") == "[GRP] Chat: Compare our approaches"
    assert display_title("gpt-6.1-sol", "gpt-6.1-sol", True, "Summarize my workspace") == (
        "gpt-6.1-sol"
    )
    assert not needs_auto_name("Chat", "gpt-6.1-sol", name_is_custom=True)


def test_generic_chat_placeholders_and_single_word_truncation():
    assert needs_auto_name("Chat", "gpt-6.1-sol")
    assert needs_auto_name("Chat: something", "gpt-6.1-sol")
    assert not needs_auto_name("Chat", "gpt-6.1-sol", name_is_custom=True)
    title = request_title("x" * 120)
    assert title == "Chat: " + "x" * 63 + "…"
