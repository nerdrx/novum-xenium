import json

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


def test_explicit_github_url_allows_only_canonical_and_strict_https_alias():
    canonical = "https://github.com/nerdrx/nx-hub/blob/main/docs/DESIGN.md"
    raw = "https://raw.githubusercontent.com/nerdrx/nx-hub/main/docs/DESIGN.md"
    gate = CodingGrounding(f"Build a GUI app using {canonical}")
    assert gate.requested_url_phase
    assert gate.requested_fetch_urls == sorted([canonical, raw])
    assert gate.allows_tool("web_fetch", json.dumps({"url": canonical}))
    assert gate.allows_tool("web_fetch", json.dumps({"url": raw}))

    unsafe_aliases = (
        raw + "?download=1",
        raw + "#section",
        "https://user@raw.githubusercontent.com/nerdrx/nx-hub/main/docs/DESIGN.md",
        "https://raw.githubusercontent.com:444/nerdrx/nx-hub/main/docs/DESIGN.md",
        "http://raw.githubusercontent.com/nerdrx/nx-hub/main/docs/DESIGN.md",
        "https://[malformed-host",
    )
    for url in unsafe_aliases:
        assert not gate.allows_tool("web_fetch", json.dumps({"url": url}))
        assert not gate.observe("web_fetch", {"error": "policy blocked", "exit_code": 1},
                                json.dumps({"url": url}))
    assert gate.attempts == gate.failures == 0


def test_alias_requires_exact_github_coordinates_and_clean_https_url():
    canonical = "https://github.com/nerdrx/nx-hub/blob/main/docs/DESIGN.md"
    gate = CodingGrounding(f"Build a GUI app using {canonical}")
    for wrong_url in (
        "https://raw.githubusercontent.com/other/nx-hub/main/docs/DESIGN.md",
        "https://raw.githubusercontent.com/nerdrx/nx-hub/v0.13.0/docs/DESIGN.md",
        "https://raw.githubusercontent.com/nerdrx/nx-hub/main/styles.css",
        "https://raw.githubusercontent.com/nerdrx/nx-hub/main/docs/DESIGN.md?raw=1",
    ):
        assert not gate.observe("web_fetch", {"output": "Wrong page", "exit_code": 0}, wrong_url)
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


def test_substantive_gui_repair_and_restyling_require_grounding():
    repair_request = (
        "Continue the original task in this workspace: a working FFmpeg desktop GUI. "
        "This is a repair after an independent acceptance test failed. "
        "Fix the native file/process bridge and layout. Compact the workflow and "
        "restyle the interface to match the guide."
    )
    assert CodingGrounding(repair_request).required
    assert CodingGrounding("Restyle the existing desktop GUI layout to match the guide.").required
    assert CodingGrounding("Redesign the app interface and screen workflow.").required


def test_gui_copy_edits_and_plan_or_guide_mode_stay_out_of_repair_gate():
    for text in (
        "Fix the button copy in the GUI.",
        "Correct the typo in the app's interface label.",
    ):
        assert not CodingGrounding(text).required
    repair = "Restyle the existing desktop GUI layout to match the guide."
    assert not CodingGrounding(repair, plan_mode=True).required
    assert not CodingGrounding(repair, guide_mode=True).required


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


def test_matched_skill_view_and_documentation_are_independent_requirements():
    gate = CodingGrounding(task())
    gate.set_skill_candidates(["gui-workflow"])
    assert gate.skill_review_pending
    assert not gate.may_mutate

    assert gate.observe("read_file", {"output": "Use framework v2", "exit_code": 0}, "README.md")
    assert not gate.may_mutate  # documentation does not count as viewing the procedure
    assert gate.observe("manage_skills", {"results": "Procedure body"},
                        '{"action":"view","name":"gui-workflow"}')
    assert not gate.skill_review_pending
    assert gate.may_mutate


def test_ui_design_requires_visual_verification_when_both_skills_match():
    gate = CodingGrounding(task())
    gate.set_skill_candidates(["ui-design", "visual-verification"])
    assert gate.observe("read_file", {"output": "Framework setup", "exit_code": 0}, "README.md")

    assert gate.observe("manage_skills", {"results": "Design procedure"},
                        '{"action":"view","name":"ui-design"}')
    assert gate.skill_review_pending
    assert not gate.may_mutate
    assert gate.pending_required_skill_names == ["visual-verification"]
    assert "`visual-verification`" in gate.directive
    assert "`ui-design`" not in gate.directive

    assert gate.observe("manage_skills", {"results": "Render and critique procedure"},
                        '{"action":"view","name":"visual-verification"}')
    assert not gate.skill_review_pending
    assert gate.may_mutate


