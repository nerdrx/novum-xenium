// Window controls only. The remote workbench receives no Tauri IPC permissions.
(() => {
  if (window !== window.top || /Mac/.test(navigator.platform)) return;
  const send = action => {
    const link = document.createElement('a');
    link.href = `nx-workbench://${action}`;
    link.hidden = true;
    document.documentElement.append(link);
    link.click();
    link.remove();
  };
  const mount = () => {
    if (document.getElementById('nx-window-bar')) return;
    const style = document.createElement('style');
    style.textContent = `
      #nx-window-bar { display:none; position:fixed; inset:0 0 auto; height:36px; z-index:2147483647;
        align-items:center; background:var(--bg,#101014); color:var(--fg,#eee);
        border-bottom:1px solid var(--border,#38313f); font:12px var(--font-family,sans-serif); user-select:none; }
      html[data-nx-window-frame=custom] #nx-window-bar { display:flex; }
      html[data-nx-window-frame=custom] body { position:relative!important; top:36px!important;
        height:calc(100dvh - 36px)!important; transform:translateZ(0); }
      html.ui-scale-125[data-nx-window-frame=custom] body { top:36px!important;
        height:calc(100dvh / 1.25 - 36px)!important; }
      #nx-window-drag { display:flex; align-items:center; flex:1; height:100%; padding:0 12px; gap:8px; outline-offset:-3px; }
      #nx-window-drag img { width:25px; height:20px; object-fit:contain; pointer-events:none; }
      #nx-window-drag span { opacity:.7; }
      #nx-window-bar button { width:44px; height:35px; display:grid; place-items:center; padding:0;
        border:0; border-radius:0; background:transparent; color:inherit; cursor:default; }
      #nx-window-bar button:hover { background:var(--surface-2,#29242e); }
      #nx-window-bar button:focus-visible { outline:2px solid var(--red,#9600ff); outline-offset:-3px; }
      #nx-window-bar button[data-action=close]:hover { background:#bd2635; color:#fff; }
      #nx-window-bar svg { width:13px; height:13px; fill:none; stroke:currentColor; stroke-width:1.2; }
      #nx-window-bar .nx-restore { display:none; }
      html[data-nx-maximized=true] #nx-window-bar .nx-restore { display:block; }
      html[data-nx-maximized=true] #nx-window-bar .nx-maximize { display:none; }
    `;
    document.head.append(style);
    const bar = document.createElement('header');
    bar.id = 'nx-window-bar';
    bar.setAttribute('aria-label', 'Window controls');
    bar.innerHTML = `<div id="nx-window-drag" tabindex="0" title="Drag to move. Double-click to maximize. Right-click for the native frame.">
      <img src="/static/icons/novum-xenium.png" alt=""><span>Novum Xenium</span></div>
      <button type="button" data-action="minimize" aria-label="Minimize window" title="Minimize"><svg viewBox="0 0 16 16"><path d="M2 11h12"/></svg></button>
      <button type="button" data-action="toggle-maximize" aria-label="Maximize window" title="Maximize"><svg class="nx-maximize" viewBox="0 0 16 16"><path d="M2.5 2.5h11v11h-11z"/></svg><svg class="nx-restore" viewBox="0 0 16 16"><path d="M5 2.5h8.5V11M2.5 5H11v8.5H2.5z"/></svg></button>
      <button type="button" data-action="close" aria-label="Close window" title="Close"><svg viewBox="0 0 16 16"><path d="m3 3 10 10M13 3 3 13"/></svg></button>`;
    document.documentElement.append(bar);
    bar.querySelectorAll('button').forEach(button => button.addEventListener('click', () => send(button.dataset.action)));
    const drag = bar.querySelector('#nx-window-drag');
    drag.addEventListener('mousedown', event => {
      if (event.button === 0 && event.detail < 2) send('drag');
    });
    drag.addEventListener('dblclick', () => send('toggle-maximize'));
    drag.addEventListener('contextmenu', event => { event.preventDefault(); send('native-frame'); });
    drag.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); send('toggle-maximize'); }
    });
    const update = () => {
      const maximized = document.documentElement.dataset.nxMaximized === 'true';
      const button = bar.querySelector('[data-action="toggle-maximize"]');
      button.setAttribute('aria-label', maximized ? 'Restore window' : 'Maximize window');
      button.title = maximized ? 'Restore' : 'Maximize';
    };
    new MutationObserver(update).observe(document.documentElement, { attributes:true, attributeFilter:['data-nx-maximized'] });
    // Native decorations remain until Rust confirms this bar mounted successfully.
    send('ready');
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once:true });
  else mount();
})();
