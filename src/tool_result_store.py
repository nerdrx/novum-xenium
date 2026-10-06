"""Private, session-scoped storage and search for archived tool results."""

from __future__ import annotations

import hashlib
import os
import re
import sqlite3
import time
import uuid
from contextlib import closing
from pathlib import Path

from src.constants import DATA_DIR

_RESULT_LIMIT = 1024 * 1024
_SESSION_LIMIT = 20 * 1024 * 1024
_TTL_SECONDS = 30 * 24 * 60 * 60
_CHUNK_SIZE = 2000
_CHUNK_OVERLAP = 200
_OUTPUT_LIMIT = 6000


def _scope_digest(owner: str, session_id: str) -> str:
    if not isinstance(owner, str) or not owner.strip():
        raise ValueError("owner is required")
    if not isinstance(session_id, str) or not session_id.strip():
        raise ValueError("session_id is required")
    return hashlib.sha256((owner + "\0" + session_id).encode("utf-8")).hexdigest()


def _scope_file(owner: str, session_id: str) -> Path:
    return Path(DATA_DIR) / "tool_context" / f"{_scope_digest(owner, session_id)}.sqlite3"


def _scope_path(owner: str, session_id: str) -> Path:
    path = _scope_file(owner, session_id)
    directory = path.parent
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    os.close(fd)
    path.chmod(0o600)
    return path


