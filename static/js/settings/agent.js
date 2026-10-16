// Agent settings and checked workflow preferences.
import { byId as el } from './dom.js';
import { postSettings as _postSettings } from './api.js';

export async function initAgentSettings() {
  var toolsInput = el('set-agentMaxTools');
  var roundsInput = el('set-agentMaxRounds');
  var supInput = el('set-agentSupervisorLadder');
  var groundingInput = el('set-agentCodingGrounding');
  var verifierInput = el('set-agentVerifierSubagent');
  var milestoneInput = el('set-agentMilestoneWorkflow');
  var msg = el('set-agentMsg');
  if (!toolsInput) return;

  function parseRounds(raw, fallback) {
    var text = String(raw == null ? '' : raw).trim();
    if (!/^\d+$/.test(text)) return fallback;
    var value = Number(text);
    return Number.isFinite(value) ? Math.min(value, 200) : 200;
  }

  try {
    var res = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    var settings = await res.json();
    if (settings.agent_max_tool_calls) toolsInput.value = settings.agent_max_tool_calls;
    if (roundsInput && settings.agent_max_rounds != null) {
      roundsInput.value = parseRounds(settings.agent_max_rounds, 20);
    }
    if (supInput) supInput.checked = !!settings.agent_supervisor_ladder;
    if (groundingInput) groundingInput.checked = settings.agent_coding_grounding !== false;
    if (verifierInput) verifierInput.checked = !!settings.agent_verifier_subagent;
    if (milestoneInput) milestoneInput.checked = settings.agent_milestone_workflow !== false;
  } catch (e) {}

  // Clamp + coerce a raw input to an int in [lo, hi]; falls back to `dflt`
  // when blank/non-numeric. Mirrors the server-side validation.
  function clampInt(raw, lo, hi, dflt) {
    var n = parseInt(raw, 10);
    if (isNaN(n)) return dflt;
    return Math.max(lo, Math.min(n, hi));
  }

  async function save() {
    var tools = clampInt(toolsInput.value, 0, 1000, 0);
    var rounds = roundsInput ? parseRounds(roundsInput.value, 20) : null;
    toolsInput.value = tools;                       // reflect the clamped value
    if (roundsInput) roundsInput.value = rounds;
    var payload = { agent_max_tool_calls: tools };
    if (rounds != null) payload.agent_max_rounds = rounds;
    if (supInput) payload.agent_supervisor_ladder = !!supInput.checked;
    if (groundingInput) payload.agent_coding_grounding = !!groundingInput.checked;
    if (verifierInput) payload.agent_verifier_subagent = !!verifierInput.checked;
    if (milestoneInput) payload.agent_milestone_workflow = !!milestoneInput.checked;
    try {
      await _postSettings(payload);
      msg.textContent = (tools > 0 ? 'Limit: ' + tools + ' tool calls' : 'Unlimited tool calls') +
        (rounds != null ? (rounds === 0 ? ' · Unlimited steps/message' : ' · ' + rounds + ' steps/message') : '') +
        (supInput && supInput.checked ? ' · supervisor on' : '') +
        (groundingInput ? ' · docs ' + (groundingInput.checked ? 'on' : 'off') : '') +
        (verifierInput ? ' · review ' + (verifierInput.checked ? 'on' : 'off') : '');
      msg.style.color = 'var(--fg)';
    } catch (e) { msg.textContent = e.status === 403 ? 'Admin access is required to change these settings.' : 'Failed to save'; msg.style.color = 'var(--red)'; }
  }

  toolsInput.addEventListener('change', save);
  if (roundsInput) roundsInput.addEventListener('change', save);
  if (supInput) supInput.addEventListener('change', save);
  if (groundingInput) groundingInput.addEventListener('change', save);
  if (verifierInput) verifierInput.addEventListener('change', save);
  if (milestoneInput) milestoneInput.addEventListener('change', save);
  var cur = parseInt(toolsInput.value, 10) || 0;
  var curR = roundsInput ? parseRounds(roundsInput.value, 20) : null;
  msg.textContent = (cur > 0 ? 'Limit: ' + cur + ' tool calls' : 'Unlimited tool calls') +
    (curR != null ? (curR === 0 ? ' · Unlimited steps/message' : ' · ' + curR + ' steps/message') : '') +
    (supInput && supInput.checked ? ' · supervisor on' : '') +
    (groundingInput ? ' · docs ' + (groundingInput.checked ? 'on' : 'off') : '') +
    (verifierInput ? ' · review ' + (verifierInput.checked ? 'on' : 'off') : '');

}
