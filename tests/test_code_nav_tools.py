"""Tests for the code-navigation tools (grep, glob, ls) + read_file line range."""
import os
import json
import shutil
import asyncio
import tempfile
import pytest

os.environ.setdefault("DATABASE_URL", "sqlite:////tmp/test_code_nav.db")

from src.tool_execution import _direct_fallback


def _run(tool, content):
    return asyncio.run(_direct_fallback(tool, content))


@pytest.fixture
def repo():
    # Build under /tmp; the tool should report the stable sealed-workspace
    # alias rather than exposing this host path.
    root = os.path.realpath(tempfile.mkdtemp(dir="/tmp", prefix="codenav_"))
    try:
        with open(os.path.join(root, "a.py"), "w") as f:
            f.write("import os\n# needle here\nprint('x')\n")
        os.mkdir(os.path.join(root, "sub"))
        with open(os.path.join(root, "sub", "b.txt"), "w") as f:
            f.write("nothing\nNEEDLE upper\n")
        os.mkdir(os.path.join(root, "sub", "deep"))
        with open(os.path.join(root, "sub", "deep", "c.py"), "w") as f:
            f.write("# deep python\n")
        os.mkdir(os.path.join(root, "node_modules"))
        with open(os.path.join(root, "node_modules", "dep.py"), "w") as f:
            f.write("needle in dep\n")
        g = os.path.join(root, ".git")
        os.mkdir(g)
        with open(os.path.join(g, "config"), "w") as f:
            f.write("needle in git\n")
        yield root
    finally:
        shutil.rmtree(root, ignore_errors=True)


# ── grep ──────────────────────────────────────────────────────────────────

def test_grep_finds_match(repo):
    r = _run("grep", f'{{"pattern": "needle", "path": "{repo}"}}')
    assert r["exit_code"] == 0
    assert "a.py:2:" in r["output"]


def test_grep_skips_junk_dirs(repo):
    r = _run("grep", f'{{"pattern": "needle", "path": "{repo}"}}')
    assert "node_modules" not in r["output"]
    assert ".git/config" not in r["output"]


def test_grep_ignore_case(repo):
    r = _run("grep", f'{{"pattern": "needle", "ignore_case": true, "path": "{repo}"}}')
    assert "b.txt:2:" in r["output"]


def test_grep_glob_filter(repo, monkeypatch):
    r = _run("grep", f'{{"pattern": "needle", "ignore_case": true, "glob": "*.py", "path": "{repo}"}}')
    assert r["exit_code"] == 0
    assert "a.py" in r["output"]
    assert "b.txt" not in r["output"]

    # Positive control: verify that fallback path honors the exact same glob contract
    real_which = shutil.which
    monkeypatch.setattr(shutil, "which", lambda name, *a, **kw: None if name == "rg" else real_which(name, *a, **kw))
    r_fallback = _run("grep", f'{{"pattern": "needle", "ignore_case": true, "glob": "*.py", "path": "{repo}"}}')
    assert r_fallback["exit_code"] == 0
    assert "a.py" in r_fallback["output"]
    assert "b.txt" not in r_fallback["output"]


def test_grep_no_match(repo):
    r = _run("grep", f'{{"pattern": "zzzznotfound", "path": "{repo}"}}')
    assert r["exit_code"] == 0
    assert "No matches" in r["output"]


def test_grep_requires_pattern(repo):
    r = _run("grep", "{}")
    assert r["exit_code"] == 1
    assert "pattern is required" in r["error"]


def test_grep_path_outside_roots_rejected(repo):
    r = _run("grep", '{"pattern": "x", "path": "/etc"}')
    assert r["exit_code"] == 1
    assert "outside the allowed roots" in r["error"]


def test_grep_python_fallback_when_no_rg(repo, monkeypatch):
    monkeypatch.setattr(shutil, "which", lambda name: None)
    r = _run("grep", f'{{"pattern": "needle", "path": "{repo}"}}')
    assert r["exit_code"] == 0
    assert "a.py:2:" in r["output"]
    assert "node_modules" not in r["output"]
    assert ".git/config" not in r["output"]


def test_grep_python_fallback_uses_relative_glob_paths(repo, monkeypatch):
    monkeypatch.setattr(shutil, "which", lambda name: None)
    r = _run(
        "grep",
        f'{{"pattern": "needle|python", "glob": "**/*.py", "path": "{repo}"}}',
    )
    assert r["exit_code"] == 0
    assert "a.py" in r["output"]
    assert "sub/deep/c.py" in r["output"]


