# Deep Research

Deep Research runs a multi-step investigation: it plans queries, searches,
reads selected pages, evaluates findings, and writes a report with source
links. The model decides whether more rounds are useful, subject to the run's
limits. It can take longer and make more provider requests than a quick search
or an ordinary chat reply.

## Start a saved report

Open **Deep Research** from the left rail or the tools sidebar. Enter a focused
question in **Research**. Open **Settings** to adjust the run:

- **Rounds**: **Auto** lets the engine decide when to stop, with a maximum of
  20 rounds; choose 1–20 for a fixed cap. A cap is not a promise that every
  round will complete.
- **Format**: **Auto**, **Product**, **Compare**, **How-to**, or **Fact-check**
  guides the report's organization.
- **Search engine**: **Default**, **searxng**, **duckduckgo**, **tavily**,
  **brave**, **google**, or **serper**. Default follows the configured research
  search provider, then the configured general search provider. Provider
  fallback may be used; the selected entry does not guarantee which provider
  returns results.
- **Endpoint** and **Model**: choose an enabled LLM endpoint, or leave it on
  **Default** to use the configured research route and its fallback chain.
  The model picker lists models from enabled LLM endpoints; choosing a model
  also selects its owning endpoint. Add or check endpoints in **Settings →
  Admin → Endpoints**.

Select **Start** to run the current question. **Ctrl+Enter** (or **⌘+Enter**)
also starts it. **Queue** adds the question to the panel's active list without
launching it. Start queued jobs one at a time or, when starting several, choose
parallel or sequential execution. Parallel jobs can send concurrent requests
to the same model service.

## Follow progress and read a report

The **Active** tab appears while jobs are queued or running. Expand a running
card to see its current phase, round, source count, and available navigation
or action trace. The rail and tools button also indicate active work. **History**
lists completed and failed entries; use its search, category filters, and sort
menu to find a report.

A completed card offers **Visual** to open the HTML report and **Copy report**
in its more-actions menu. **Chat** opens a follow-up chat seeded with the
report as context. A report may complete with no usable sources; the card
flags this and suggests retrying or changing settings. Check its sources and
citations before relying on a conclusion.

## Research from chat

In a chat, enable **Deep Research** from the composer tools. This toggle is
available in Chat mode; enabling it turns off the separate web-search toggle
and switches from Agent mode to Chat mode. The next message runs research
before the normal chat model answers, with the research result added as
untrusted context. This is a different path from starting a standalone report
in the Deep Research panel.

An Agent can also start a background Deep Research job with `trigger_research`.
The job appears in the Deep Research panel. When started from a chat, the
default is a quick two-round pass. When it finishes, Novum stores the report
and delivers a summary and report link into the originating chat when that
chat is idle. Delivery can wait while the chat is busy. A summary-generation
failure still leaves the saved report link available.

## Stop, status, and recovery

Use the running card's **Cancel research** action to request cancellation.
Cancellation is cooperative; if the server cannot confirm it, the card warns
that the job may still be running. A request already sent to a model, search
provider, or website cannot be recalled. Closing or minimizing the panel is
not the cancel action.

The panel reconnects to active jobs and refreshes their status. If a progress
stream stalls, it falls back to status polling; the existing troubleshooting
guide notes that a stalled poll retries later without restarting the job or
resending the prompt. If a job errors, read its displayed error before using
**Retry**, or use **Edit** to revise the question or settings. A retry starts
a new run and can repeat provider requests. If the application server restarts
while a job is in flight, that in-memory run may be interrupted; completed
reports are stored separately.

## Data and provider boundaries

When authentication is enabled, sign in with an account allowed to use
Research. Authentication-disabled deployments do not provide signed-in
account separation. The backend saves completed reports under its local
research-data directory and associates them with an owner for account-level
reads and deletion. A self-hosted app does not make a hosted model or search
service local. The selected research model receives your question and the
prompts and retrieved page content needed to plan, extract, and synthesize
findings. The configured search service receives search queries generated
from that question. A chat-started background job can also send report context
to the chat's configured model to prepare the delivered summary. Provider
terms, network access, quotas, and charges depend on the endpoint and services
configured for that deployment.

The research planner can request a browser read for a page that ordinary
fetching cannot read. In this source revision, the private-browser capability
does not provide page reading, so do not rely on Deep Research to read
logged-in browser content. Include only public URLs you intend the research
service to fetch.

The built-in search and fetch tools are a quick lookup path for a small set of
results or a known page. Deep Research iterates across planning, search,
reading, analysis, and report writing. **Compare → Search** summarizes each
selected search provider's results; **Compare → Research** runs a research
flow for each pane. These are separate workflows with separate controls; see
[Compare models](compare.md).

## Source behavior

See the frozen [Research panel](https://github.com/nerdrx/novum-xenium/blob/17161af68b643f6dde45d3f9c61d26ce22c5589d/static/js/research/panel.js),
[job lifecycle](https://github.com/nerdrx/novum-xenium/blob/17161af68b643f6dde45d3f9c61d26ce22c5589d/static/js/research/jobs.js),
[research routes](https://github.com/nerdrx/novum-xenium/blob/17161af68b643f6dde45d3f9c61d26ce22c5589d/routes/research/research_routes.py),
[research engine](https://github.com/nerdrx/novum-xenium/blob/17161af68b643f6dde45d3f9c61d26ce22c5589d/src/deep_research.py),
and [background delivery](https://github.com/nerdrx/novum-xenium/blob/17161af68b643f6dde45d3f9c61d26ce22c5589d/src/background_tool_jobs.py).
