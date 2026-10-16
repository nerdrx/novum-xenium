import asyncio
import json
from bs4 import BeautifulSoup
from services.search.content import _extract_media
from src.agent_tools.web_tools import WebFetchTool
from src.tool_capabilities import web_fetch_preflight_error, _web_fetch_read_url


def test_media_references_resolve_deduplicate_and_skip_unsafe_or_nonmedia():
    soup = BeautifulSoup('''<img src="/pic.gif" alt="Animation"><a href="/pic.gif">same</a>
    <video><source src="//cdn.example.org/clip.webm" type="video/webm"></video>
    <video src="/watch?id=player"></video>
    <video><source src="/stream?id=123" type="video/mp4"></video>
    <video><source src="/clip.ogv?token=1" type="video/ogg"></video>
    <a href="/full.jpg">Photo</a><a href="/watch">not a direct video</a>
    <img src="javascript:alert(1)"><img src="data:image/png;base64,no">
    <img src="http://example.org/insecure.jpg"><img src="https://127.0.0.1/x.jpg">
    <img src="https://router.local/x.jpg"><img src="https://user:secret@example.org/x.jpg">
    <img src="/tracking.gif" width="1">''', 'html.parser')
    media = _extract_media(soup, 'https://example.org/story')
    assert [(m['kind'], m['url']) for m in media] == [
        ('video', 'https://cdn.example.org/clip.webm'),
        ('video', 'https://example.org/clip.ogv?token=1'),
        ('image', 'https://example.org/pic.gif'),
        ('image', 'https://example.org/full.jpg'),
    ]
    assert len(_extract_media(BeautifulSoup(''.join(f'<img src="/{i}.jpg">' for i in range(30)), 'html.parser'), 'https://example.org')) == 12


def test_media_fetch_exposes_real_references_even_when_page_has_no_text(monkeypatch):
    calls = []
    def fetched(url, **kwargs):
        calls.append(url)
        return {'content': '', 'media': [{'kind': 'image', 'url': 'https://example.org/pic.gif', 'label': 'Animation'}]}
    monkeypatch.setattr('src.search.content.fetch_webpage_content', fetched)
    args = json.dumps({'url': 'https://example.org/gallery', 'include_media': True})
    assert web_fetch_preflight_error(args) is None
    assert _web_fetch_read_url(args) == 'https://example.org/gallery'
    result = asyncio.run(WebFetchTool().execute(args, {}))
    assert result['exit_code'] == 0
    assert result['media'][0]['url'] == 'https://example.org/pic.gif'
    assert 'not been visually verified' in result['output']
    assert calls == ['https://example.org/gallery']  # no media downloads


def test_video_is_not_hidden_by_earlier_navigation_icons():
    page = ''.join(f'<img src="/icon-{i}.png">' for i in range(20)) + '<video src="/clip.webm"></video>'
    media = _extract_media(BeautifulSoup(page, 'html.parser'), 'https://example.org/gallery')
    assert len(media) == 12
    assert media[0]['url'] == 'https://example.org/clip.webm'
    assert any(item['kind'] == 'image' for item in media)