@pytest.mark.skipif(shutil.which("rg") is None, reason="targets the ripgrep fast-path")
def test_grep_skips_case_variant_sensitive_files_rg(repo):
    """The rg fast-path must exclude deny-listed key files case-insensitively.

    A file whose name is a case variant of a sensitive pattern (e.g. ID_RSA vs
    id_rsa, Known_Hosts vs known_hosts) points at the same secret on a
    case-insensitive filesystem, so grep must not return its contents. The
    Python fallback already folds case via _is_sensitive_path; a plain --glob
    exclusion is case-sensitive, so it would leak these — this pins the rg path.
    """
    token = "GREPSECRET_TOKEN_ZZZ"
    with open(os.path.join(repo, "notes.txt"), "w") as f:
        f.write(f"see {token}\n")
    with open(os.path.join(repo, "ID_RSA"), "w") as f:
        f.write(f"PRIVATE {token}\n")
    with open(os.path.join(repo, "Known_Hosts"), "w") as f:
        f.write(f"host {token}\n")
    r = _run("grep", f'{{"pattern": "{token}", "path": "{repo}"}}')
    assert r["exit_code"] == 0
    assert "notes.txt" in r["output"]        # ordinary matches still returned
    assert "ID_RSA" not in r["output"]        # case-variant key excluded
    assert "Known_Hosts" not in r["output"]


# ── glob ──────────────────────────────────────────────────────────────────

def test_glob_py(repo):
    r = _run("glob", f'{{"pattern": "*.py", "path": "{repo}"}}')
    assert r["exit_code"] == 0
    assert "a.py" in r["output"]


def test_glob_recursive_skips_junk(repo):
    r = _run("glob", f'{{"pattern": "**/*.py", "path": "{repo}"}}')
    assert "a.py" in r["output"]
    assert "node_modules" not in r["output"]


def test_glob_requires_pattern(repo):
    r = _run("glob", "{}")
    assert r["exit_code"] == 1


def test_glob_literal_in_subdir(repo):
    """Bare literal should match at any depth (like rglob), not only at root."""
    r = _run("glob", f'{{"pattern": "b.txt", "path": "{repo}"}}')
    assert r["exit_code"] == 0
    assert "b.txt" in r["output"]


def test_absolute_glob_stays_inside_explicit_search_root(repo):
    inside = _run("glob", json.dumps({"pattern": os.path.join(repo, "sub", "*.txt"), "path": repo}))
    assert inside["exit_code"] == 0
    assert "b.txt" in inside["output"]
    outside = _run("glob", json.dumps({"pattern": os.path.join(repo, "*.py"), "path": os.path.join(repo, "sub")}))
    assert outside["exit_code"] == 0
    assert "No files" in outside["output"]


def test_glob_multi_segment_single_star(repo):
    """sub/*.txt matches sub/b.txt but NOT sub/deep/c.py (single * stays in one segment)."""
    r = _run("glob", f'{{"pattern": "sub/*.txt", "path": "{repo}"}}')
    assert r["exit_code"] == 0
    assert "b.txt" in r["output"]
    assert "c.py" not in r["output"]


def test_glob_star_does_not_cross_slash(repo):
    """src/*.py must NOT match src/a/b/x.py — * is single-segment only."""
    r = _run("glob", f'{{"pattern": "sub/*.py", "path": "{repo}"}}')
    assert r["exit_code"] == 0
    # sub/ has no .py directly, only sub/deep/c.py — should NOT match
    assert "No files matching" in r["output"]


def test_glob_double_star_matches_deep(repo):
    """**/*.py should match files at any depth."""
    r = _run("glob", f'{{"pattern": "**/*.py", "path": "{repo}"}}')
    assert r["exit_code"] == 0
    assert "a.py" in r["output"]
    assert "c.py" in r["output"]


