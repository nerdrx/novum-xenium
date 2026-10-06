const MODES = [
  { key: 'ask', label: 'Ask for approval', detail: 'Ask before agent writes, shell commands, and internet calls.' },
  { key: 'auto', label: 'Approve for me', detail: 'Existing automatic checks; ask when untrusted context makes actions risky.' },
  { key: 'full', label: 'Full access', detail: 'Skip approval prompts within current workspace/container.' },
];

const SCOPE = 'Existing folder access, disabled tools, account rules, and plan mode still apply. Applies next agent turn, all chats/group participants for this account; current run not altered.';

export function init() {
  const right = document.querySelector('.chat-input-right');
  const modeToggle = right?.querySelector('.mode-toggle');
  if (!right || !modeToggle || document.getElementById('approval-mode-anchor')) return;

  const anchor = document.createElement('div');
  anchor.id = 'approval-mode-anchor';
  anchor.className = 'approval-mode-anchor';
  anchor.innerHTML = `
    <button type="button" class="approval-mode-trigger" aria-label="Tool approval mode" aria-expanded="false" aria-controls="approval-mode-panel" disabled>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11z"/><path d="m9 12 2 2 4-4"/></svg><span data-approval-label>Approval</span>
    </button>
    <div class="approval-mode-panel" id="approval-mode-panel" role="region" aria-label="Tool approval mode" hidden>
      <div class="approval-mode-options" role="radiogroup" aria-label="Approval mode"></div>
      <div class="approval-mode-scope"></div>
      <div class="approval-mode-error" role="status" aria-live="polite" hidden></div>
    </div>`;
  right.insertBefore(anchor, modeToggle);

  const trigger = anchor.querySelector('.approval-mode-trigger');
  const panel = anchor.querySelector('.approval-mode-panel');
  const options = anchor.querySelector('.approval-mode-options');
  const label = anchor.querySelector('[data-approval-label]');
  const error = anchor.querySelector('.approval-mode-error');
  anchor.querySelector('.approval-mode-scope').textContent = SCOPE;
  let selected = null;
  let busy = true;

  const setError = (message = '') => {
    error.textContent = message;
    error.hidden = !message;
  };
  const render = () => {
    options.replaceChildren();
    MODES.forEach(({ key, label: title, detail }) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'approval-mode-option';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(selected === key));
      button.disabled = busy;
      button.innerHTML = `<span class="approval-mode-option-title"></span><span class="approval-mode-option-detail"></span>`;
      button.querySelector('.approval-mode-option-title').textContent = title;
      button.querySelector('.approval-mode-option-detail').textContent = detail;
      button.addEventListener('click', () => save(key));
      button.addEventListener('keydown', (event) => {
        if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(event.key)) return;
        event.preventDefault();
        const delta = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
        options.children[(Array.from(options.children).indexOf(button) + delta + MODES.length) % MODES.length].focus();
      });
      options.append(button);
    });
    label.textContent = MODES.find(mode => mode.key === selected)?.label || 'Approval';
    trigger.disabled = busy;
  };
  const close = (returnFocus = false) => {
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (returnFocus) trigger.focus();
  };
  const save = async (key) => {
    if (busy || key === selected) return;
    busy = true;
    setError();
    render();
    try {
      const response = await fetch('/api/prefs/tool_approval_mode', {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: key }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.value !== key) throw new Error(data.error || 'Could not save approval mode.');
      selected = key;
      close();
    } catch (err) {
      setError(err.message || 'Could not save approval mode.');
    } finally {
      busy = false;
      render();
      if (panel.hidden) trigger.focus();
    }
  };

  trigger.addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
    if (open) options.querySelector('[aria-checked="true"]')?.focus();
  });
  document.addEventListener('pointerdown', event => {
    if (!anchor.contains(event.target)) close();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.hidden) {
      event.preventDefault();
      close(true);
    }
  });

  render();
  fetch('/api/prefs/tool_approval_mode', { credentials: 'same-origin' })
    .then(async response => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not load approval mode.');
      const value = data.value === null ? 'auto' : data.value;
      if (!MODES.some(mode => mode.key === value)) throw new Error('Server returned an unknown approval mode.');
      selected = value;
    })
    .catch(err => {
      setError(err.message || 'Could not load approval mode.');
      panel.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
    })
    .finally(() => { busy = false; render(); });
}

export default { init };
