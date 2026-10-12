"""Non-executing syntax feedback for small source-file edits."""

import os
import re
import shutil
import subprocess


_MAX_SOURCE_BYTES = 256 * 1024
_JAVASCRIPT_SUFFIXES = {".js", ".mjs", ".cjs"}


def syntax_feedback(path: str, source: str) -> str | None:
    """Return a repair hint for known syntax errors; never execute source code."""
    suffix = os.path.splitext(str(path or ""))[1].lower()
    if suffix != ".py" and suffix not in _JAVASCRIPT_SUFFIXES:
        return None
    try:
        encoded = str(source or "").encode("utf-8")
    except (UnicodeError, ValueError):
        return None
    if len(encoded) > _MAX_SOURCE_BYTES:
        return None

    if suffix == ".py":
        try:
            compile(
                source, os.path.basename(path) or "<source>", "exec",
                dont_inherit=True,
            )
        except SyntaxError as exc:
            detail = str(exc.msg or "invalid syntax").splitlines()[0][:240]
            return _warning("Python", exc.lineno, detail)
        except Exception:
            return None
        return None

    node = shutil.which("node")
    if not node:
        return None
    if suffix == ".mjs":
        modes = [[node, "--input-type=module", "--check"]]
    elif suffix == ".cjs":
        modes = [[node, "--check"]]
    else:
        # `.js` can be either module or CommonJS without reading package.json.
        modes = [[node, "--check"], [node, "--input-type=module", "--check"]]

    env = os.environ.copy()
    env.pop("NODE_OPTIONS", None)
    last_error = "invalid syntax"
    last_line = None
    for command in modes:
        try:
            checked = subprocess.run(
                command, input=source, text=True, capture_output=True,
                timeout=3, env=env, check=False,
            )
        except (OSError, subprocess.SubprocessError, UnicodeError):
            return None
        if checked.returncode == 0:
            return None
        diagnostic = checked.stderr or checked.stdout or ""
        line_match = re.search(r"(?:\[stdin\]|stdin):(\d+)", diagnostic)
        if line_match:
            last_line = int(line_match.group(1))
        error_match = re.search(r"SyntaxError:\s*([^\n]+)", diagnostic)
        if not error_match:
            # A missing feature or a broken checker is not a source syntax error.
            return None
        last_error = error_match.group(1).strip()[:240]
        if suffix != ".js":
            break
    return _warning("JavaScript", last_line, last_error)


def _warning(language: str, line: int | None, detail: str) -> str:
    location = f" at line {line}" if line else ""
    return (
        f"Syntax check warning: {language}{location}: {detail}. The file was saved "
        "successfully; fix the syntax and run the relevant checks again. This syntax "
        "check does not verify functionality."
    )