def test_glob_explicit_generated_prefix_searches_output_safely(repo):
    generated_files = {
        "dist": os.path.join(repo, "dist", "main", "index.js"),
        "build": os.path.join(repo, "build", "app.js"),
        ".next": os.path.join(repo, ".next", "server.js"),
    }
    for path in generated_files.values():
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write("generated output\n")
    os.makedirs(os.path.join(repo, "dist", "node_modules"))
    with open(os.path.join(repo, "dist", "node_modules", "ignored.js"), "w") as f:
        f.write("dependency\n")
    os.makedirs(os.path.join(repo, "dist", ".ssh"))
    with open(os.path.join(repo, "dist", ".ssh", "id_rsa"), "w") as f:
        f.write("secret\n")
    with open(os.path.join(repo, "dist", ".env"), "w") as f:
        f.write("secret\n")

    broad = _run("glob", f'{{"pattern": "**/*.js", "path": "{repo}"}}')
    for generated in generated_files.values():
        assert generated not in broad["output"]

    explicit_outputs = {}
    for output_dir, generated in generated_files.items():
        explicit = _run("glob", f'{{"pattern": "{output_dir}/**/*", "path": "{repo}"}}')
        assert explicit["exit_code"] == 0
        assert generated in explicit["output"]
        explicit_outputs[output_dir] = explicit["output"]
    assert "ignored.js" not in explicit_outputs["dist"]
    assert ".ssh" not in explicit_outputs["dist"]
    assert ".env" not in explicit_outputs["dist"]


# ── ls ────────────────────────────────────────────────────────────────────

def test_ls_lists_entries(repo):
    r = _run("ls", f'{{"path": "{repo}"}}')
    assert r["exit_code"] == 0
    assert "a.py" in r["output"]
    assert "sub/" in r["output"]
    assert ".git" not in r["output"]  # hidden skipped


def test_ls_path_outside_rejected(repo):
    r = _run("ls", '{"path": "/etc"}')
    assert r["exit_code"] == 1
    assert "outside the allowed roots" in r["error"]


# ── read_file line range ───────────────────────────────────────────────────

def test_read_file_offset_limit(repo):
    p = os.path.join(repo, "lines.txt")
    with open(p, "w") as f:
        f.write("\n".join(f"line{i}" for i in range(1, 11)) + "\n")
    r = _run("read_file", f'{{"path": "{p}", "offset": 3, "limit": 2}}')
    assert r["exit_code"] == 0
    assert r["output"].startswith("line3\nline4\n")
    assert "more lines available; continue with offset=5" in r["output"]
    assert r["read_metadata"] == {
        "start_line": 3, "reached_eof": False, "next_offset": 5,
    }


def test_read_file_offset_limit_at_eof_has_no_pagination_notice(repo):
    p = os.path.join(repo, "short.txt")
    with open(p, "w") as f:
        f.write("one\ntwo\nthree\nfour\n")
    r = _run("read_file", f'{{"path": "{p}", "offset": 3, "limit": 2}}')
    assert r["exit_code"] == 0
    assert r["output"] == "three\nfour\n"
    assert r["read_metadata"] == {"start_line": 3, "reached_eof": True}

    beyond = _run("read_file", f'{{"path": "{p}", "offset": 99, "limit": 2}}')
    assert beyond["output"] == "[End of file: requested line 99; file has 4 lines.]"
    assert beyond["read_metadata"] == {"start_line": 99, "reached_eof": True}


def test_read_file_empty_file_reports_eof_without_changing_offsets(repo):
    p = os.path.join(repo, "empty.txt")
    open(p, "w").close()

    plain = _run("read_file", p)
    assert plain["exit_code"] == 0
    assert plain["output"] == "[End of file: file is empty (0 lines).]"
    assert plain["read_metadata"] == {"start_line": 1, "reached_eof": True}

    offset = _run("read_file", f'{{"path": "{p}", "offset": 7, "limit": 2}}')
    assert offset["output"] == "[End of file: file is empty (0 lines).]"
    assert offset["read_metadata"] == {"start_line": 7, "reached_eof": True}


def test_read_file_preserves_existing_content_and_line_offsets(repo):
    p = os.path.join(repo, "content.txt")
    with open(p, "w") as f:
        f.write("first\nsecond\nthird\n")

    r = _run("read_file", f'{{"path": "{p}", "offset": 2, "limit": 1}}')
    assert r["output"] == "second\n\n... [more lines available; continue with offset=3]"
    assert r["read_metadata"] == {
        "start_line": 2, "reached_eof": False, "next_offset": 3,
    }


