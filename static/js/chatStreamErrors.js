/** Build a terminal stream error while preserving provider-supplied text. */
export function createTerminalStreamError(payload = {}) {
  const rawError = payload.error;
  const message = (
    payload.text
    || (typeof rawError === 'string' ? rawError : rawError?.message)
    || `Error ${payload.status || 'unknown'}`
  );
  const hint = typeof payload.hint === 'string' ? payload.hint : '';
  const error = new Error(hint && hint !== message ? `${message}\n${hint}` : message);
  error.name = 'TerminalStreamError';
  error.terminalStreamError = true;
  error.status = payload.status;
  return error;
}

/** Only explicit client-side provider rejections should change Agent mode. */
export function isUnsupportedToolCapabilityError(status, message = '') {
  if (status !== 400 && status !== 422) return false;
  const text = String(message).toLowerCase();
  return /(?:model|endpoint|provider|server).{0,60}(?:does not support|doesn.t support|unsupported).{0,30}(?:tools?|function calling|tool calling)|(?:tools?|function calling|tool calling).{0,40}(?:not supported|unsupported)/i.test(text);
}

/** Only connection-class stream failures are safe to resubmit automatically. */
export function isRecoverableStreamError(error) {
  if (!error || error.terminalStreamError || error.name === 'TerminalStreamError') return false;
  if (error.name === 'TypeError') return true;
  const message = (error.message || '').toLowerCase();
  if (/\btool\b|unsupported|json|parse|\b4\d\d\b|\b5\d\d\b/.test(message)) return false;
  return /network|fetch|connection|reset|closed|aborted|stream|tim(?:e|ed)\s?out|econn|eof/.test(message);
}
