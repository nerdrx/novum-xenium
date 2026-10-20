# Tasks and notifications

Tasks run prompts, research, and supported actions on schedules, app events, or
an authenticated webhook. Review the prompt, output, model, integrations,
permissions, and notification setting before creating one. A background task
can run while you are away.

## Create a scheduled task

1. Open **Tasks** from the left icon rail and select **Add Task**.
2. Choose **Prompt on schedule**, **Research on schedule**, or **Action on
   schedule**. For actions that can change external state, use only a task and
   account you trust; some action types are admin-only.
3. Give the task a clear name. Write a bounded prompt or research question.
   For Action, choose one of the actions offered by the app and review its
   required settings.
4. Under **Trigger**, choose **Schedule**. Set **Frequency** to **Daily**,
   **Weekly**, **Monthly**, **Once**, or **Cron**. Set the requested day/time
   or schedule expression and review its timezone before saving.
5. Review **Output**, **Run with model**, **Chain**, and **Notifications**.
   Empty **Run with model** uses the Utility default. Clear **Notifications**
   to silence completion alerts for routine jobs.
6. Select **Create**. The button stays disabled while the request is pending.
   If the response is lost, retry unchanged content in the same open form;
   Novum reuses the create request key for 24 hours. Editing content or
   closing/reloading the form creates a different request.

The task list shows status and next run. Expand a task card to read its latest
result and use **Run**, **Edit**, **Pause**, or **Resume**. Use **Run** for one
controlled manual run. If it is queued while Novum is busy, the task card can
show **Run anyway**; choose it only when running concurrently is safe.

## Event and webhook triggers

Choose **Prompt on event** or **Research on event** in the **Add Task** picker,
then set the event trigger and its threshold. Event triggers can run after
configured session/message counts; they are different from clock schedules.
Choose **Webhook triggered** only when you have a trusted caller and protected
webhook URL. Do not publish that URL. The webhook starts the task; it does not
make its external actions safe by itself.

## Check a run and recover

Open **Tasks → Activity** to review recent executions. Expand a task card and
select its last-run result to open full history. Statuses include queued,
running, success, error, skipped, and aborted. Read the error and check whether
an external action completed before retrying. A timeout or stopped response
does not undo an email, calendar write, shell command, or API call.

Use **Pause** to stop future scheduled firing without deleting task history;
use **Resume** to re-enable it. Use **Stop** to request cancellation of an
active run. Stop cancels owned process groups but cannot stop an independently
detached remote command or reverse completed side effects. Verify state before
another manual run.

## Email triage task

The task list can include the built-in `check_email_urgency` task. Its prompt,
schedule, and pause/resume state are managed on that task card. Configure
email accounts first, review the **Email triage rules**, and inspect the
resulting labels and notification settings. Agent-initiated email sends are
staged for review by default; do not disable that boundary to fix a failed
poller.

## Android alerts

The Android companion can receive incoming email, scheduled-task, and chat
completion/attention alerts through the authenticated Novum notification
feed. Enable **Notifications** in the companion and grant Android notification
permission. The app keeps a visible connection notification and polls about
once a minute when Android permits network access. Doze can delay polling;
force-stop, reboot, or process termination can stop alerts until reopened.
This is not a guaranteed real-time alarm, and the phone does not run a local
model. See [Android notifications](https://github.com/nerdrx/novum-xenium/blob/main/docs/push-notifications.md).

## Scheduler configuration

The standard Compose deployment runs the scheduled-task worker and email
pollers in-process. `ODYSSEUS_INPROCESS_TASKS=0` is for an intentionally
configured external task driver; `ODYSSEUS_INPROCESS_POLLERS=0` is for an
intentionally configured external email poller. Do not turn either off without
setting up its replacement, and do not run two workers against the same local
SQLite schedule. See [environment variables](reference/environment.md) and
the source [task workflow](https://github.com/nerdrx/novum-xenium/blob/main/docs/nx-workflows.md#scheduled-tasks).
