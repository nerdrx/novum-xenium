# Images and audio

Image generation, image editing, speech/audio, and chat text use separate providers or engines. Availability depends on configuration. Do not assume that connecting a chat model also configures images or audio.

## Local image generation

The Docker backend includes a local image engine with CPU and Vulkan options. Linux x86_64 can include a zVram Vulkan path. Model weights are downloaded separately; the container image does not contain them. A model is loaded for a request rather than all models being kept in GPU memory. Compatible models and recipes are listed in the canonical [local image runtime guide](https://github.com/nerdrx/novum-xenium/blob/main/docs/local-images.md).

On Linux, the documented Vulkan route needs a host driver, Docker access to `/dev/dri`, and the repository's `docker/gpu.vulkan.yml` Compose override with the host render-group ID configured. Windows/macOS Docker Desktop GPU passthrough is not covered by that route; CPU mode remains available. A zVram paging option can be slow and does not guarantee a model fits under all concurrent GPU load.

To use a local image model, download a supported model in Cookbook, wait for the completed download to appear, then select it under **Settings → AI → Image Generation**. Use a small request first. If loading fails, check the selected engine, model support, and available host/container resources.

## Hosted image providers

Image providers are configured separately from chat providers. Some workflows can use an existing host login through the optional Codex image bridge, which needs its own setup. It is not installed or enabled merely by using a chat model. See the [Codex image bridge instructions](https://github.com/nerdrx/novum-xenium/blob/main/docs/codex-image-bridge.md).

## Audio

The desktop's local Linux alarm is a host-side feature that uses a user-session timer and restores the previous system volume/mute state after its bounded playback. The computer and user audio session must be available. It does not wake a powered-off computer or act as an Android alarm. Other voice/audio features require their own supported provider configuration.


### Chat microphone

When speech input is enabled for your instance, an empty chat composer with no
attachments shows a microphone button. Select it to request microphone access;
select **Stop** to end the app's pending attempt or recording. Capture requires
HTTPS or localhost. If access is denied, review this site's microphone
permission in your browser, then try again. If no microphone is found, check
that an input device is connected and available to the browser.

**Stop cannot close a browser permission prompt.** Respond to that prompt in
the browser. A grant arriving after Stop does not start recording; select the
microphone again to make a new attempt. If creating the audio recorder or its
`start()` call fails, the app releases the acquired stream, returns the composer
to idle, and shows an error. An older permission result does not reset newer
recording controls.

If browser speech recognition is unavailable or cannot be started, audio capture
continues. Stop remains available; if there is no browser transcript, the
recording uses the normal audio-file fallback. Once the audio recorder finishes,
Novum waits up to two seconds for browser recognition to end and uses the
transcript received so far. If none arrived, it attaches the recorded audio; if recognition has not
ended, Novum makes a best-effort abort. Each recording keeps its own audio
chunks, browser transcript, and recognizer. A late completion from an older
recording does not reset the controls for a newer one.

Stopped audio follows the configured speech path: transcription can add text
to the composer, and supported fallback paths attach the recording as a file.
Those audio attachments are separate from the browser's plain-text draft store.
If the browser rejects the requested WebM recording format, the app retries
with the browser's native recording format. Recognized formats keep matching
attachment and transcription metadata; MP4 audio may appear as an `.m4a` file.
Unrecognized formats are kept as `.bin` files.
Transcription is inserted into the composer that is open when the result
completes. Browser recognition has the brief completion wait described above;
server-side transcription can finish later. Wait for transcription before
switching chats, and review the result before sending it. See
the pinned [Speech specification](https://github.com/nerdrx/novum-xenium/blob/d5864db488ce762a670e27080bfb357a67e76980/specs/speech.md)
and [recording implementation](https://github.com/nerdrx/novum-xenium/blob/8c7b37698a2d4964c7463ab97133767894792b08/static/js/voiceRecorder.js)
for provider and fallback behavior. Chat model configuration alone does not
enable speech input.

## Troubleshooting

If the request succeeds but no image appears, inspect the Gallery result and the engine's status. If the model fails to load, follow [Models and memory](troubleshooting/models.md). Do not repeatedly retry large image requests while the engine reports out of memory.
