# Images and audio

Image generation, image editing, speech/audio, and chat text use separate providers or engines. Availability depends on configuration. Do not assume that connecting a chat model also configures images or audio.

## Local image generation

The Docker backend includes a local image engine with CPU and Vulkan options. Linux x86_64 can include a zVram Vulkan path. Model weights are downloaded separately; the container image does not contain them. A model is loaded for a request rather than all models being kept in GPU memory. Compatible models and recipes are listed in the canonical [local image runtime guide](https://github.com/nerdrx/novum-xenium/blob/main/docs/local-images.md).

On Linux, the documented Vulkan route needs a host driver, Docker access to `/dev/dri`, and the repository's `docker/gpu.vulkan.yml` Compose override with the host render-group ID configured. Windows/macOS Docker Desktop GPU passthrough is not covered by that route; CPU mode remains available. A zVram paging option can be slow and does not guarantee a model fits under all concurrent GPU load.

To use a local image model, download a supported model in Cookbook, wait for the completed download to appear, then select it under **Settings → AI → Image Generation**. Use a small request first. If loading fails, check the selected engine, model support, and available host/container resources.

## Hosted image providers

Image providers are configured separately from chat providers. Some workflows can use an existing host login through the optional Codex image bridge, which needs its own setup. It is not installed or enabled merely by using a chat model. See the [Codex image bridge instructions](https://github.com/nerdrx/novum-xenium/blob/main/docs/codex-image-bridge.md).

## Gallery uploads and previews

Gallery image uploads accept PNG, JPEG, WebP, and GIF. Novum identifies a supported image before saving its file or database entry. Unrecognized image bytes are rejected; replacing an image with unrecognized bytes leaves the existing image intact. An optional EXIF metadata warning can still accompany an accepted image. Identifying the format does not guarantee every pixel or metadata field is valid.

Bulk imports report imported, duplicate, and failed counts separately. Failures produce an error notification with the first available server reason, shortened for readability and displayed as plain text. Other selected files can still succeed. When imports overlap, the progress bar follows the newest batch; earlier batches continue and still report their results. See the pinned [bulk upload handler](https://github.com/nerdrx/novum-xenium/blob/69f85cf682cd092e031d37831748365b962d227c/static/js/gallery.js).

Album-list reads stop waiting after 15 seconds, including a stalled response body. A failed refresh keeps the last successful list and offers Retry. After an album action fails, a stalled recovery refresh can keep its control locked and delay the warning for up to 15 seconds. The mutation request itself has no new deadline. Pressing Enter in a photo name saves once through the existing blur handler; a failed rename keeps the typed value for retry.

XBM processing is disabled on the guarded image-input paths. Generic chat uploads retain their broader file support: if optional image metadata or thumbnail creation fails, the original file remains available. This does not make every supported decoder safe; see [dependency audit findings](reference/security.md#dependency-audit-findings).

## Saved image-editor projects

Open Gallery’s **Edit** tab to load saved projects. If the list cannot be loaded
or refreshed, Novum keeps the last successfully loaded list and displays **Retry**.
That list may be stale; retry after checking the connection. A successful empty
response still hides the section. A failed refresh does not mean projects were
deleted. Newer list requests own the result, so a late failure cannot replace
the newer list or its loading indicator.

See the pinned [draft-list controls](https://github.com/nerdrx/novum-xenium/blob/69f85cf682cd092e031d37831748365b962d227c/static/js/gallery.js).

## Audio

The desktop's local Linux alarm is a host-side feature that uses a user-session timer and restores the previous system volume/mute state after its bounded playback. The computer and user audio session must be available. It does not wake a powered-off computer or act as an Android alarm. Other voice/audio features require their own supported provider configuration.


### Chat microphone

In ordinary chat, when speech input is enabled for your instance, an empty composer with no
attachments shows a microphone button. Select it to request microphone access;
select **Stop** to end the app's pending attempt or recording. Capture requires
HTTPS or localhost. If access is denied, review this site's microphone
permission in your browser, then try again. If no microphone is found, check
that an input device is connected and available to the browser.

To enable speech input, open **Settings → AI Defaults → Speech to Text**, turn
on the setting, and choose **Browser (built-in)**, **Local model**, or a
configured API endpoint. Speech input is off by default, and changing these
instance settings requires administrator access. Only a saved boolean `true`
enables speech input; missing or malformed values act as off without rewriting the
saved setting. If saved settings cannot be loaded, the controls stay unavailable;
reload the app and try again. The speech
service treats an empty or non-string saved provider as disabled without
rewriting that stored setting. The browser provider uses the browser's Web Speech
API, whose availability and behavior depend on the browser. A Local model status
check does not load Whisper. Empty or over-limit audio is rejected before a local
model is initialized. Loading a cold configured model is attempted on the first
valid transcription request. Changing the configured local model takes effect at
the next transcription attempt; status checks do not reload or unload the cached model. See the pinned [settings panel](https://github.com/nerdrx/novum-xenium/blob/b38a9c98283208e62a39d9269a47ac74c717a06a/static/index.html)
and [speech service](https://github.com/nerdrx/novum-xenium/blob/6fc1a623e0cb5e5c3d19b49cb901a0ca7ddc31f4/services/stt/stt_service.py)
for those settings and loading boundaries.

**Stop cannot close a browser permission prompt.** Respond to that prompt in
the browser. A grant arriving after Stop does not start recording; select the
microphone again to make a new attempt. If creating the audio recorder or its
`start()` call fails, the app releases the acquired stream, returns the composer
to idle, and shows an error. An older permission result does not reset newer
recording controls.

Compare uses its composer button to send to or stop Compare runs; it does not
start microphone capture. Entering Compare cancels the app's pending recording
attempt or stops an active recording before switching chats. If the transcript
finishes after Compare opens, it stays with the chat captured when recording stopped,
not the Compare composer.
The Compare **Stop** action becomes available as soon as a run begins. See the
[chat action handler](https://github.com/nerdrx/novum-xenium/blob/68035935097a29d1461cb06b38868c8c02166c9b/static/app.js)
for Compare button ownership.

If browser speech recognition is unavailable or cannot be started, audio capture
continues. Stop remains available; if there is no browser transcript, the
recording uses the normal audio-file fallback. Once the audio recorder finishes,
Novum waits up to two seconds for browser recognition to end and uses the
transcript received so far. If none arrived, it attaches the recorded audio; if recognition has not
ended, Novum makes a best-effort abort. Each recording keeps its own audio
chunks, browser transcript, and recognizer. Changing the speech setting during
a Browser recording does not leave that recording's recognizer running after Stop.
A late completion from an older
recording does not reset the controls for a newer one.

Stopped audio follows the configured speech path: transcription can add text
to the composer, and supported fallback paths attach the recording as a file.
Those audio attachments are separate from the browser's plain-text draft store.
If the browser rejects the requested WebM recording format, the app retries
with the browser's native recording format. Recognized formats keep matching
attachment and transcription metadata; MP4 audio may appear as an `.m4a` file.
Unrecognized formats are kept as `.bin` files.
An explicit **Stop** chooses the chat or pending draft open at that moment.
If you switch chats while transcription finishes, the text is kept with that
destination rather than inserted into the newly opened composer. A newer draft
there is preserved and the transcript is appended. Page-only and incognito
drafts are not saved for reload. If the original destination is unavailable,
Novum can offer **Copy transcript** or **Discard transcript**. If copying fails,
you can explicitly download `voice-transcript.txt` or discard it; Novum does not
download automatically, persist the transcript, or insert it into the current
chat, and it checks account identity again before downloading.

Audio fallback attaches only when its destination is still current. Otherwise,
Novum offers a download or discard instead of attaching it to another chat.
If recording ends naturally and navigation makes its destination ambiguous,
Novum offers explicit transcript/audio recovery without assigning it to either
chat automatically. Browser recognition has the brief completion wait described
above; server-side transcription can finish later. Review the result before
sending it. See
the pinned [Speech specification](https://github.com/nerdrx/novum-xenium/blob/e40e94de6027b922af969f82b288dd7851f7d92b/specs/speech.md)
and [recording implementation](https://github.com/nerdrx/novum-xenium/blob/b1b3c622ec9f7b0fce5e1b6787beafcaad0d1229/static/js/voiceRecorder.js)
for provider and fallback behavior. The [session recovery implementation](https://github.com/nerdrx/novum-xenium/blob/86b9d1d3b72166d0b1a28d0968a1da70713978c6/static/js/sessions.js)
keeps this text recovery separate from chat insertion. Chat model configuration
alone does not enable speech input.

## Troubleshooting

If the request succeeds but no image appears, inspect the Gallery result and the engine's status. If the model fails to load, follow [Models and memory](troubleshooting/models.md). Do not repeatedly retry large image requests while the engine reports out of memory.
