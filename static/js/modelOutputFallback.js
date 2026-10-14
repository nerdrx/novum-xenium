/**
 * Use a provider's reasoning payload as visible fallback only when an Agent
 * completed tool work but never sent assistant text in its final round.
 * Keep the warning neutral: the provider did not give us a reliable boundary
 * between private reasoning and its intended response.
 */
export function modelOutputFallback(text, metadata, candidate = metadata?.thinking) {
  const available = String(candidate || '').trim();
  const rounds = metadata?.round_texts;
  const toolEvents = metadata?.tool_events;
  if (!available || !Array.isArray(rounds) || rounds.length < 2
      || !Array.isArray(toolEvents) || toolEvents.length === 0
      || String(rounds[rounds.length - 1] || '').trim()) return null;

  const visible = String(text || '').trim().replace(/\s+/g, ' ');
  const recorded = rounds.map(value => String(value || '').trim()).filter(Boolean)
    .join(' ').replace(/\s+/g, ' ');
  if (visible && visible !== recorded) return null;
  return available;
}
