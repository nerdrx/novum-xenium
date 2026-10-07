import stat

import pytest

from src import tool_result_store as store


def test_results_are_isolated_by_owner_and_session_and_persist(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", str(tmp_path))
    result_id = store.archive_result("alice", "run-1", "browser", "needle in saved result")

    assert str(result_id) in store.search_results("alice", "run-1", "needle")
    assert "No matching" in store.search_results("bob", "run-1", "needle")
    assert "No matching" in store.search_results("alice", "run-2", "needle")
    directory = tmp_path / "tool_context"
    assert stat.S_IMODE(directory.stat().st_mode) == 0o700
    db_file = next(directory.glob("*.sqlite3"))
    assert stat.S_IMODE(db_file.stat().st_mode) == 0o600


def test_chunk_search_finds_tail_and_empty_query_paginates(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", str(tmp_path))
    result_id = store.archive_result("alice", "run", "terminal", "head " + "x " * 6000 + "tailneedle")

    found = store.search_results("alice", "run", "tailneedle", result_id)
    assert f"[{result_id} | terminal | chunk 6]" in found
    assert "tailneedle" in found
    assert len(found) <= store._OUTPUT_LIMIT

    page = store.search_results("alice", "run", "", result_id, offset=0)
    tail_page = store.search_results("alice", "run", "", result_id, offset=6)
    assert "next_offset=2" in page
    assert "chunk 6" in tail_page and "end." in tail_page


def test_query_operators_are_data_and_output_is_bounded(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", str(tmp_path))
    store.archive_result("alice", "run", "tool", "alpha " * 5000)

    result = store.search_results("alice", "run", 'alpha" OR tool:* --')
    assert "No matching" not in result
    assert len(result) <= store._OUTPUT_LIMIT
    assert "alpha" in result


def test_oversize_result_is_explicitly_capped_and_keeps_tail(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", str(tmp_path))
    result_id = store.archive_result("alice", "run", "fetch", "a" * (1024 * 1024 + 100) + " endneedle")

    assert "capped" in store.search_results("alice", "run", "capped", result_id)
    assert "endneedle" in store.search_results("alice", "run", "endneedle", result_id)


def test_oldest_results_are_evicted_to_session_limit(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(store, "_SESSION_LIMIT", 25)
    store.archive_result("alice", "run", "tool", "oldneedle " * 2)
    store.archive_result("alice", "run", "tool", "newneedle " * 2)

    assert "No matching" in store.search_results("alice", "run", "oldneedle")
    assert "newneedle" in store.search_results("alice", "run", "newneedle")


def test_results_expire_on_read_and_write(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(store, "_TTL_SECONDS", 10)
    clock = [100.0]
    monkeypatch.setattr(store.time, "time", lambda: clock[0])
    store.archive_result("alice", "run", "tool", "oldneedle")

    clock[0] += 11
    assert "No matching" in store.search_results("alice", "run", "oldneedle")
    store.archive_result("alice", "run", "tool", "newneedle")
    assert "newneedle" in store.search_results("alice", "run", "newneedle")


def test_delete_removes_only_exact_owner_and_session(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", str(tmp_path))
    store.archive_result("alice", "run", "tool", "targetneedle")
    store.archive_result("alice", "other-run", "tool", "otherneedle")
    store.archive_result("bob", "run", "tool", "bobneedle")

    assert store.delete_results("alice", "run")
    assert not store.delete_results("alice", "run")
    assert "No matching" in store.search_results("alice", "run", "targetneedle")
    assert "otherneedle" in store.search_results("alice", "other-run", "otherneedle")
    assert "bobneedle" in store.search_results("bob", "run", "bobneedle")
    # Clearing archived context is not session deletion; later tool output stays archivable.
    store.archive_result("alice", "run", "tool", "after-clear")
    assert "after-clear" in store.search_results("alice", "run", "after-clear")


def test_context_stats_scope_owner_and_session_even_in_shared_store(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", str(tmp_path))
    shared_db = tmp_path / "shared.sqlite3"
    monkeypatch.setattr(store, "_scope_file", lambda owner, session_id: shared_db)
    alice = "alice result"
    store.archive_result("alice", "run", "tool", alice)
    store.archive_result("bob", "run", "tool", "other owner")
    store.archive_result("alice", "other-run", "tool", "other session")

    assert store.get_result_stats("alice", "run") == {"count": 1, "bytes": len(alice)}
    assert store.get_result_stats("bob", "run") == {"count": 1, "bytes": len("other owner")}
    assert store.get_result_stats("alice", "other-run") == {"count": 1, "bytes": len("other session")}


def test_missing_session_and_negative_offset_are_rejected(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", str(tmp_path))
    with pytest.raises(ValueError, match="session_id is required"):
        store.archive_result("alice", "", "tool", "text")
    with pytest.raises(ValueError, match="session_id is required"):
        store.search_results("alice", "", "needle")
    assert "non-negative" in store.search_results("alice", "run", "needle", offset=-1)
