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

If the issue remains, report Novum version, deployment method, platform, exact expected/actual behavior, the smallest relevant error excerpt, and steps to reproduce. Do not include secrets or personal chat content.
