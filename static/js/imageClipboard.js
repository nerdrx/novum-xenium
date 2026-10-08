/** Copy image pixels as PNG. Clipboard write starts before image fetch/encoding. */
export function copyImageToClipboard(source) {
  if (!navigator.clipboard?.write || typeof ClipboardItem !== 'function') {
    return Promise.reject(new Error('Image clipboard is unavailable'));
  }

  const png = (async () => {
    const response = await fetch(source, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    if (blob.type === 'image/png') return blob;

    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      return await new Promise((resolve, reject) => {
        canvas.toBlob(result => result ? resolve(result) : reject(new Error('PNG encoding failed')), 'image/png');
      });
    } finally {
      bitmap.close?.();
    }
  })();

  try {
    return navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  } catch (error) {
    return Promise.reject(error);
  }
}
