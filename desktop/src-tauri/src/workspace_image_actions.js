// Replace WebKit's image menu with explicit pixel, address and file actions.
(() => {
  if (window !== window.top) return;
  let menu, image, notice;
  const source = () => image?.currentSrc || image?.src || '';
  const copyPixels = url => {
    if (!navigator.clipboard?.write || typeof ClipboardItem !== 'function') {
      return Promise.reject(new Error('Image clipboard is unavailable'));
    }
    const png = (async () => {
      const response = await fetch(url, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      if (blob.type === 'image/png') return blob;
      const bitmap = await createImageBitmap(blob);
      try {
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        return await new Promise((resolve, reject) => canvas.toBlob(
          result => result ? resolve(result) : reject(new Error('PNG encoding failed')), 'image/png'));
      } finally { bitmap.close?.(); }
    })();
    try { return navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]); }
    catch (error) { return Promise.reject(error); }
  };
  const showNotice = text => {
    if (!notice) {
      notice = document.createElement('div');
      notice.setAttribute('role', 'status');
      notice.setAttribute('aria-live', 'polite');
      notice.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483647;padding:10px 14px;border:1px solid var(--border,#554466);border-radius:8px;background:var(--bg,#17151b);color:var(--fg,#eee);font:13px var(--font-family,sans-serif);box-shadow:0 4px 20px #0008';
      document.body.append(notice);
    }
    notice.hidden = false;
    notice.textContent = text;
    clearTimeout(notice.timer);
    notice.timer = setTimeout(() => { notice.hidden = true; }, 2500);
  };
  const close = () => { if (menu) menu.hidden = true; };
  const report = (promise, success, failure) => Promise.resolve(promise).then(
    () => showNotice(success), error => { console.warn(failure, error); showNotice(failure); });
  const mount = () => {
    if (menu) return;
    menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Image actions');
    menu.hidden = true;
    menu.style.cssText = 'position:fixed;z-index:2147483646;min-width:190px;padding:5px;border:1px solid var(--border,#554466);border-radius:8px;background:var(--bg,#17151b);color:var(--fg,#eee);font:13px var(--font-family,sans-serif);box-shadow:0 8px 28px #0009';
    menu.innerHTML = `<button role="menuitem" data-action="copy">Copy image</button><button role="menuitem" data-action="address">Copy image address</button><button role="menuitem" data-action="open">Open in browser</button><button role="menuitem" data-action="save">Save image</button>`;
    const style = document.createElement('style');
    style.textContent = '#nx-image-menu button{display:block;width:100%;padding:8px 12px;border:0;border-radius:5px;text-align:left;background:transparent;color:inherit;font:inherit;cursor:pointer}#nx-image-menu button:hover,#nx-image-menu button:focus-visible{background:var(--surface-2,#302a36);outline:2px solid var(--red,#9600ff);outline-offset:-2px}#nx-image-menu button:disabled{opacity:.5;cursor:default}';
    menu.id = 'nx-image-menu';
    menu.append(style);
    menu.querySelectorAll('[data-action]').forEach(button => {
      button.addEventListener('click', () => {
        const url = source();
        close();
        if (button.dataset.action === 'copy') {
          report(copyPixels(url), 'Image copied to clipboard', 'Could not copy image pixels');
        } else if (button.dataset.action === 'address') {
          let write;
          try {
            if (!navigator.clipboard?.writeText) throw new Error('Text clipboard is unavailable');
            write = navigator.clipboard.writeText(url);
          } catch (error) { write = Promise.reject(error); }
          report(write, 'Image address copied', 'Could not copy image address');
        } else if (button.dataset.action === 'open') {
          window.open(url, '_blank', 'noopener,noreferrer');
        } else {
          (async () => {
            try {
              const response = await fetch(url, { credentials: 'same-origin' });
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              const blobUrl = URL.createObjectURL(await response.blob());
              const link = document.createElement('a');
              link.href = blobUrl;
              link.download = 'image.png';
              document.body.append(link);
              link.click();
              link.remove();
              setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
            } catch (error) {
              console.warn('Save image failed', error);
              showNotice('Could not save image');
            }
          })();
        }
      });
    });
    menu.addEventListener('keydown', event => {
      const items = Array.from(menu.querySelectorAll('[role="menuitem"]:not(:disabled)'));
      const index = items.indexOf(document.activeElement);
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        items[(index + step + items.length) % items.length]?.focus();
      } else if (event.key === 'Home') { event.preventDefault(); items[0]?.focus(); }
      else if (event.key === 'End') { event.preventDefault(); items[items.length - 1]?.focus(); }
    });
    document.body.append(menu);
    document.addEventListener('pointerdown', event => { if (!menu.contains(event.target)) close(); }, true);
    document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); }, true);
  };

  document.addEventListener('contextmenu', event => {
    const target = event.target instanceof Element ? event.target.closest('img') : null;
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    image = target;
    mount();
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
    menu.querySelector('[data-action="open"]').disabled = !/^https?:/i.test(source());
    menu.hidden = false;
    menu.style.left = '0px';
    menu.style.top = '0px';
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(event.clientX, innerWidth - bounds.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(event.clientY, innerHeight - bounds.height - 4))}px`;
    items[0].focus();
  }, true);
})();
