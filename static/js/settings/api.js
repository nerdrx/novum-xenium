// Lifted verbatim from static/js/settings.js so extracted panels can post
// settings without importing the module they were extracted from.
import uiModule from '../ui.js?v=20260916largetoolscroll1';
import { invalidateSettings } from '../appConfig.js';

export async function postSettings(body) {
  let timeout;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), 15000);
    const response = await fetch('/api/auth/settings', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = new Error(response.status === 403
        ? 'Admin access is required to change these settings.'
        : 'Failed to save');
      error.status = response.status;
      if (response.status === 403) uiModule.showError(error.message);
      throw error;
    }
    return response;
  } finally {
    clearTimeout(timeout);
    invalidateSettings();
  }
}
