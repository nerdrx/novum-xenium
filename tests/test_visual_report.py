from bs4 import BeautifulSoup

from src.visual_report import generate_visual_report


def test_visual_report_toc_links_match_rendered_heading_ids():
    report = """
# Automated Crypto Trading Bot Strategies

### **1.0 Introduction & Research Scope**

Intro body.

### **2.0 Determining the "Best" Configuration**

Configuration body.
"""

    html = generate_visual_report(
        "crypto bot strategies",
        report,
        sources=[],
        stats={},
        session_id="rp-test",
    )
    soup = BeautifulSoup(html, "html.parser")

    links = soup.select(".toc-sidebar nav a")
    assert [link.get_text(strip=True) for link in links] == [
        "1.0 Introduction & Research Scope",
        '2.0 Determining the "Best" Configuration',
    ]

    for link in links:
        target_id = link["href"].removeprefix("#")
        target = soup.find(id=target_id)
        assert target is not None
        assert target.name in {"h2", "h3"}


def test_visual_report_uses_novum_branding_and_self_contained_icon():
    page = generate_visual_report("A sample report", "## Findings\nEvidence here.", sources=[], stats={}, session_id="brand-test")
    soup = BeautifulSoup(page, "html.parser")
    assert "Novum Xenium" in soup.select_one(".hero-label").get_text()
    assert "Novum Xenium" in soup.select_one(".report-footer").get_text()
    assert "Odysseus" not in soup.get_text()
    assert soup.select_one('link[rel="icon"]')["href"].startswith("data:image/svg+xml,")
    assert "#100f14" in page and "#a88bd6" in page


def test_section_heading_is_not_stolen_as_report_title():
    from src.visual_report import _extract_report_title
    body = "## Findings\nEvidence here.\n\n## What to check\nKeep this section."
    assert _extract_report_title(body, "Original question") == ("Original question", body)
    code = "```markdown\n# Example heading\n```"
    assert _extract_report_title(code, "Original question") == ("Original question", code)
    assert _extract_report_title("# Actual report title\n\n## Findings\nEvidence", "Question") == ("Actual report title", "## Findings\nEvidence")