def _connect(owner: str, session_id: str) -> sqlite3.Connection:
    conn = sqlite3.connect(_scope_path(owner, session_id), timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS results (
            id TEXT PRIMARY KEY,
            owner TEXT NOT NULL,
            session_id TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            body TEXT NOT NULL,
            size_bytes INTEGER NOT NULL,
            created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            result_id TEXT NOT NULL REFERENCES results(id) ON DELETE CASCADE,
            chunk_index INTEGER NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
            result_id UNINDEXED, chunk_index UNINDEXED, body
        );
        CREATE INDEX IF NOT EXISTS results_scope_time ON results(owner, session_id, created_at);
        CREATE INDEX IF NOT EXISTS chunks_result ON chunks(result_id);
    """)
    return conn


def _capped_text(text: str) -> str:
    raw = text.encode("utf-8")
    if len(raw) <= _RESULT_LIMIT:
        return text
    head_budget = int((_RESULT_LIMIT - 256) * 0.7)
    tail_budget = _RESULT_LIMIT - 256 - head_budget
    head = raw[:head_budget].decode("utf-8", "ignore")
    tail = raw[-tail_budget:].decode("utf-8", "ignore")
    omitted = len(raw) - len(head.encode("utf-8")) - len(tail.encode("utf-8"))
    marker = f"\n[… archived result capped; {omitted} middle bytes omitted, tail retained …]\n"
    return head + marker + tail


def _chunks(text: str) -> list[str]:
    chunks = []
    start = 0
    while start < len(text):
        end = min(start + _CHUNK_SIZE, len(text))
        chunks.append(text[start:end])
        if end == len(text):
            break
        start = end - _CHUNK_OVERLAP
    return chunks or [""]


def _delete_result(conn: sqlite3.Connection, result_id: str) -> None:
    chunk_ids = [row[0] for row in conn.execute(
        "SELECT id FROM chunks WHERE result_id = ?", (result_id,)
    )]
    conn.executemany("DELETE FROM chunk_fts WHERE rowid = ?", ((i,) for i in chunk_ids))
    conn.execute("DELETE FROM results WHERE id = ?", (result_id,))


def _purge_expired(conn: sqlite3.Connection, owner: str, session_id: str, cutoff: float) -> bool:
    expired_ids = [row[0] for row in conn.execute(
        "SELECT id FROM results WHERE owner = ? AND session_id = ? AND created_at < ?",
        (owner, session_id, cutoff),
    )]
    for result_id in expired_ids:
        _delete_result(conn, result_id)
    return bool(expired_ids)


def archive_result(owner: str, session_id: str, tool_name: str, text: str) -> str:
    """Persist an archived tool result and return its opaque ID."""
    if not isinstance(text, str):
        raise ValueError("text must be a string")
    if not isinstance(tool_name, str) or not tool_name:
        raise ValueError("tool_name is required")
    body = _capped_text(text)
    now = time.time()
    result_id = uuid.uuid4().hex
    conn = _connect(owner, session_id)
    evicted = False
    try:
        with conn:
            evicted = _purge_expired(conn, owner, session_id, now - _TTL_SECONDS)
            size_bytes = len(body.encode("utf-8"))
            conn.execute(
                "INSERT INTO results(id, owner, session_id, tool_name, body, size_bytes, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (result_id, owner, session_id, tool_name[:256], body, size_bytes, now),
            )
            for index, chunk in enumerate(_chunks(body)):
                chunk_id = conn.execute(
                    "INSERT INTO chunks(result_id, chunk_index) VALUES (?, ?)",
                    (result_id, index),
                ).lastrowid
                conn.execute(
                    "INSERT INTO chunk_fts(rowid, result_id, chunk_index, body) VALUES (?, ?, ?, ?)",
                    (chunk_id, result_id, index, chunk),
                )
            total = conn.execute(
                "SELECT COALESCE(SUM(size_bytes), 0) FROM results WHERE owner = ? AND session_id = ?",
                (owner, session_id),
            ).fetchone()[0]
            while total > _SESSION_LIMIT:
                oldest = conn.execute(
                    "SELECT id, size_bytes FROM results WHERE owner = ? AND session_id = ? "
                    "ORDER BY created_at, rowid LIMIT 1", (owner, session_id),
                ).fetchone()
                if oldest is None:
                    break
                _delete_result(conn, oldest["id"])
                total -= oldest["size_bytes"]
                evicted = True
        if evicted:
            conn.execute("VACUUM")
    finally:
        conn.close()
    return result_id


def delete_results(owner: str, session_id: str) -> bool:
    """Delete this exact owner's session archive without creating a store."""
    path = _scope_file(owner, session_id)
    existed = path.exists()
    for suffix in ("-journal", "-wal", "-shm"):
        Path(str(path) + suffix).unlink(missing_ok=True)
    path.unlink(missing_ok=True)
    return existed


def _match_query(query: str) -> str:
    # FTS5 receives only quoted word tokens; punctuation and operators stay data.
    tokens = re.findall(r"[^\W_]+", query, flags=re.UNICODE)
    return " OR ".join('"' + token.replace('"', '""') + '"' for token in tokens[:32])


def _trim_snippet(snippet: str, limit: int, focus_terms: list[str] | None = None) -> str:
    if len(snippet) <= limit:
        return snippet
    folded = snippet.casefold()
    match = next((folded.find(term.casefold()) for term in (focus_terms or [])
                  if folded.find(term.casefold()) >= 0), -1)
    start = max(0, min((match if match >= 0 else 0) - limit // 3, len(snippet) - limit))
    end = start + limit
    left = "…" if start else ""
    right = "…" if end < len(snippet) else ""
    return left + snippet[start:end][:limit - len(left) - len(right)] + right


def search_results(
    owner: str, session_id: str, query: str, result_id: str | None = None, offset: int = 0
) -> str:
    """Return bounded, highlighted matches within this owner's session only."""
    if not isinstance(owner, str) or not owner.strip():
        raise ValueError("owner is required")
    if not isinstance(session_id, str) or not session_id.strip():
        raise ValueError("session_id is required")
    if not isinstance(offset, int) or offset < 0:
        return "Offset must be a non-negative integer."
    if result_id is not None:
        if not isinstance(result_id, str) or not result_id:
            return "Result ID must be an opaque string."
    searching = isinstance(query, str) and bool(query.strip())
    query_terms = re.findall(r"[^\W_]+", query, flags=re.UNICODE)[:32] if searching else []
    match_query = _match_query(query) if searching else ""
    if searching and not match_query:
        return "No searchable terms provided."
    try:
        result_filter = " AND r.id = ?" if result_id is not None else ""
        cutoff = time.time() - _TTL_SECONDS
        params: tuple[object, ...] = (owner, session_id, cutoff)
        if result_id is not None:
            params += (result_id,)
        with closing(_connect(owner, session_id)) as conn:
            with conn:
                evicted = _purge_expired(conn, owner, session_id, cutoff)
                if searching:
                    sql = (
                        "SELECT r.id, r.tool_name, c.chunk_index, "
                        "snippet(chunk_fts, 2, '', '', ' … ', 32) AS snippet "
                        "FROM chunk_fts JOIN chunks c ON c.id = chunk_fts.rowid "
                        "JOIN results r ON r.id = c.result_id "
                        "WHERE chunk_fts MATCH ? AND r.owner = ? AND r.session_id = ?" + result_filter + " "
                        "ORDER BY bm25(chunk_fts), r.created_at DESC, r.rowid DESC, c.chunk_index LIMIT 5 OFFSET ?"
                    )
                    params = (match_query, owner, session_id)
                    if result_id is not None:
                        params += (result_id,)
                    params += (offset,)
                else:
                    sql = (
                        "SELECT r.id, r.tool_name, c.chunk_index, chunk_fts.body AS snippet "
                        "FROM chunks c JOIN results r ON r.id = c.result_id "
                        "JOIN chunk_fts ON chunk_fts.rowid = c.id "
                        "WHERE r.owner = ? AND r.session_id = ?" + result_filter + " "
                        "ORDER BY r.created_at DESC, r.rowid DESC, c.chunk_index LIMIT 3 OFFSET ?"
                    )
                    params = (owner, session_id)
                    if result_id is not None:
                        params += (result_id,)
                    params += (offset,)
                rows = conn.execute(sql, params).fetchall()
            if evicted:
                conn.execute("VACUUM")
    except (sqlite3.OperationalError, ValueError, TypeError):
        return "No matching archived results."
    output = []
    used = 0
    output.append(f"Archived chunks at offset {offset}; ")
    used += len(output[0]) + 40  # reserve room for next_offset/end metadata
    added = 0
    for row in rows:
        if not searching and added >= 2:
            break
        heading = f"[{row['id']} | {row['tool_name']} | chunk {row['chunk_index']}] "
        remaining = _OUTPUT_LIMIT - used - len(heading) - 1
        if remaining <= 0:
            break
        snippet = _trim_snippet(
            row["snippet"], min(1200 if searching else 2000, remaining), query_terms
        )
        line = heading + snippet
        if used + len(line) + 1 > _OUTPUT_LIMIT:
            break
        output.append(line)
        used += len(line) + 1
        added += 1
    if not added:
        return "No matching archived results."
    next_offset = offset + added
    output[0] += f"next_offset={next_offset}." if len(rows) > added else "end."
    return "\n".join(output)
