let getItems = () => [];

export function setModelDisplayItemsProvider(provider) {
  getItems = typeof provider === 'function' ? provider : () => [];
}

export function resolveModelDisplayName(modelId, items = getItems(), normalize = value => value) {
  const raw = String(modelId || '').trim();
  if (!raw) return '';
  const normalized = String(normalize(raw, raw) || raw).trim().toLowerCase();
  let match = null;
  let ambiguous = false;
  for (const item of Array.isArray(items) ? items : []) {
    for (const [ids, labels] of [
      [item.models, item.models_display],
      [item.models_extra, item.models_extra_display],
    ]) {
      (Array.isArray(ids) ? ids : []).forEach((id, index) => {
        if (id !== raw && String(normalize(id, id) || id).trim().toLowerCase() !== normalized) return;
        const label = String((Array.isArray(labels) && labels[index]) || id || '').trim();
        if (match && match !== label) ambiguous = true;
        else match = label;
      });
    }
  }
  return match && !ambiguous ? match : raw;
}
