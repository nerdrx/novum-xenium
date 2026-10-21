// static/js/voiceRecorder.js

/**
 * Voice recording with optional Speech-to-Text transcription.
 *
 * STT providers:
 *   "disabled"       — record audio as file attachment (original behavior)
 *   "browser"        — use Web Speech API for real-time transcription
 *   "local"          — send recording to server /api/stt/transcribe (Whisper)
 *   "endpoint:<id>"  — send recording to server /api/stt/transcribe (API)
 */

let mediaRecorder = null;
let isRecording = false;
let recordingStartTime = null;
let recordingInterval = null;
let recordingIntent = 0;

// Cached STT provider — refreshed on settings change
let _sttProvider = 'disabled';
let _sttProviderRevision = 0;

/**
 * Fetch current STT provider from server settings
 */
async function refreshSttProvider() {
  const revision = ++_sttProviderRevision;
  try {
    const res = await fetch('/api/stt/stats', { credentials: 'same-origin' });
    if (res.ok) {
      const stats = await res.json();
      if (revision !== _sttProviderRevision) return;
      _sttProvider = stats.provider || 'disabled';
      // Notify the send button to update its icon
      if (window._updateSendBtnIcon) window._updateSendBtnIcon();
    }
  } catch (e) {
    console.warn('Failed to fetch STT stats:', e);
  }
}

/**
 * Format seconds as MM:SS
 */
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
  const secs = (seconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}

/**
 * Reset UI state after recording ends
 */
function _resetRecordingUI() {
  isRecording = false;
  if (recordingInterval) {
    clearInterval(recordingInterval);
    recordingInterval = null;
  }
  // Reset send button via global callback
  const sendBtn = document.querySelector('.send-btn');
  if (sendBtn) {
    sendBtn.classList.remove('recording');
    sendBtn.dataset.mode = '';
  }
  if (window._updateSendBtnIcon) {
    setTimeout(window._updateSendBtnIcon, 50);
  }
}

/**
 * Start browser speech recognition alongside recording
 */
function startBrowserSTT(speech) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return;

  speech.transcript = '';
  speech.recognition = new SpeechRecognition();
  speech.recognition.continuous = true;
  speech.recognition.interimResults = false;
  speech.recognition.lang = '';

  speech.recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        speech.transcript += event.results[i][0].transcript + ' ';
      }
    }
  };

  speech.recognition.onerror = (e) => {
    console.warn('Browser STT error:', e.error);
  };
  speech.ended = false;
  speech.recognition.onend = () => { speech.ended = true; };

  speech.recognition.start();
}

function stopBrowserSTT(speech) {
  if (speech?.recognition) {
    try { speech.recognition.stop(); } catch (e) { /* ignore */ }
    speech.recognition = null;
  }
  return (speech?.transcript || '').trim();
}

function _audioFormat(mimeType) {
  const mime = String(mimeType || '').split(';', 1)[0].trim().toLowerCase();
  const formats = {
    'audio/webm': { extension: 'webm', mimeType: 'audio/webm' },
    'audio/mp4': { extension: 'm4a', mimeType: 'audio/mp4' },
    'audio/ogg': { extension: 'ogg', mimeType: 'audio/ogg' },
    'audio/wav': { extension: 'wav', mimeType: 'audio/wav' },
    'audio/mpeg': { extension: 'mp3', mimeType: 'audio/mpeg' },
  };
  return formats[mime] || { extension: 'bin', mimeType: 'application/octet-stream' };
}

function stopBrowserSTTAndWait(speech) {
  const recognition = speech?.recognition;
  if (!recognition || speech.ended) {
    if (speech) speech.recognition = null;
    return Promise.resolve((speech?.transcript || '').trim());
  }

  return new Promise(resolve => {
    const previousOnEnd = recognition.onend;
    let timeout;
    let finished = false;
    const finish = (ended = false) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (!ended && !speech.ended) {
        try { recognition.abort(); } catch (e) { /* ignore */ }
      }
      if (recognition.onend === onEnd) recognition.onend = previousOnEnd;
      if (speech.recognition === recognition) speech.recognition = null;
      resolve((speech.transcript || '').trim());
    };
    const onEnd = event => {
      speech.ended = true;
      try { previousOnEnd?.call(recognition, event); } finally { finish(true); }
    };

    recognition.onend = onEnd;
    timeout = setTimeout(finish, 2000);
    try { recognition.stop(); } catch (e) { finish(); }
  });
}

/**
 * Send audio to server for transcription
 */
