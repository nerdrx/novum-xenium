# Troubleshooting startup and loading

Use the first matching symptom. These checks preserve data and help locate the
failed layer. Do not remove a container, volume, database, or data directory as
a startup fix.

## The web page does not open

From the repository directory, run:

```sh
docker compose ps
```

- **`odysseus` is exited or restarting:** inspect recent logs with
  `docker compose logs --tail=150 odysseus`. Look for the first error before
  the restart loop. Correct that error, then run `docker compose up -d` and
  check `ps` again.
- **`odysseus` is running:** confirm the address and port. The default is
  `http://localhost:7000`; a custom `APP_BIND` or `APP_PORT` changes how the
  host exposes it. Check whether another service owns the port. Do not expose a
  plain unauthenticated port to the internet.
- **The browser shows a login/setup page:** use the account credentials set
  during first-run setup. If no admin password was configured, inspect the
  first-run output with `docker compose logs odysseus`; redact the temporary
  credential immediately after use.
- **Startup logs show database, migration, or storage errors:** preserve the
  full data directory. Copy it to a private backup location before attempting
  recovery. Do not delete the database or restore over a running backend.

Run this read-only log check when the container state is unclear:

```sh
docker compose logs --tail=150 odysseus
```

Review logs before sharing them. They can contain credentials, addresses, and
private request data.

## The desktop manager cannot open the workspace

Confirm the manager selected the intended checkout and Compose project. Check
the manager's health result and recent logs, then run `docker compose ps` and
the log command above from that checkout. The desktop manager controls an
existing checkout; it does not install Docker or create a backend checkout.
Keep the checkout and data while diagnosing. See [Desktop manager](../desktop.md).

## The page opens, but a model request never starts

The application and model provider are separate services. First confirm that
the provider is saved and online in **Settings → Admin → Endpoints**. Select
**Probe** to re-test saved endpoints. If the model is absent, check that the
provider's model-list endpoint works and refresh the model picker. If it is
listed but a prompt fails, inspect the exact error and provider logs. A
reachable list endpoint does not prove inference works.

In Docker, `localhost` inside Novum refers to the Novum container. Use a
service name on the Compose network or a host address reachable from the
container. Do not bind a local provider to every network interface just to
make discovery succeed.

## A chat or saved session stays loading

Wait for one status update, then inspect the session and provider before
retrying. In current builds, session-list loading and body parsing are bounded
to 15 seconds; on timeout the saved draft/list remains available for a manual
retry. A streaming watchdog probes the affected session after inactivity; it
does not replay the prompt. Use the visible retry or send action only after
checking whether the prior request produced a result. Older builds may not
include these recovery changes; compare the installed version with the
[current source](https://github.com/nerdrx/novum-xenium/blob/main/static/js/chat.js).

## Sending says the account cannot be verified or has changed

**Cannot verify your account:** the account-status request failed, returned an
unexpected response, or exceeded its 15-second deadline. Your current message
and attachments remain in the page. Check the backend connection, then retry;
the next send checks again. This blocked attempt does not upload files or post
the chat request.

**Your account changed:** copy any newly typed text you need, then reload the
page and confirm the signed-in account before sending. Old tabs must not send
using another account's saved drafts or model choices. Reload can discard
unsaved input and selected local files, so do not use it before saving anything
you need from the current page.

## Safe next step

If the issue remains, record the Novum version, platform, install method,
container state, first relevant error, and exact steps. Remove API keys,
passwords, cookies, private addresses, and chat text before sharing diagnostics.
See [First checks](index.md), [Models and memory](models.md), and
[Configuration and administration](../reference/configuration.md).