def test_visual_skill_pair_unavailable_or_failed_still_uses_bounded_escape():
    unavailable = CodingGrounding(task())
    assert unavailable.observe("read_file", {"output": "Framework setup", "exit_code": 0}, "README.md")
    unavailable.set_skill_candidates(["ui-design", "visual-verification"], available=False)
    assert not unavailable.skill_candidates
    assert unavailable.may_mutate

    failed = CodingGrounding(task())
    failed.set_skill_candidates(["ui-design", "visual-verification"])
    assert failed.observe("read_file", {"output": "Framework setup", "exit_code": 0}, "README.md")
    assert failed.observe(
        "manage_skills", {"results": "Design procedure"},
        '{"action":"view","name":"ui-design"}',
    )
    assert not failed.observe(
        "manage_skills", {"error": "skill unavailable", "exit_code": 1},
        '{"action":"view","name":"visual-verification"}',
    )
    assert failed.skill_review_skipped is False
    assert failed.skill_view_attempts == failed.max_skill_view_attempts
    assert failed.may_mutate
    assert "procedure was not consulted" in failed.directive
    assert "Still unread: visual-verification" in failed.directive


def test_skill_view_must_match_a_suggested_candidate_and_failure_escape_is_bounded():
    gate = CodingGrounding(task())
    gate.set_skill_candidates(["gui-workflow"])
    gate.observe("read_file", {"output": "Use framework v2", "exit_code": 0}, "README.md")

    assert not gate.observe("manage_skills", {"results": "Other procedure"},
                            '{"action":"view","name":"unrelated"}')
    assert not gate.may_mutate
    assert not gate.observe("manage_skills", {"error": "not found", "exit_code": 1},
                            '{"action":"view","name":"gui-workflow"}')
    assert gate.may_mutate  # two completed, unsuccessful lookups release the gate
    assert "do not claim all required procedures were consulted" in gate.directive


def test_documentation_ready_pending_skill_exposes_only_skill_phase_tools():
    gate = CodingGrounding(task())
    gate.set_skill_candidates(["gui-workflow"])
    assert gate.observe("read_file", {"output": "Framework setup", "exit_code": 0}, "README.md")
    assert gate.phase_tools == {"manage_skills", "ask_user", "search_tools"}
    assert not gate.allows_tool("web_fetch", '{"url":"https://example.test"}')
    assert not gate.observe("web_fetch", {"error": "phase blocked", "exit_code": 1}, "https://example.test")
    assert gate.attempts == 1 and gate.failures == 0

    disabled = CodingGrounding(task(), disabled_tools={"search_tools", "manage_skills"})
    disabled.set_skill_candidates(["gui-workflow"], available=False)
    assert "manage_skills" not in disabled.phase_tools
    assert disabled.may_mutate is False  # documentation gate still applies


def test_skill_phase_directive_reports_documentation_truth_without_more_lookups():
    verified = CodingGrounding(task())
    verified.set_skill_candidates(["gui-workflow"])
    assert verified.observe("read_file", {"output": "Framework setup", "exit_code": 0}, "README.md")
    assert "documentation source was successfully verified" in verified.directive
    assert "web_search" not in verified.directive and "web_fetch" not in verified.directive

    unavailable = CodingGrounding("Build a GUI app following https://vendor.example/docs")
    unavailable.set_skill_candidates(["gui-workflow"])
    for i in range(unavailable.max_attempts):
        unavailable.observe("web_search", {"output": f"Snippet {i}", "exit_code": 0}, "query")
    assert "No documentation source was verified" in unavailable.directive
    assert "web_search" not in unavailable.directive and "web_fetch" not in unavailable.directive


def test_pending_approval_does_not_count_as_skill_view_or_failed_lookup():
    gate = CodingGrounding(task())
    gate.set_skill_candidates(["gui-workflow"])
    gate.observe("read_file", {"output": "Use framework v2", "exit_code": 0}, "README.md")

    assert not gate.observe("manage_skills", {"approval_required": True},
                            '{"action":"view","name":"gui-workflow"}')
    assert gate.skill_view_attempts == 0
    assert not gate.may_mutate
    assert gate.observe("manage_skills", {"results": "Procedure body"},
                        '{"action":"view","name":"gui-workflow"}')
    assert gate.may_mutate


def test_skill_candidate_settings_and_tool_availability_can_skip_the_read_gate():
    gate = CodingGrounding(task())
    gate.set_skill_candidates(["gui-workflow"], available=False)
    assert not gate.skill_candidates
    assert gate.may_mutate is False  # the independent documentation gate remains

    docs_only = CodingGrounding(task(), disabled_tools={"manage_skills"})
    docs_only.set_skill_candidates(["gui-workflow"])
    assert not docs_only.skill_candidates
    assert "manage_skills" not in docs_only.research_tools


def test_skill_discovery_alone_cannot_trap_tasks_when_source_reads_disabled():
    gate = CodingGrounding('Build a GUI app', disabled_tools={'web_search', 'web_fetch', 'read_file'})
    assert 'manage_skills' in gate.research_tools
    assert gate.may_mutate
