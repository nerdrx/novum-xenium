"""Deferred fake-fetch regressions for Documents library list ordering."""
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_library_list_requests_ignore_stale_results_and_duplicate_pages():
    result = subprocess.run(
        ["node", "tests/helpers/test_document_library_fetch_races.cjs"],
        cwd=ROOT, capture_output=True, text=True, timeout=20,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS: library list generation" in result.stdout
