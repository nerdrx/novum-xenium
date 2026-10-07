import json

import pytest

from services.memory import skill_extractor


class _Session:
    session_id = "session-1"

    def get_context_messages(self):
        return [{"role": "user", "content": "Deploy the service safely"}]


class _SkillsManager:
    def __init__(self):
        self.added = []

    def load(self, owner=None):
        return []

    def add_skill(self, **kwargs):
        self.added.append(kwargs)
        return {"id": "skill-1", **kwargs}


def _response(confidence):
    return json.dumps({
        "title": "Deploy safely",
        "problem": "Deployments can fail.",
        "solution": "Use the verified release procedure.",
        "steps": ["Build", "Deploy", "Verify"],
        "tags": ["deploy"],
        "confidence": confidence,
    })


async def _extract(monkeypatch, *, confidence, owner="alice", prefs=None, global_min=0.85):
    seen_owners = []

    async def fake_llm_call_async(*args, **kwargs):
        return _response(confidence)

    def fake_load_for_user(user):
        seen_owners.append(user)
        return prefs or {}

    monkeypatch.setattr("src.llm_core.llm_call_async", fake_llm_call_async)
    monkeypatch.setattr("routes.prefs_routes._load_for_user", fake_load_for_user)
    monkeypatch.setattr("src.settings.get_setting", lambda name, default=None: global_min)
    manager = _SkillsManager()
    result = await skill_extractor.maybe_extract_skill(
        _Session(), manager, "http://endpoint", "test-model", {}, 3, 3, owner=owner,
    )
    return result, manager, seen_owners


async def test_autopublish_uses_owner_threshold_and_keeps_valid_low_score_as_draft(monkeypatch):
    result, manager, seen = await _extract(
        monkeypatch,
        confidence=0.8,
        prefs={"auto_approve_skills": True, "skill_min_confidence": 0.9},
    )

    assert result["status"] == "draft"
    assert result["confidence"] == 0.8
    assert manager.added[0]["confidence"] == 0.8
    assert seen == ["alice"]


async def test_threshold_is_isolated_by_owner(monkeypatch):
    alice, _, _ = await _extract(
        monkeypatch,
        confidence=0.8,
        owner="alice",
        prefs={"auto_approve_skills": True, "skill_min_confidence": 0.9},
    )
    bob, _, seen = await _extract(
        monkeypatch,
        confidence=0.8,
        owner="bob",
        prefs={"auto_approve_skills": True, "skill_min_confidence": 0.7},
    )
    assert alice["status"] == "draft"
    assert bob["status"] == "published"
    assert seen == ["bob"]


async def test_global_threshold_and_explicit_zero_threshold(monkeypatch):
    result, _, _ = await _extract(
        monkeypatch,
        confidence=0.8,
        prefs={"auto_approve_skills": True},
        global_min=0.9,
    )
    assert result["status"] == "draft"

    result, _, _ = await _extract(
        monkeypatch,
        confidence=0.6,
        prefs={"auto_approve_skills": True, "skill_min_confidence": 0},
    )
    assert result["status"] == "published"


async def test_auto_approve_off_stays_draft(monkeypatch):
    result, _, _ = await _extract(
        monkeypatch,
        confidence=0.99,
        prefs={"auto_approve_skills": False, "skill_min_confidence": 0},
    )
    assert result["status"] == "draft"


async def test_preferences_load_failure_fails_closed_to_draft(monkeypatch):
    async def fake_llm_call_async(*args, **kwargs):
        return _response(0.99)

    def fail_to_load_preferences(_owner):
        raise OSError("preferences unavailable")

    monkeypatch.setattr("src.llm_core.llm_call_async", fake_llm_call_async)
    monkeypatch.setattr("routes.prefs_routes._load_for_user", fail_to_load_preferences)
    monkeypatch.setattr("src.settings.get_setting", lambda name, default=None: 0)
    manager = _SkillsManager()
    result = await skill_extractor.maybe_extract_skill(
        _Session(), manager, "http://endpoint", "test-model", {}, 3, 3, owner="alice",
    )

    assert result["status"] == "draft"


@pytest.mark.parametrize("confidence", [float("nan"), float("inf"), float("-inf"), -0.01, 1.01, "bad", True, None])
async def test_invalid_confidence_is_rejected(monkeypatch, confidence):
    result, manager, _ = await _extract(
        monkeypatch,
        confidence=confidence,
        prefs={"auto_approve_skills": True, "skill_min_confidence": 0},
    )
    assert result is None
    assert manager.added == []


@pytest.mark.parametrize("threshold", ["bad", float("nan"), float("inf"), -0.01, 1.01])
async def test_invalid_user_threshold_fails_closed_to_draft(monkeypatch, threshold):
    result, _, _ = await _extract(
        monkeypatch,
        confidence=0.99,
        prefs={"auto_approve_skills": True, "skill_min_confidence": threshold},
    )
    assert result["status"] == "draft"
