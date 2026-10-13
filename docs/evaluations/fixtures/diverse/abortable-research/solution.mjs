export async function abortable(promise, signal) {
  // If signal is already aborted, reject immediately without adding a listener
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }

  // Track cleanup state
  let hasListener = false;
  let settled = false;

  // Abort handler - fires synchronously when signal aborts
  const abortHandler = () => {
    if (!settled && hasListener) {
      signal.removeEventListener('abort', abortHandler);
      hasListener = false;
      settled = true;
    }
    return Promise.reject(signal.reason);
  };

  // Add the abort listener
  signal.addEventListener('abort', abortHandler);
  hasListener = true;

  // Create a returned promise that will settle based on source promise or abort
  const returnedPromise = new Promise((resolve, reject) => {
    promise
      .then(result => {
        if (!settled && hasListener) {
          signal.removeEventListener('abort', abortHandler);
          hasListener = false;
          settled = true;
        }
        resolve(result);
      })
      .catch(error => {
        if (!settled && hasListener) {
          signal.removeEventListener('abort', abortHandler);
          hasListener = false;
          settled = true;
        }
        reject(error);
      });
  });

  return returnedPromise;
}
