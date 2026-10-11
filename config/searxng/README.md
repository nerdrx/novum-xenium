# Search sources

The bundled configuration enables Bing, Mwmbl and Wiby for web results; Wikipedia for reference information; Bing News; GitHub and Stack Overflow; and Semantic Scholar and Crossref for papers. Agent tools use the JSON API. General AI searches request `bing,mwmbl,wiby,wikipedia`; news searches use the news category.

Set `SEARXNG_GENERAL_ENGINES` to change the general search engine list. An empty value uses the instance's enabled category defaults. The requested engines must also be loaded and enabled in SearXNG. Models can select specialized sources in their query with SearXNG shortcuts: `!gh` for GitHub, `!st` for Stack Overflow, `!se` for Semantic Scholar and `!cr` for Crossref.

DuckDuckGo, Brave, Google, Google News, Startpage and arXiv remain available in Preferences but are disabled by default after local checks encountered CAPTCHA, rate limits, empty results or timeout. Availability varies by network and over time; enable and test them on your installation.

Docker preserves `/etc/searxng/settings.yml` in its data volume. Updating this template affects fresh installations; existing installations keep their own settings. Back up and edit the retained file, preserve its `server.secret_key`, then restart only SearXNG. Keep both `html` and `json` formats enabled for browser and agent access.
