"""Stateful UI modules must have one identity across eager and lazy entry points."""
import posixpath
import re
from pathlib import Path
from urllib.parse import urlsplit

import pytest


_STATIC = Path(__file__).resolve().parents[1] / "static"
_SINGLETONS = [
    "js/models.js", "js/settings.js", "js/tasks.js", "js/memory.js",
    "js/modalManager.js", "js/slashCommands.js", "js/compare/index.js", "js/gallery.js",
    "js/sessions.js", "js/workspace.js", "js/approvalMode.js",
]


@pytest.mark.parametrize("module", _SINGLETONS)
def test_eager_and_lazy_entry_points_share_module_identity(module):
    identities = set()
    for source in _STATIC.rglob("*.js"):
        imports = re.findall(
            r"(?:\bfrom\s*|\bimport\s*\(?\s*)['\"]([^'\"]+)['\"]",
            source.read_text(encoding="utf-8"),
        )
        for spec in imports:
            if not spec.startswith("."):
                continue
            url = urlsplit(spec)
            path = posixpath.normpath(
                str(source.parent.relative_to(_STATIC) / url.path)
            )
            if path == module:
                identities.add((path, url.query, url.fragment))
    html = (_STATIC / "index.html").read_text(encoding="utf-8")
    for spec in re.findall(r'(?:src|href)="(/static/[^\"]+\.js[^\"]*)"', html):
        url = urlsplit(spec)
        if url.path == "/static/" + module:
            identities.add((module, url.query, url.fragment))
    assert identities == {(module, "", "")}, identities
