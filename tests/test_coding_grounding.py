from src.coding_grounding import CodingGrounding


def task():
    return "Build a new app using a third-party framework and SDK."


def test_substantive_task_requires_observed_sources_before_mutation():
    gate = CodingGrounding(task())
    assert "web_fetch" in gate.research_tools
    assert not gate.may_mutate
    assert "Deep Research" in gate.directive

    # A search result is only a lead, even when the search itself succeeded.
    assert not gate.observe("web_search", {
        "output": "Framework docs result", "sources": [], "exit_code": 0,
    }, "framework setup")
    assert gate.failures == 0
    assert not gate.may_mutate
    assert gate.observe("web_fetch", {
        "output": "Official installation guide", "exit_code": 0,
    }, "https://framework.example/docs/install")
    assert gate.may_mutate


def test_local_docs_qualify_but_source_code_and_errors_do_not():
    gate = CodingGrounding(task(), web_allowed=False)
    assert "web_search" not in gate.research_tools
    assert not gate.observe("read_file", {"output": "source", "exit_code": 0}, "src/main.py")
    assert not gate.observe("read_file", {"error": "missing", "exit_code": 1}, "README.md")
    assert gate.observe("read_file", {"output": "Use framework v2", "exit_code": 0}, "README.md")
    assert gate.may_mutate


def test_failed_lookup_escape_is_bounded_and_respects_disabled_tools():
    gate = CodingGrounding(task(), disabled_tools={"read_file", "web_search", "web_fetch",
                                                    "mcp__builtin_browser__browser_snapshot",
                                                    "get_workspace", "ls", "glob", "grep",
                                                    "search_tools", "ask_user", "manage_skills"})
    assert gate.research_tools == set()
    assert gate.may_mutate

    gate = CodingGrounding(task())
    assert not gate.observe("web_fetch", {"error": "timeout", "exit_code": 1}, "https://x")
    assert not gate.may_mutate
    assert not gate.observe("web_fetch", {"error": "404", "exit_code": 1}, "https://x")
    assert gate.may_mutate


def test_navigation_and_questions_do_not_spend_failure_budget():
    gate = CodingGrounding(task())
    for name in ("get_workspace", "ls", "glob", "grep", "search_tools", "ask_user"):
        assert not gate.observe(name, {"output": "no result", "exit_code": 0}, "")
    assert gate.attempts == gate.failures == 0
    assert not gate.may_mutate


def test_task_url_is_fetched_before_local_manifest_counts():
    task_with_url = "Build a GUI using this library: https://vendor.example/docs/api."
    gate = CodingGrounding(task_with_url)
    assert gate.required
    assert not gate.observe("read_file", {"output": "manifest", "exit_code": 0}, "package.json")
    assert not gate.may_mutate
    assert not gate.observe("web_fetch", {"output": "wrong page", "exit_code": 0},
                            "https://other.example/docs")
    assert gate.observe("web_fetch", {"output": "API reference", "exit_code": 0},
                        '{"url":"https://vendor.example/docs/api"}')
    assert gate.may_mutate


def test_github_blob_url_matches_only_corresponding_raw_revision_and_path():
    gate = CodingGrounding(
        "Build a GUI with this documentation: "
        "https://github.com/nerdrx/nx-hub/blob/main/docs/DESIGN.md."
    )
    result = {"output": "Design documentation", "exit_code": 0}
    assert gate.observe(
        "web_fetch", result,
        "https://raw.githubusercontent.com/nerdrx/nx-hub/main/docs/DESIGN.md",
    )
    assert gate.may_mutate

    for wrong_url in (
        "https://raw.githubusercontent.com/nerdrx/other-repo/main/docs/DESIGN.md",
        "https://raw.githubusercontent.com/nerdrx/nx-hub/dev/docs/DESIGN.md",
        "https://raw.githubusercontent.com/nerdrx/nx-hub/main/docs/OTHER.md",
    ):
        gate = CodingGrounding(
            "Build a GUI with this documentation: "
            "https://github.com/nerdrx/nx-hub/blob/main/docs/DESIGN.md."
        )
        assert not gate.observe("web_fetch", result, wrong_url)
        assert not gate.may_mutate


def test_trivial_edits_and_guidance_skip_gate_but_no_web_keeps_local_gate():
    for text, kwargs in [
        ("Fix the typo in README.md", {}),
        ("How do I configure this framework?", {}),
        (task(), {"plan_mode": True}),
        (task(), {"guide_mode": True}),
    ]:
        gate = CodingGrounding(text, **kwargs)
        assert not gate.required
        assert gate.may_mutate
        assert gate.directive == ""

    offline = CodingGrounding(task() + " Work offline; no web.")
    assert offline.required
    assert not offline.web_allowed
    assert "web_search" not in offline.research_tools
    assert "local project documentation only" in offline.directive


def test_explicit_without_browsing_stays_local():
    gate = CodingGrounding("Build a GUI without browsing")
    assert not gate.web_allowed
    assert "web_fetch" not in gate.research_tools


def test_directive_points_to_requested_documentation_before_search():
    url = "https://vendor.example/docs/gui"
    gate = CodingGrounding(f"Build a GUI app using {url}")
    assert url in gate.directive
    assert "next documentation lookup should be web_fetch" in gate.directive
    offline = CodingGrounding(f"Build a GUI app offline using local docs; source: {url}")
    assert "next documentation lookup should be web_fetch" not in offline.directive


def test_skill_reads_are_allowed_but_do_not_replace_documentation():
    gate = CodingGrounding('Build a GUI app following https://vendor.example/docs')
    assert 'manage_skills' in gate.research_tools
    for action in ('list', 'index', 'view', 'view_ref', 'search'):
        assert gate.allows_tool('manage_skills', '{"action":"' + action + '","name":"ui-design"}')
    for action in ('add', 'edit', 'delete', 'import', ''):
        assert not gate.allows_tool('manage_skills', '{"action":"' + action + '"}')
    assert not gate.allows_tool('manage_skills', 'malformed')
    gate.observe('manage_skills', {'output': 'A design procedure', 'exit_code': 0}, '{"action":"view"}')
    assert gate.attempts == 0
    assert not gate.may_mutate
    disabled = CodingGrounding('Build a GUI app', disabled_tools={'manage_skills'})
    assert not disabled.allows_tool('manage_skills', '{"action":"view"}')


def test_skill_discovery_alone_cannot_trap_tasks_when_source_reads_disabled():
    gate = CodingGrounding('Build a GUI app', disabled_tools={'web_search', 'web_fetch', 'read_file'})
    assert 'manage_skills' in gate.research_tools
    assert gate.may_mutate
