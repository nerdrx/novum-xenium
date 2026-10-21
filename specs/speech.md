# Speech

Last updated: 2026-10-21

## Scope

This spec covers speech behavior in:

- app service initialization and route registration in `app.py`;
- `services/stt/stt_service.py`;
- `services/tts/tts_service.py`;
- `routes/stt_routes.py`;
- `routes/tts_routes.py`;
- `src/upload_limits.py`;
- settings defaults/cache in `src/settings.py`;
- settings routes in `routes/auth_routes.py`;
- model endpoint cleanup in `routes/model_routes.py`;
- settings/tool aliases in `src/tool_implementations.py`;
- frontend modules `static/js/voiceRecorder.js`, `static/js/tts-ai.js`, `static/app.js`, `static/js/chat.js`, `static/js/slashCommands.js`, `static/js/keyboard-shortcuts.js`, `static/js/settings.js`, `static/js/settings/speech.js`, and `static/index.html`;
- optional dependency declarations in `requirements-optional.txt`;
- runtime cache path `data/tts_cache/`;
- tests covering speech settings, recorder ownership/format fallback, speech service toggles, TTS speed/cache, STT temp cleanup, upload limits, settings scrubbing, and model endpoint cleanup.

## Current Call Sites Include

- chat mic/send button behavior;
- browser and server STT recording paths;
- chat message read-aloud buttons and streaming TTS queueing;
- `/tts` slash command playback;
- keyboard shortcut TTS activation;
- admin/settings API writes and `manage_settings` aliases;
- model endpoint deletion cleanup for `endpoint:<id>` speech providers.

## STT

`services.stt.STTService` owns speech-to-text provider behavior. `routes/stt_routes.py` owns `/api/stt/transcribe` and `/api/stt/stats`. `static/js/voiceRecorder.js` owns microphone capture, browser STT, server upload, and audio-attachment fallback.

Provider runtime:

- `disabled` returns unavailable and avoids provider calls;
- only a literal JSON boolean `true` enables `stt_enabled`; missing or non-boolean saved values
  resolve to disabled at runtime without rewriting the stored setting;
- empty or non-string saved provider values resolve to `disabled` in the service at runtime without rewriting the stored setting; unknown non-empty provider names remain unavailable;
- `browser` is client-side only through Web Speech API and does not call `/api/stt/transcribe`;
- `local` lazily imports `faster-whisper`, writes uploaded audio to a temporary file using its recognized extension, transcribes, and deletes the temp file in `finally`;
- `endpoint:<id>` resolves a `ModelEndpoint` and posts the audio filename and recognized MIME type to `/audio/transcriptions` with model and optional language.

Local models are cached per service instance with their configured model name. `/api/stt/stats`
reports whether the configured local model is already loaded without loading one. If the configured
name changes, stats report it as unloaded; the next loader call replaces the cache. A failed
replacement leaves no old model available to serve, and a later loader call can retry.

Route behavior:

