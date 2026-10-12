from concurrent.futures import ThreadPoolExecutor

from services.memory.skills import SkillsManager


def _setup(monkeypatch, tmp_path, *, skills_enabled=True):
    import routes.prefs_routes as prefs_routes
    import src.runtime_paths as runtime_paths

    monkeypatch.setattr(prefs_routes, "_load_for_user",
                        lambda _owner: {"skills_enabled": skills_enabled})
    monkeypatch.setattr(runtime_paths, "get_app_root",
                        lambda: str(tmp_path / "app"))
    bundle = tmp_path / "app" / "agent-skills"
    from pathlib import Path
    source_root = Path(__file__).resolve().parents[1] / "agent-skills"
    for name in ("ui-design", "visual-verification"):
        target = bundle / name
        target.mkdir(parents=True)
        (bundle / name / "SKILL.md").write_text(
            (source_root / name / "SKILL.md").read_text(encoding="utf-8"),
            encoding="utf-8",
        )
    return SkillsManager(str(tmp_path / "data"))


def test_fresh_owner_discovers_and_loads_bundled_design_skills(monkeypatch, tmp_path):
    manager = _setup(monkeypatch, tmp_path)

    # Anonymous/global reads preserve their existing behavior.
    assert manager.load() == []
    skills = manager.load(owner="alice")
    assert {item["name"] for item in skills} == {"ui-design", "visual-verification"}
    assert {item["name"] for item in manager.index_for(owner="alice")} == {
        "ui-design", "visual-verification",
    }
    assert manager.index_for(owner="alice", active_toolsets={"manage_skills"}) == []
    matched = manager.get_relevant_skills(
        "Build a GUI app and verify rendered interface",
        skills=skills,
        threshold=0.25,
    )
    assert {item["name"] for item in matched} == {"ui-design", "visual-verification"}
    assert "rendered" in manager.read_skill_md(
        "visual-verification", owner="alice",
    ).lower()


def test_existing_owner_skill_is_preserved_and_other_owner_collision_is_isolated(
    monkeypatch, tmp_path,
):
    manager = _setup(monkeypatch, tmp_path)
    manager.add_skill(
        owner="bob", name="visual-verification", description="Bob's skill",
        procedure=["Private procedure"], status="published", source="user",
    )
    existing = manager.add_skill(
        owner="alice", name="ui-design", description="Alice's custom design",
        procedure=["Keep my procedure"], status="published", source="user",
    )
    before = manager.read_skill_md("ui-design", owner="alice")

    alice = manager.load(owner="alice")
    assert next(item for item in alice if item["name"] == "ui-design")["description"] == existing["description"]
    assert manager.read_skill_md("ui-design", owner="alice") == before
    assert "visual-verification-2" in {item["name"] for item in alice}

    # The bundled collision gets a safe owner-local name; Bob's copy stays private.
    alice = manager.load(owner="alice")
    bob = manager.load(owner="bob")
    assert "visual-verification-2" in {item["name"] for item in alice}
    assert "visual-verification" in {item["name"] for item in bob}
    assert "visual-verification-2" not in {item["name"] for item in bob}
    assert manager.read_skill_md("visual-verification-2", owner="bob") is None


def test_deleted_seed_does_not_reappear_and_load_is_thread_idempotent(monkeypatch, tmp_path):
    manager = _setup(monkeypatch, tmp_path)
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda _i: manager.load(owner="alice"), range(12)))
    assert all({item["name"] for item in result} == {
        "ui-design", "visual-verification",
    } for result in results)
    assert manager.delete_skill("ui-design", owner="alice")
    assert "ui-design" not in {item["name"] for item in manager.load(owner="alice")}


def test_disabled_skills_do_not_seed_until_enabled(monkeypatch, tmp_path):
    manager = _setup(monkeypatch, tmp_path, skills_enabled=False)
    assert manager.load(owner="alice") == []
    assert manager.load(owner="alice") == []


def test_collision_partial_install_retry_does_not_create_duplicate_names(monkeypatch, tmp_path):
    manager = _setup(monkeypatch, tmp_path)
    manager.add_skill(
        owner="bob", name="ui-design", description="Bob's private copy",
        procedure=["Keep private"], status="published", source="user",
    )
    original_import = manager.import_bundle_from_files
    calls = 0

    def fail_after_first(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("simulated interruption")
        return original_import(*args, **kwargs)

    monkeypatch.setattr(manager, "import_bundle_from_files", fail_after_first)
    manager.load(owner="alice")
    assert "ui-design-2" in {skill["name"] for skill in manager.load(owner="alice")}
    monkeypatch.setattr(manager, "import_bundle_from_files", original_import)
    alice = manager.load(owner="alice")

    alice_names = {skill["name"] for skill in alice}
    assert "ui-design-2" in alice_names
    assert "ui-design-3" not in alice_names
    assert "visual-verification" in alice_names
    assert "ui-design" in {skill["name"] for skill in manager.load(owner="bob")}


def test_unavailable_bootstrap_lock_does_not_hide_existing_skills(monkeypatch, tmp_path):
    manager = _setup(monkeypatch, tmp_path)
    manager.add_skill(owner="alice", name="custom", description="Existing skill",
                      procedure=["Keep this"], status="published", source="user")

    def unavailable(_owner):
        raise PermissionError("read-only skill library")

    monkeypatch.setattr(manager, "_install_bundled_design_skills", unavailable)
    assert [skill["name"] for skill in manager.load(owner="alice")] == ["custom"]
