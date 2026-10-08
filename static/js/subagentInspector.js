export function clearSubagentInspector() {
  document.body.classList.remove('subagent-inspector-active');
  document.getElementById('subagent-inspector-banner')?.remove();
  const input = document.getElementById('message');
  if (input) input.disabled = false;
}

export function applySubagentInspector(chatHistory, parentSessionId) {
  if (!chatHistory) return null;
  const parentId = typeof parentSessionId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(parentSessionId)
    ? parentSessionId : '';
  document.body.classList.add('subagent-inspector-active');
  const input = document.getElementById('message');
  if (input) input.disabled = true;
  const banner = document.createElement('aside');
  banner.id = 'subagent-inspector-banner';
  banner.className = 'subagent-inspector-banner';
  banner.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.textContent = 'Subagent chat. Review its work and approval requests here; send follow-up tasks from the parent chat.';
  banner.appendChild(text);
  if (parentId) {
    const link = document.createElement('a');
    link.href = `#session-${parentId}`;
    link.textContent = 'Return to parent chat';
    banner.appendChild(link);
  }
  chatHistory.prepend(banner);
  return banner;
}