async function transcribeOnServer(audioBlob, format) {
  const formData = new FormData();
  formData.append('file', audioBlob, `audio.${format.extension}`);

  const res = await fetch('/api/stt/transcribe', {
    method: 'POST',
    credentials: 'same-origin',
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail?.message || 'Transcription failed');
  }

  const data = await res.json();
  return data.text || '';
}

/**
 * Insert transcribed text into the chat input
 */
function insertTranscription(text, showToast) {
  if (!text) return;
  const input = document.getElementById('message');
  if (!input) return;

  const existing = input.value.trim();
  input.value = existing ? existing + ' ' + text : text;

  // Trigger auto-resize and icon update
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();

  if (showToast) showToast('Transcribed');
}

/**
 * Start voice recording
 */
export function startRecording(onFileCreated, showToast, showError) {
  const intent = ++recordingIntent;
  const session = window.sessionModule;
  const voiceApiReady = session?.captureVoiceIdentity && session?.captureVoiceDestination && session?.deliverVoiceTranscription && session?.deliverVoiceAudioFallback;
  if (session && !voiceApiReady) {
    if (showToast) showToast('Reload the app before using voice input again.');
    _resetRecordingUI();
    return;
  }
  const recordingIdentity = voiceApiReady ? session.captureVoiceIdentity() : null;

  // Check for secure context (getUserMedia requires HTTPS or localhost)
  if (!window.isSecureContext) {
    if (showError) showError('Microphone requires HTTPS. Use a reverse proxy with SSL or access via localhost.');
    _resetRecordingUI();
    return;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    if (showError) showError('Microphone not supported in this browser.');
    _resetRecordingUI();
    return;
  }

  navigator.mediaDevices.getUserMedia({ audio: true })
    .then(stream => {
      if (intent !== recordingIntent) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }

      let recorder;
      try {
        try {
          recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
        } catch (error) {
          if (error?.name !== 'NotSupportedError') throw error;
          recorder = new MediaRecorder(stream);
        }
      } catch (error) {
        stream.getTracks().forEach(track => track.stop());
        if (mediaRecorder?.state !== 'recording') mediaRecorder = null;
        throw error;
      }
      recorder._odysseusRecordingIdentity = recordingIdentity;
      mediaRecorder = recorder;
      const audioChunks = [];
      const browserSpeech = { recognition: null, transcript: '' };

      recorder.ondataavailable = event => {
        if (event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };

      recorder.onstop = async () => {
        const stopIntent = recorder._odysseusStopIntent ?? intent;
        const currentSessionModule = window.sessionModule;
        const hasVoiceDestinationHandler = !!(currentSessionModule?.captureVoiceDestination && currentSessionModule?.deliverVoiceTranscription && currentSessionModule?.deliverVoiceAudioFallback);
        let recoveryOnly = false;
        if (!recorder._odysseusVoiceDestinationCaptured && hasVoiceDestinationHandler) {
          const stoppedDestination = currentSessionModule.captureVoiceDestination(recorder._odysseusRecordingIdentity);
          const destinationId = destination => destination?.sessionId || destination?.pendingChat?.materializedSessionId || destination?.pendingDraftId || '';
          recoveryOnly = destinationId(recorder._odysseusStartVoiceDestination) !== destinationId(stoppedDestination);
          recorder._odysseusVoiceDestination = recoveryOnly ? recorder._odysseusStartVoiceDestination : stoppedDestination;
          recorder._odysseusVoiceDestinationCaptured = true;
        }
        const voiceDestination = recorder._odysseusVoiceDestination;
        stream.getTracks().forEach(track => track.stop());

        if (currentSessionModule && !hasVoiceDestinationHandler) {
          stopBrowserSTT(browserSpeech);
          if (showToast) showToast('Reload the app before using voice input again.');
          if (mediaRecorder === recorder && recordingIntent === stopIntent) _resetRecordingUI();
          return;
        }

        const format = _audioFormat(recorder.mimeType || audioChunks.find(chunk => chunk.type)?.type || 'audio/webm');
        const audioBlob = new Blob(audioChunks, { type: format.mimeType });
        const provider = recorder._odysseusProvider;

        if (provider === 'browser') {
          const transcriptPromise = stopBrowserSTTAndWait(browserSpeech);
          const transcript = await transcriptPromise;
          if (transcript) {
            if (hasVoiceDestinationHandler) {
              await window.sessionModule.deliverVoiceTranscription(voiceDestination, transcript, () => insertTranscription(transcript, showToast), recoveryOnly);
            } else insertTranscription(transcript, showToast);
          } else {
            if (showToast) showToast('No speech detected');
            const audioFile = new File([audioBlob], `voice-message-${Date.now()}.${format.extension}`, { type: format.mimeType });
            if (hasVoiceDestinationHandler) await window.sessionModule.deliverVoiceAudioFallback(voiceDestination, audioFile, onFileCreated, recoveryOnly);
            else if (onFileCreated) onFileCreated(audioFile);
          }
        } else if (provider === 'local' || provider.startsWith('endpoint:')) {
          // Show "Transcribing..." feedback
          if (showToast) showToast('Transcribing...', 5000);
          try {
            const transcript = await transcribeOnServer(audioBlob, format);
            if (transcript) {
              if (hasVoiceDestinationHandler) {
                await window.sessionModule.deliverVoiceTranscription(voiceDestination, transcript, () => insertTranscription(transcript, showToast), recoveryOnly);
              } else insertTranscription(transcript, showToast);
            } else {
              if (showToast) showToast('No speech detected');
            }
          } catch (e) {
            console.error('STT transcription error:', e);
            if (showError) showError('Transcription failed: ' + e.message);
            // Fallback: attach as file
            const audioFile = new File([audioBlob], `voice-message-${Date.now()}.${format.extension}`, { type: format.mimeType });
            if (hasVoiceDestinationHandler) await window.sessionModule.deliverVoiceAudioFallback(voiceDestination, audioFile, onFileCreated, recoveryOnly);
            else if (onFileCreated) onFileCreated(audioFile);
          }
        } else {
          // STT disabled — attach audio file
          const audioFile = new File([audioBlob], `voice-message-${Date.now()}.${format.extension}`, { type: format.mimeType });
          if (hasVoiceDestinationHandler) await window.sessionModule.deliverVoiceAudioFallback(voiceDestination, audioFile, onFileCreated, recoveryOnly);
          else if (onFileCreated) onFileCreated(audioFile);
        }

        if (mediaRecorder === recorder && recordingIntent === stopIntent) {
          _resetRecordingUI();
        }
      };

      recorder._odysseusStartVoiceDestination = voiceApiReady
        ? session.captureVoiceDestination(recordingIdentity)
        : null;
      // Bind this recorder to the provider accepted after microphone permission.
      recorder._odysseusProvider = _sttProvider;
      try {
        recorder.start();
      } catch (error) {
        stream.getTracks().forEach(track => track.stop());
        if (mediaRecorder === recorder) mediaRecorder = null;
        throw error;
      }
      isRecording = true;
      recordingStartTime = new Date();

      // Start browser STT if that's the provider
      let browserSttFailed = false;
      if (recorder._odysseusProvider === 'browser') {
        try {
          startBrowserSTT(browserSpeech);
        } catch (_) {
          stopBrowserSTT(browserSpeech);
          browserSttFailed = true;
        }
      }

      if (showToast) {
        showToast(browserSttFailed ? 'Browser transcription unavailable; recording continues' : 'Recording...');
      }
    })
    .catch(error => {
      if (intent !== recordingIntent) return;

      console.error('Microphone access error:', error);
      if (showError) {
        if (error.name === 'NotAllowedError') {
          showError('Microphone access denied. Check browser permissions.');
        } else if (error.name === 'NotFoundError') {
          showError('No microphone found.');
        } else {
          showError('Microphone error: ' + error.message);
        }
      }
      _resetRecordingUI();
    });
}

