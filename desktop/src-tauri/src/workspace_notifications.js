// Adapt existing browser notification calls to the desktop's narrow native route.
// This script exposes no Tauri IPC or container/file operations to the workbench.
(() => {
  if (window !== window.top) return;
  const key = 'nx.desktopNotifications';
  const enabled = () => { try { return localStorage.getItem(key) === 'true'; } catch { return false; } };
  class DesktopNotification extends EventTarget {
    static get permission() { return enabled() ? 'granted' : 'denied'; }
    static requestPermission(callback) {
      const permission = this.permission;
      callback?.(permission);
      return Promise.resolve(permission);
    }
    constructor(title, options = {}) {
      super();
      this.title = String(title).slice(0, 120);
      this.body = String(options.body || '').slice(0, 500);
      if (!enabled() || !this.title.trim()) return;
      const url = new URL('nx-workbench://notify');
      url.searchParams.set('title', this.title);
      url.searchParams.set('body', this.body);
      const link = document.createElement('a');
      link.href = url.href;
      link.hidden = true;
      document.documentElement.append(link);
      link.click();
      link.remove();
    }
    // The OS owns notification lifetime; existing chat timers may call close().
    close() {}
  }
  window.Notification = DesktopNotification;
  function mount() {
    const panel = document.querySelector('[data-settings-panel="reminders"]');
    if (!panel || document.getElementById('nx-desktop-notifications')) return;
    const card = document.createElement('section');
    card.className = 'admin-card';
    card.id = 'nx-desktop-notifications';
    card.innerHTML = `<h2>Desktop notifications</h2>
      <div class="settings-row"><label for="nx-notifications-enabled" class="settings-label">Show desktop notifications</label>
      <label class="admin-switch"><input id="nx-notifications-enabled" type="checkbox"><span class="admin-slider"></span></label></div>
      <p class="admin-toggle-sub">Notify for finished background replies, tasks and reminders while this app is running. Saved on this device. Your system's notification settings still apply.</p>
      <div class="settings-row"><button type="button" class="admin-btn-sm" id="nx-notifications-test">Send test notification</button><span id="nx-notifications-status" role="status" class="admin-toggle-sub"></span></div>`;
    panel.prepend(card);
    const toggle = card.querySelector('input');
    const test = card.querySelector('button');
    const status = card.querySelector('[role="status"]');
    toggle.checked = enabled();
    test.disabled = !toggle.checked;
    toggle.addEventListener('change', () => {
      try {
        localStorage.setItem(key, String(toggle.checked));
        test.disabled = !toggle.checked;
        status.textContent = toggle.checked ? 'Enabled on this device.' : 'Desktop notifications off.';
      } catch {
        toggle.checked = enabled();
        test.disabled = !toggle.checked;
        status.textContent = 'Could not save this preference.';
      }
    });
    test.addEventListener('click', () => {
      new DesktopNotification('Novum Xenium', { body: 'Desktop notifications are enabled.' });
      status.textContent = 'Test sent. Check your system notifications.';
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
