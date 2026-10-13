from collections.abc import Iterable


def parse_progress(lines: Iterable[str]) -> list[dict]:
    """Parse FFmpeg progress records as described in TASK.md."""
    raise NotImplementedError
