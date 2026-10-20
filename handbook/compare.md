# Compare models

Compare sends one prompt to several model or search-provider panes. Open
**Compare** from the tools menu or the Compare button in the side rail. Choose
at least one entry in the setup window, then select **Start**. The setup starts
with two slots; use **+** to add more, up to eight. Remove a slot with its
**×** button.

Compare uses saved model endpoints. Each slot can use a different model or
provider. A repeated model name can appear more than once when it comes from
different endpoints. The setup checks selected models before starting. This
preflight sends a short test prompt to each selected chat model; Agent mode also checks tool
support. The request can load a local model and may count as provider usage.
If a check fails, use **Retry**, **Go Back**, or **Start Anyway** after reviewing
the error. Start Anyway skips the failed preflight; it does not make the
provider available.

## Choose a comparison type

The **Type** tabs choose the work each pane performs:

- **Chat** sends the prompt to each selected chat model without the agent tool
  workflow.
- **Agent** sends it in Agent mode, with enabled agent tools such as shell and
  web search. Tool questions and approval requests appear in the relevant pane.
  Review each operation before approving it.
- **Search** selects search providers and a chat model for each pane to
  summarize that provider's results. Search providers need to be configured and
  available.
- **Research** pairs a chat model with a search provider for each pane, then
  runs the research flow. Research can take longer than ordinary chat.

Compare has no separate Image type tab. Image generation remains a separate
configured feature; see [Images and audio](media.md).

## Run and review

**Parallel** runs panes at once. **Sequential** runs one pane after another.
Search and Research start in Sequential mode; you can change the toggle before
starting. The **Timeout** field sets the chat-stream idle limit from 5 to 300
seconds. Agent mode uses at least a 300-second stream limit; Research uses a
longer stream limit. The field is not a universal deadline for Search
provider requests. A pane can still fail because of its provider, account, or
network.

**Blind** is on by default. It hides model names in panes until you vote; a
failed preflight can reveal a model name. The setup **Shuffle** randomly
assigns available models to slots and turns Blind on. After starting, the
**Shuffle** button reorders pane positions; it does not change their models
and turns Blind back on. Turn Blind off to show model names before voting.
These controls change presentation and selection; they do not make responses
independent or provide a quality benchmark.

Send a prompt from the shared composer. Use the pane's **Stop** button to stop
one pane, or the composer **Stop** button to stop all panes. Stop ends the
browser's active request where possible; it cannot undo completed tool or
provider actions, and it does not guarantee that already-started backend work
has stopped. Inspect each pane before retrying.

Choose a pane's **Vote** action, or **Tie**, to record a result. A vote can stop
other panes that are still streaming. The **Scoreboard** shows saved votes by
comparison type. **Prompt sets** offers built-in evaluation prompts; prompts
with an expected answer can receive an automatic match grade. These are
convenience checks, not a standardized model benchmark.

**Save** keeps the comparison sessions when Compare closes. With Save off,
Compare removes its temporary sessions when it closes. Search mode does not
create per-pane sessions; its synthesis sessions are deleted after successful
runs, so **Save** does not preserve Search results. Before closing Compare,
use **Export** and choose **Copy as Markdown**, **Download .md**, or
**Print / Save PDF**. Votes are stored separately from sessions.

## If Compare does not start or a pane fails

1. Check the exact message in the setup probe or affected pane. Other panes
   may have completed successfully.
2. Confirm the endpoint and model in **Settings → Admin → Endpoints**. Run
   **Probe** there. If Compare cannot load its model list, close the setup and
   open Compare again after restoring the connection. A listed model or
   passing preflight does not prove generation will succeed. See
   [Providers and models](providers.md) for endpoint recovery.
3. For Search or Research, confirm the selected search provider is configured
   and available. Check its credentials and service status in Settings.
4. Retry only the failed pane after checking whether its first request produced
   output or completed a tool action. Starting again can duplicate external
   effects.
5. If model loading remains stuck, follow [Models and memory](troubleshooting/models.md).
   For a broader page or service failure, use [Startup and loading](troubleshooting/startup.md).

Compare uses the signed-in account and configured endpoints. If account
verification fails or the account changed, follow [Account verification
stops a send](troubleshooting/tools.md#account-verification-stops-a-send).
Hosted providers receive the prompts and context sent to them. Agent tools can
read or change resources subject to configured permissions and execution
environment. Compare does not add a separate isolation boundary. Blind mode
hides labels in the pane; it does not hide request data from the backend or
provider.

## Source behavior

See the maintained [Compare selector](https://github.com/nerdrx/novum-xenium/blob/main/static/js/compare/selector.js), [request and stream handling](https://github.com/nerdrx/novum-xenium/blob/main/static/js/compare/index.js), [pane controls](https://github.com/nerdrx/novum-xenium/blob/main/static/js/compare/panes.js), and [votes and grading](https://github.com/nerdrx/novum-xenium/blob/main/static/js/compare/vote.js).
