from pathlib import Path
import re


_SERVICE_WORKER = Path(__file__).resolve().parents[2] / "static/sw.js"


def service_worker_cache_name() -> str:
    source = _SERVICE_WORKER.read_text(encoding="utf-8")
    match = re.search(r"const CACHE_NAME = '([^']+)';", source)
    if not match:
        raise AssertionError("service worker has no CACHE_NAME declaration")
    return match.group(1)
