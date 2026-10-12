from routes.chat_routes import _is_pure_web_intent


_REPAIR_PROMPT = """Continue repairing this existing app. FFmpeg is now installed in this container by the test operator; verify with ffmpeg -version. ffmpeg-python is only a wrapper, not a replacement executable. Do NOT rewrite the UI again. First make one real HTTP conversion work: the current HTTPServer callback has the wrong signature, no POST handler exists, and file input is hardcoded to input.mp4. Serve src/ and implement a same-origin upload/convert/download path using uploaded bytes and subprocess argument arrays. Bind 127.0.0.1 on a free port (not 8080). Run an actual request with a tiny ffmpeg-generated fixture and ffprobe the output. Then fix the frontend globals: all 12 inline handlers are still undefined in a browser. Existing app must be initialized exactly once and expose/wire those handlers. Use File bytes rather than browser fake file paths. No simulated success, no shell commands from request strings. Test before documentation or GitHub. Keep edits small."""


def test_coding_repair_prompt_with_current_word_keeps_workspace_tools():
    assert not _is_pure_web_intent(_REPAIR_PROMPT, "/workspace", True)


def test_plain_web_lookup_still_gets_web_only_clamp():
    assert _is_pure_web_intent("Search online for the latest FFmpeg docs", "/workspace", True)
