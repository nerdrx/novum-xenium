const initialized = new WeakSet();
const previewStarted = new WeakSet();
const videoPreviewStatus = new WeakMap();
let videoPreviewObserver = null;

function previewVideoWhenVisible(video, setStatus) {
  if (video.poster || previewStarted.has(video)) return;
  if (typeof IntersectionObserver === 'undefined') return;
  if (!videoPreviewObserver) {
    videoPreviewObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const target = entry.target;
        videoPreviewObserver.unobserve(target);
        previewStarted.add(target);
        target.preload = 'metadata';
        videoPreviewStatus.get(target)?.('Loading video preview…');
        target.load();
      }
    }, { rootMargin: '160px 0px' });
  }
  video.preload = 'none';
  videoPreviewStatus.set(video, setStatus);
  videoPreviewObserver.observe(video);
  setStatus('Preview loads when visible.');
}

export function safePublicMediaUrl(value) {
  try {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const url = new URL(raw, window.location.origin);
    const sameOrigin = url.origin === window.location.origin;
    return (url.protocol === 'https:' || (sameOrigin && url.protocol === 'http:'))
      && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

export function addMediaControls(figure, media, kind, rawUrl = media?.currentSrc || media?.src) {
  const url = safePublicMediaUrl(rawUrl);
  if (!figure || !media || !url || initialized.has(media)) return null;
  initialized.add(media);
  figure.classList.add('chat-media-frame');
  media.classList.add('chat-inline-media');
  media.setAttribute('referrerpolicy', 'no-referrer');
  const status = document.createElement('p');
  status.className = 'chat-media-status'; status.setAttribute('role', 'status');
  status.textContent = kind === 'video'
    ? (media.poster ? '' : 'Tap play to load video.')
    : 'Loading image…';
  if (!status.textContent) status.hidden = true;
  const actions = document.createElement('div'); actions.className = 'chat-media-actions';
  const fullscreen = document.createElement('button'); fullscreen.type = 'button';
  fullscreen.className = 'chat-media-fullscreen'; fullscreen.textContent = 'Full screen';
  fullscreen.setAttribute('aria-label', `Show ${kind} full screen`);
  const retry = document.createElement('button'); retry.type = 'button';
  retry.className = 'chat-media-retry'; retry.textContent = 'Retry'; retry.hidden = true;
  const original = document.createElement('a'); original.href = url; original.target = '_blank';
  original.rel = 'noopener noreferrer'; original.referrerPolicy = 'no-referrer';
  original.textContent = 'Open original';
  actions.append(fullscreen, retry, original); figure.append(status, actions);

  const setStatus = (message, canRetry = false) => {
    status.textContent = message; status.hidden = !message; retry.hidden = !canRetry;
  };
  media.addEventListener('load', () => setStatus(''));
  if (kind === 'video') {
    media.preload = 'none';
    media.addEventListener('loadedmetadata', () => setStatus(''), { once: true });
    previewVideoWhenVisible(media, setStatus);
  }
  for (const event of ['loadeddata', 'canplay', 'playing']) media.addEventListener(event, () => setStatus(''));
  for (const event of ['waiting', 'stalled']) media.addEventListener(event, () => setStatus('Video is taking a while to load.', true));
  media.addEventListener('error', () => {
    const unsupported = kind === 'video' && media.error?.code === 4;
    setStatus(unsupported
      ? 'This video format is not supported here. Try opening the original.'
      : `Couldn't load this ${kind} on this device or connection. Retry or open the original.`, true);
  });
  if (kind === 'image' && media.complete) {
    if (media.naturalWidth > 0) setStatus('');
    else setStatus(`Couldn't load this ${kind} on this device or connection. Retry or open the original.`, true);
  } else if (kind === 'video' && media.readyState >= 2) setStatus('');
  retry.addEventListener('click', async () => {
    setStatus('Retrying…');
    if (kind === 'video') {
      media.load();
      try { await media.play(); }
      catch { setStatus('Tap play on the video to try again.'); }
    }
    else { media.loading = 'eager'; media.src = url; }
  });
  fullscreen.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (typeof media.requestFullscreen === 'function') await media.requestFullscreen();
      else if (kind === 'video' && typeof media.webkitEnterFullscreen === 'function') media.webkitEnterFullscreen();
      else throw new Error('unavailable');
    } catch { setStatus('Full screen is unavailable here. Open the original instead.'); }
  });
  return { status, retry, fullscreen, original };
}