- audio uploads are capped by the shared STT upload limit from `src.upload_limits`, including environment override validation;
- [`/api/stt/transcribe`](https://github.com/nerdrx/novum-xenium/blob/6fc1a623e0cb5e5c3d19b49cb901a0ca7ddc31f4/routes/stt_routes.py)
  checks the bounded upload and rejects empty audio before provider availability. Empty audio returns
  400 and oversized audio returns 413 even when speech is disabled; valid audio for a disabled or
  unavailable service returns 503;
- uploaded content type, extension, and magic bytes are not strongly validated today;
- endpoint providers report optimistic availability and fail at request time if offline/misconfigured.

Frontend behavior:

- browser recording needs secure context and microphone permissions;
- the recorder requests WebM, then retries the browser's default `MediaRecorder` format if WebM
  construction is unsupported. It derives upload and attachment extension/MIME from recorder or
  chunk metadata for recognized WebM, MP4, Ogg, WAV, and MPEG audio; unknown formats use generic
  binary metadata;
- server transcription success inserts text into the input;
- failed server transcription can attach the recorded audio file to chat instead; empty transcription shows a no-speech message.
- recording captures a starting destination; explicit Stop captures the currently selected chat. A
  start from the welcome screen creates a pending draft identity when needed. If a natural recorder
  stop is delivered after navigation changes chats, the app treats the destination as ambiguous and
  asks before copying the transcript or downloading the audio instead of placing it into either chat.
- Compare owns its composer action while active: its button sends to or stops Compare runs and does
  not start microphone capture. Entering Compare invalidates a pending recording attempt or stops an
  active recording before changing chats; a transcript completed afterward remains with the
  destination captured when recording stopped, not the Compare composer.
- browser recognition waits up to two seconds after the audio recorder finishes for its final result
  and end event, then makes a best-effort abort if needed. Empty browser results use audio fallback;
- the frontend captures its provider after microphone permission resolves and uses that value for
  the recorder's startup and stop path. Changing settings during a Browser recording does not
  abandon its recognizer. Server transcription still resolves the global backend settings at request time;
- a delayed transcript follows the Stop destination and appends to its latest draft. Account changes
  prevent delivery; deleted or unavailable destinations can offer explicit copy/discard recovery.
  If copying fails, the user can explicitly download `voice-transcript.txt` or discard it; the app
  does not download automatically, persist the transcript, or insert it into the current chat, and
  it rechecks account identity before download.
  Incognito and unverified page-owned drafts retain their memory-only scope. Offscreen audio fallback
  offers download/discard rather than attaching to another chat.

## TTS

`services.tts.TTSService` owns text-to-speech provider behavior, speed parsing, cache behavior, and local/provider-specific synthesis. `routes/tts_routes.py` owns `/api/tts/stats`, `/api/tts/synthesize`, and cache clearing. `static/js/tts-ai.js` owns frontend playback, client object-URL caching, browser TTS, queueing, and streaming button state.

Provider runtime:

- `disabled` returns unavailable and avoids provider calls;
- `browser` is client-side only through `speechSynthesis`;
- `local` currently means Kokoro and requires `torch`, `kokoro`, `soundfile`, and CUDA/import availability;
- `endpoint:<id>` resolves a `ModelEndpoint` and posts to `/audio/speech`.
- unknown or non-string `tts_provider` values are treated as unavailable rather
  than being parsed as endpoint strings.

Route behavior:

- `/api/tts/synthesize` supports binary `audio` responses and JSON `base64` responses;
- binary responses choose WAV or MP3 MIME by audio magic bytes;
- synthesis input is passed to the service as submitted and capped there;
- malformed or nonpositive `tts_speed` falls back to `1.0`;
- provider unavailable returns 503; failed synthesis/transcription generally returns route-level failure.

## Settings, Endpoints, And Cache

Speech providers are global settings under `data/settings.json`, with defaults in `src/settings.py`.
Settings reads are scrubbed for non-admin callers, writes are admin-only, and `manage_settings` can
change non-secret speech settings through aliases. In AI Defaults, Speech to Text defaults to off
(`stt_enabled: false`, provider `disabled`). Its controls stay inert until saved settings load
successfully; a failed or invalid read shows an error and does not write settings. Successful
changes show confirmation, and a denied or failed save does not apply the new provider to the
recorder.

`static/js/settings/speech.js` owns TTS/STT settings initialization and provider selectors; the Settings coordinator imports those initializers. The Speech to Text settings card is available under AI Defaults. The TTS settings card remains hidden by explicit opt-out; its backend and supporting code remain present.

`routes.model_routes` clears `tts_provider` and `stt_provider` references when a referenced model endpoint is deleted.

TTS cache behavior:

- server cache lives under `data/tts_cache/`;
- cache keys include provider, model, voice, safe speed, and text;
- cache files are stored as MP3 or WAV;
- route stats expose global cache state;
- cache clear is global;
- frontend TTS has a separate object-URL cache.

`ODYSSEUS_TTS_CACHE_MAX_BYTES` bounds server cache growth and is forwarded by all Compose variants. The default is 500 MiB; invalid integers fall back to that default and values at or below zero disable eviction. After a cache write, enforcement scans only `.mp3`/`.wav`, ignores files that disappear or cannot be stated, and when over limit removes oldest-by-mtime entries toward 80% of the ceiling. Sort/stat/unlink failures are logged and do not fail synthesis.

## Security And Provenance

Speech routes rely on app-wide authentication and do not implement route-local admin or scope checks. Bearer-token callers that pass app auth can reach speech stats/synthesis/transcription/cache-clear surfaces using global speech settings.

Endpoint providers send user audio or assistant text to configured `ModelEndpoint` URLs with optional bearer keys. Endpoint lookup is by configured endpoint ID and currently does not enforce per-request owner filtering. `ModelEndpoint.api_key` is encrypted at rest and forwarded only process-side.

Microphone audio, uploaded audio, endpoint transcripts, and assistant text sent to TTS are untrusted/user/provider-visible data flows. Transcripts become user input; they are not trusted system instructions.

TTS cached audio can contain sensitive assistant text rendered as speech. The cache is global, has no owner partition or TTL, and is served inline/base64 by POST responses without a dedicated generated-file route.

## Degraded Behavior

- Optional local speech packages may be absent.
- Local STT can run CPU-only and tolerates missing/broken torch by falling back to CPU/int8 behavior.
- Local TTS/Kokoro extras are declared as `kokoro==0.9.4` plus `soundfile` only for Python 3.11-3.12; Python 3.13+ intentionally skips them because Kokoro excludes those runtimes. Even where installed, local Kokoro remains unavailable without a CUDA-capable torch build/GPU.
- External endpoint providers can be offline or misconfigured and may only fail at request time.
- Browser `speechSynthesis`, `SpeechRecognition`, `webkitSpeechRecognition`, secure context, and microphone permissions can be absent.
- Docker GPU overlays are passthrough-only and do not install speech engines by themselves.
- Optional dependency errors and route error wording are not fully consistent across STT and TTS.

## Testing Coverage

Existing coverage includes speech settings restore/default/read-failure/save behavior, recorder
format fallback and ownership including Compare Send/Stop transitions, speech service toggles,
malformed STT providers, malformed/non-string TTS provider and speed handling, cache stats plus configured
eviction/disable/file filtering/error handling, STT temp cleanup and MIME/extension metadata,
direct upload limits, model routes, and settings scrubbing.
Browser tests use synthetic media and fixture APIs; they do not validate a physical microphone,
browser permission prompt, real speech provider, local model, or GPU.

Missing coverage includes route-level STT failure and TTS success/failure shapes, auth/API-token
behavior, endpoint owner isolation, STT type/magic rejection, TTS request-size/no-store/cache
privacy behavior, and real provider or optional-dependency behavior.

## Current Gaps

- Speech routes need a deliberate API-token/scope policy.
- Endpoint speech providers need owner-isolation or explicit global-settings documentation.
- TTS cache needs privacy policy: owner partition, TTL, no-store response headers, or accepted global cache semantics.
- STT upload validation needs content type/extension/magic-byte policy.
