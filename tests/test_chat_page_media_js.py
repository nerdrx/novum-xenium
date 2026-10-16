"""Headless checks for trusted, explicitly requested page-media rendering."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[1]


def _render(media):
    if not shutil.which("node"):
        pytest.skip("node is not installed")
    source = (_REPO / "static/js/chatRenderer.js").read_text(encoding="utf-8")
    start = source.index("export function buildPageMediaCard(")
    end = source.index("\nexport function toolEventStatus", start)
    function = source[start:end].replace("export function", "function", 1)
    script = r"""
      const makeNode = tag => ({tag, children: [], attributes: {}, appendChild(node) {
        this.children.push(node); return node;
      }, append(...nodes) { this.children.push(...nodes); }, setAttribute(k, v) {
        this.attributes[k] = v;
      }});
      const document = { createElement: makeNode };
      __FUNCTION__
      const card = buildPageMediaCard(JSON.parse(process.argv[1]));
      const walk = node => node && ({
        tag: node.tag, className: node.className || '', text: node.textContent || '',
        src: node.src || '', alt: node.alt || '', loading: node.loading || '',
        preload: node.preload || '', controls: !!node.controls,
        playsInline: !!node.playsInline, open: !!node.open, referrerPolicy: node.referrerPolicy || '',
        attributes: node.attributes, children: node.children.map(walk),
      });
      console.log(JSON.stringify(walk(card)));
    """.replace("__FUNCTION__", function)
    result = subprocess.run(
        ["node", "-e", script, json.dumps(media)], cwd=_REPO,
        capture_output=True, text=True, timeout=15,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_page_media_renderer_uses_safe_dom_nodes_and_never_autoplays():
    tree = _render([
        {"kind": "image", "url": "https://cdn.example/pic.png", "label": "<img onerror=bad>"},
        {"kind": "video", "url": "https://cdn.example/clip.mp4", "label": "Clip"},
        {"kind": "image", "url": "javascript:alert(1)"},
        {"kind": "video", "url": "http://cdn.example/clip.mp4"},
    ])
    assert tree["tag"] == "details"
    assert tree["children"][0]["text"] == "Page media"
    assert tree["open"] is True
    items = tree["children"][1]["children"]
    assert [item["tag"] for item in items] == ["figure", "figure"]
    image, video = items[0]["children"][0], items[1]["children"][0]
    assert image["src"] == "https://cdn.example/pic.png"
    assert image["loading"] == "lazy" and image["referrerPolicy"] == "no-referrer"
    assert image["alt"] == "<img onerror=bad>"  # assigned as text/attribute, never HTML
    assert video["controls"] and video["playsInline"] and video["preload"] == "none"
    assert not video.get("autoplay", False)


def test_page_media_renderer_caps_card_and_rejects_credentialed_urls():
    tree = _render([
        {"kind": "image", "url": "https://user:pass@cdn.example/private.png"},
        *[{"kind": "image", "url": f"https://cdn.example/{index}.png"} for index in range(8)],
    ])
    assert len(tree["children"][1]["children"]) == 6