export function preserveMediaFrames(previousRoot, nextRoot) {
  if (!previousRoot || !nextRoot?.querySelectorAll) return;
  const frames = new Map();
  const getKey = frame => {
    const media = frame.querySelector?.('video.chat-inline-media, img.chat-inline-media');
    if (!media) return '';
    const url = safePublicMediaUrl(media.getAttribute('src') || media.src);
    return url ? `${media.tagName}:${url}` : '';
  };
  const oldFrames = [];
  if (previousRoot.matches?.('.chat-media-frame')) oldFrames.push(previousRoot);
  oldFrames.push(...(previousRoot.querySelectorAll?.('.chat-media-frame') || []));
  for (const frame of oldFrames) {
    const key = getKey(frame);
    if (!key) continue;
    if (!frames.has(key)) frames.set(key, []);
    frames.get(key).push(frame);
  }
  const nextFrames = [...nextRoot.querySelectorAll('.chat-media-frame')];
  for (const [key, oldList] of frames) {
    const targets = nextFrames.filter(frame => getKey(frame) === key);
    // A rich history reload may contain earlier copies of the same media URL.
    // Reattach the live node to the latest matching occurrence in this turn.
    for (let index = oldList.length - 1, targetIndex = targets.length - 1; index >= 0 && targetIndex >= 0; index--, targetIndex--) {
      targets[targetIndex].replaceWith(oldList[index]);
    }
  }
}

export function parkMediaFrames(previousRoot) {
  const frames = previousRoot?.querySelectorAll?.('.chat-media-frame') || [];
  if (!frames.length) return null;
  const parked = document.createElement('div');
  parked.className = 'chat-media-parking';
  parked.setAttribute('aria-hidden', 'true');
  parked.inert = true;
  parked.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;z-index:-1';
  frames.forEach(frame => parked.appendChild(frame));
  document.body.appendChild(parked);
  return parked;
}

export function setHtmlPreservingMedia(target, html) {
  const next = document.createElement('div');
  next.innerHTML = String(html || '');
  preserveMediaFrames(target, next);
  target.replaceChildren(...next.childNodes);
}

function enhanceMarkdownMedia(root) {
  const mediaElements = [];
  if (root.matches?.('img.chat-inline-media, video.chat-inline-media')) mediaElements.push(root);
  mediaElements.push(...(root.querySelectorAll?.('img.chat-inline-media, video.chat-inline-media') || []));
  for (const media of mediaElements) {
    if (initialized.has(media)) continue;
    const url = safePublicMediaUrl(media.currentSrc || media.src);
    if (!url) continue;
    const kind = media.tagName === 'VIDEO' ? 'video' : 'image';
    const figure = media.closest('figure.chat-media-frame') || document.createElement('figure');
    if (!figure.contains(media)) { media.before(figure); figure.append(media); }
    if (kind === 'video') { media.controls = true; media.playsInline = true; media.preload = 'none'; }
    else { media.loading = 'lazy'; media.decoding = 'async'; }
    addMediaControls(figure, media, kind, url);
  }
}

export function installChatMediaControls() {
  if (typeof document === 'undefined' || !document.body || document.body.dataset.chatMediaControls) return;
  document.body.dataset.chatMediaControls = 'true';
  enhanceMarkdownMedia(document.body);
  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) enhanceMarkdownMedia(node);
    }
  }).observe(document.body, { childList: true, subtree: true });
}