/**
 * Stop voice recording
 */
export function stopRecording() {
  recordingIntent++;
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    // Native onstop may arrive after a newer recording attempt starts.
    mediaRecorder._odysseusStopIntent = recordingIntent;
    const session = window.sessionModule;
    const voiceApiReady = session?.captureVoiceDestination && session?.deliverVoiceTranscription && session?.deliverVoiceAudioFallback;
    if (voiceApiReady) {
      mediaRecorder._odysseusVoiceDestinationCaptured = true;
      mediaRecorder._odysseusVoiceDestination = session.captureVoiceDestination(mediaRecorder._odysseusRecordingIdentity);
    }
    mediaRecorder.stop();
    // isRecording will be set to false in _resetRecordingUI called from onstop
  } else {
    _resetRecordingUI();
  }
}

/**
 * Check if currently recording
 */
export function getIsRecording() {
  return isRecording;
}

/**
 * Initialize recording state
 */
export function init() {
  isRecording = false;
  refreshSttProvider();
}

const voiceRecorderModule = {
  startRecording,
  stopRecording,
  getIsRecording,
  init,
  refreshSttProvider,
  get _sttProvider() { return _sttProvider; },
  set _sttProvider(v) { _sttProviderRevision++; _sttProvider = v; },
};

export default voiceRecorderModule;
