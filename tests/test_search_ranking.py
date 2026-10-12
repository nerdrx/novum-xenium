from services.search.ranking import rank_search_results


def test_news_queries_prefer_news_sources_over_sports_and_social_results():
    results = [
        {
            "title": "Chicago Stars fire GM Richard Feuz",
            "url": "https://www.reuters.com/sports/soccer/chicago-stars-fire-gm-richard-feuz--flm-2026-05-27/",
            "snippet": "The Chicago Stars fired their general manager.",
        },
        {
            "title": "United States Eliminates Canada In Quarterfinals",
            "url": "https://sports.yahoo.com/articles/united-states-vs-canada-live-updates-170747222.html",
            "snippet": "United States eliminated Canada in hockey.",
        },
        {
            "title": "Canada - AP News",
            "url": "https://apnews.com/hub/canada",
            "snippet": "Stay up to date on the latest Canada news coverage from AP News.",
        },
        {
            "title": "CBC News - Canada",
            "url": "https://www.cbc.ca/news/canada",
            "snippet": "Your source for Canadian news in English.",
        },
        {
            "title": "CTV News - Canada",
            "url": "https://www.ctvnews.ca/canada",
            "snippet": "Latest news, travel, politics, money, jobs and more.",
        },
    ]

    ranked = rank_search_results("Canada news today", results)
    top_urls = [item["url"] for item in ranked[:3]]

    assert "https://apnews.com/hub/canada" in top_urls
    assert "https://www.cbc.ca/news/canada" in top_urls
    assert "https://www.ctvnews.ca/canada" in top_urls
    assert ranked[-1]["url"].startswith("https://sports.yahoo.com/")


def test_github_cli_result_outranks_unrelated_freebsd_org_result():
    query = "create private github repository github cli"
    results = [
        {
            "title": "FreeBSD VuXML - entry date index",
            "url": "http://www.vuxml.org/freebsd/",
            "snippet": "Ports Collection repository, path ports/security/vuxml/vuln.xml as a local copy, compressed with bzip2 as a local copy.",
        },
        {
            "title": "Blog posts - cri.dev",
            "url": "https://cri.dev/posts/",
            "snippet": "Create a new Github repository from the command line 01/04 About vanity metrics and social media bullshit 2013 10/12 Simple templating with regular expressions.",
        },
    ]

    ranked = rank_search_results(query, results)

    assert ranked[0]["url"] == "https://cri.dev/posts/"
