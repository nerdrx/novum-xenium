Implement `decode_lines(chunks) -> list[str]` in `solution.py` using only Python's standard library.

`chunks` is a finite iterable of `bytes` chunks (possibly a one-shot generator). Decode their UTF-8 text incrementally across chunk boundaries with strict error handling, and return its logical lines as a list of strings. Inputs are guaranteed to be bytes; no other argument validation is needed.

Exact behavior:
- A newline is LF (`\n`). Remove that LF from the returned line. If a CR (`\r`) immediately precedes that LF, remove that one CR too (CRLF), even across chunk boundaries.
- Preserve every other CR, all other characters, and all whitespace. Do not use general whitespace stripping or treat a lone CR as a line separator.
- Emit empty lines for actual empty lines. A final LF does not create an additional line after it. Thus empty input returns `[]`, `b'\n'` returns `['']`, and `b'a\n\n'` returns `['a', '']`.
- At end of input, emit any nonempty remaining text as the final unterminated line, including a final lone CR. Do not emit an extra empty remainder.
- Empty chunks have no effect. UTF-8 code points and CRLF pairs may span any number of chunks.
- Invalid UTF-8 must raise `UnicodeDecodeError`, including an incomplete code point at end of input. Never replace or ignore invalid bytes.
- Consume the iterable once. Return a list (not a lazy iterator); do not print or write files.

Change only `solution.py`. Run `python3 qa_check.py` to verify. No third-party dependencies.
