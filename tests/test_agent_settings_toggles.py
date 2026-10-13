from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def test_agent_research_and_completion_review_settings_are_persisted():
    html = (ROOT / "static/index.html").read_text(encoding="utf-8")
    script = (ROOT / "static/js/settings.js").read_text(encoding="utf-8")
    css = (ROOT / "static/style.css").read_text(encoding="utf-8")

    assert 'id="set-agentCodingGrounding" type="checkbox" checked' in html
    assert 'id="set-agentVerifierSubagent" type="checkbox">' in html
    assert "Research coding documentation" in html
    assert "Review task completion" in html
    assert "can still miss things" in html
    assert html.count('style="flex:1;min-width:0;"') >= 2
    assert html.count("margin-left:auto;") >= 2
    assert ".agent-coding-settings-switch input:focus-visible + .admin-slider" in css

    assert "settings.agent_coding_grounding !== false" in script
    assert "!!settings.agent_verifier_subagent" in script
    assert "payload.agent_coding_grounding = !!groundingInput.checked" in script
    assert "payload.agent_verifier_subagent = !!verifierInput.checked" in script
    assert "groundingInput.addEventListener('change', save)" in script
    assert "verifierInput.addEventListener('change', save)" in script


def test_agent_round_setting_displays_and_saves_zero_as_unlimited():
    html = (ROOT / "static/index.html").read_text(encoding="utf-8")
    script = (ROOT / "static/js/settings.js").read_text(encoding="utf-8")
    assert 'id="set-agentMaxRounds"' in html
    assert "0 = unlimited" in html
    assert "settings.agent_max_rounds != null" in script
    assert "if (!/^\\d+$/.test(text)) return fallback" in script
    assert "settings.agent_max_rounds, 20" in script
    assert "rounds === 0 ? ' · Unlimited steps/message'" in script
    assert "curR === 0 ? ' · Unlimited steps/message'" in script
