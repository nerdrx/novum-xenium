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
