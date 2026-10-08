// WebKit webviews do not provide browser reload shortcuts automatically.
document.addEventListener('keydown', event => {
  if (event.repeat || event.altKey) return;
  const reload = event.key === 'F5' ||
    ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r');
  if (!reload) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  window.location.reload();
}, true);

// WebKitGTK does not route mouse side buttons through its normal page history
// controls. Handle auxclick in capture phase so the native default cannot also
// navigate (or escape to a Tauri navigation action).
document.addEventListener('auxclick', event => {
  if (event.button !== 3 && event.button !== 4) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.button === 3 && window.history.length < 2) return;
  window.history.go(event.button === 3 ? -1 : 1);
}, true);
