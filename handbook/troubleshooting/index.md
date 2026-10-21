# Troubleshooting: first checks

Start with the visible symptom. Preserve the workspace and application data while diagnosing. Avoid deleting containers, volumes, caches, or databases as a first step.

## Gather a small diagnostic set

For the standard Docker Compose install, from the repository directory:

```sh
docker compose ps
docker compose logs --tail=150 odysseus
```

These commands report container state and recent application logs. Logs can include private details; review them before sharing. Remove credentials, cookies, API keys, chat text, and private addresses before filing a report.

For the desktop app, capture the selected checkout, backend health status, manager logs, and the exact action that failed. Do not paste a full application backup or database into a support request.

## Route by symptom

| Symptom | Guide |
| --- | --- |
| Page does not open or container exits | [Startup and loading](startup.md) |
| Model is missing, stuck loading, or out of memory | [Models and memory](models.md) |
| A tool is unavailable or a run stopped | [Tools and stopped runs](tools.md) |
| An update or restore failed | [Back up before an update](../tutorials/backup-update.md) |
| Need to check the deployment boundary | [Trust and data boundaries](../reference/security.md) |

## Before retrying

Check whether the action already completed. A timeout can occur after an external action succeeds. Look at the chat's last tool result, task status, external service, or changed file before retrying. Repeating an email, upload, payment, or database change can create a duplicate.

## Clipboard copy fails or paste is empty

If Novum shows **Could not copy**, neither the browser clipboard API nor its
legacy fallback reported success. Select the text and copy it manually, or
check the browser's clipboard permission for this site and retry. Clipboard
access is restricted in some insecure HTTP contexts; on an HTTP or IP-address
deployment, the legacy fallback may also be blocked. Use HTTPS or localhost
where appropriate.

**Copied** and the copy-button check mark mean a browser copy method reported
success. They cannot guarantee that the operating system made the text
available to another app, so try pasting before relying on the result.

Source: [clipboard result handling](https://github.com/nerdrx/novum-xenium/blob/edca488cb3b7213891d72827eeb71a9c12fda001/static/js/ui.js#L252).

If the issue remains, report Novum version, deployment method, platform, exact expected/actual behavior, the smallest relevant error excerpt, and steps to reproduce. Do not include secrets or personal chat content.