def test_read_file_char_cap_reports_next_offset(repo, monkeypatch):
    from src.agent_tools import filesystem_tools

    p = os.path.join(repo, "large.txt")
    with open(p, "w") as f:
        f.write("aa\nbb\ncc\ndd\n")
    monkeypatch.setattr(filesystem_tools, "MAX_READ_CHARS", 5)
    r = _run("read_file", f'{{"path": "{p}", "offset": 1, "limit": 10}}')
    assert r["exit_code"] == 0
    assert "truncated at 5 chars; continue with offset=3" in r["output"]
    assert r["read_metadata"] == {
        "start_line": 1, "reached_eof": False, "next_offset": 3,
    }

    plain = _run("read_file", p)
    assert plain["output"] == "aa\nbb\n... [truncated at 5 chars]"
    assert plain["read_metadata"] == {
        "start_line": 1, "reached_eof": False, "next_offset": 2,
    }
    from src.tool_execution import format_tool_result
    formatted = format_tool_result("read file", plain)
    assert "Read status: more file content remains from line 1." in formatted
    assert "Continue with offset=2." in formatted


def test_read_file_plain_path_backcompat(repo):
    r = _run("read_file", os.path.join(repo, "a.py"))
    assert r["exit_code"] == 0
    assert "needle" in r["output"]


def test_workspace_reports_existing_child_projects_without_rebinding(repo):
    from src.tool_execution import _active_workspace, get_active_workspace
    project = os.path.join(repo, 'FFmpegNexus')
    os.mkdir(project)
    with open(os.path.join(project, 'package.json'), 'w') as f:
        f.write('{}')
    # Never follow links or inspect dependencies as candidate projects.
    os.symlink(project, os.path.join(repo, 'linked-project'))
    with open(os.path.join(repo, 'node_modules', 'package.json'), 'w') as f:
        f.write('{}')
    token = _active_workspace.set(repo)
    try:
        result = _run('get_workspace', '')
        display_project = '/workspace/FFmpegNexus'
        assert display_project in result['output']
        assert repo not in result['output']
        candidates = result['output'].split('Immediate child project candidates', 1)[1]
        assert display_project in candidates
        assert 'linked-project' not in candidates
        assert 'node_modules' not in candidates
        assert 'cd affects only that single shell call' in result['output']
        assert 'A .git marker alone does not prove a complete checkout' in result['output']
        assert 'Do not delete existing projects to retry a clone' in result['output']
        assert 'blob-filtered fetch and sparse checkout' in result['output']
        assert get_active_workspace() == repo
        missing = _run('read_file', os.path.join(repo, 'package.json'))
        assert missing['exit_code'] == 1
        assert 'FFmpegNexus' in missing['error']
        assert 'does NOT mean the project is missing' in missing['error']
        assert not os.path.exists(os.path.join(repo, 'package.json'))
    finally:
        _active_workspace.reset(token)

def test_read_file_extracts_structured_documents(repo, monkeypatch):
    p = os.path.join(repo, "report.docx")
    with open(p, "wb") as f:
        f.write(b"PK fake structured document")

    calls = []

    def _fake_extract(path, **kwargs):
        calls.append((path, kwargs))
        return "Heading\nFirst fact\nSecond fact\n"

    monkeypatch.setattr(
        "src.document_processor.extract_local_document",
        _fake_extract,
    )

    r = _run("read_file", f'{{"path": "{p}", "offset": 2, "limit": 2}}')

    assert r == {
        "output": "First fact\nSecond fact\n",
        "exit_code": 0,
        "read_metadata": {"start_line": 2, "reached_eof": True},
    }
    assert calls == [(p, {
        "display_name": "report.docx",
        "analyze_embedded_images": False,
    })]


def test_read_file_extracts_legacy_word_documents(repo, monkeypatch):
    p = os.path.join(repo, "report.doc")
    with open(p, "wb") as f:
        f.write(b"binary OLE document")

    calls = []

    def _fake_extract(path, **kwargs):
        calls.append((path, kwargs))
        return "Legacy Word content\nShipping price\n"

    monkeypatch.setattr("src.document_processor.extract_local_document", _fake_extract)
    r = _run("read_file", p)

    assert r == {
        "output": "Legacy Word content\nShipping price\n",
        "exit_code": 0,
        "read_metadata": {"start_line": 1, "reached_eof": True},
    }
    assert calls == [(p, {
        "display_name": "report.doc",
        "analyze_embedded_images": False,
    })]
