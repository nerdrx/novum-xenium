# Use Calendar

Calendar stores appointments in your Novum workspace. It can also pull and
write event changes through configured CalDAV accounts. Open **Calendar** from
the navigation rail or visit `/calendar`.

## Find a date and event

Use **Week**, **Month**, **Year**, or **Agenda** to change the view. **Today**
returns to the current date; the arrows move through dates in the grid views.
Select a day to open its event list. Week starts on Monday by default; change
it to Sunday in **Calendar settings**. The preference is saved in this browser.

Search is in the day details panel. Type part of an event title to filter the
loaded calendar events; searching selects today when no day is selected. The
calendar also has a quick-add field for natural-language event text. Review its
parsed details before saving, especially date, time, and timezone.

Use the filter chips to hide event categories or calendars temporarily. These
filters affect what the view shows; they do not delete events. In **Calendar
settings**, rename a calendar, change its color, create a local calendar, or
delete a calendar. Deleting a calendar also deletes its events and requires
confirmation.

## Create and edit events

Choose **New**, select a day, or select a time range in Week view. Enter a
title, date, and start/end times. Choose **All day** for a date-only event.
Open **Add details** to set a location, description, repeat rule, reminder,
tag, color, and calendar. The event form's calendar picker determines which
calendar receives the event; hidden calendars are omitted from the
picker. Click an event to edit it. Use its **Edit** or **Delete** menu for the
same actions.

The form offers daily, weekly, weekdays, monthly, and yearly recurrence.
Repeated events appear as occurrences in the selected date range. When
deleting a repeated event, choose **This event only** or **All recurring
events**. Recurrence expansion is capped at 1,000 results per series in a
response; long ranges can be marked truncated.

Timed events display in the browser's local timezone. Imported timed values
with timezone information are converted to UTC for storage and displayed in
the current local timezone. All-day events remain date-based. Calendar data
does not retain an arbitrary display timezone choice in the event form.

## Reminders are Notes

An event reminder creates a todo in **Notes**, with the `calendar` label and a
due time. The event remains a calendar event; the reminder is a separate note.
Choose at event time, 5, 10, 15, 30, or 60 minutes before, 2 hours before,
1 day before, or an exact time. Browser notifications depend on browser
support, permission, an open Novum session, and successful polling. Use Notes
to inspect the reminder record and due time. Delivery is not guaranteed.

## Connect and sync CalDAV

1. Open **Calendar settings** and choose **Settings → Integrations**.
2. Add a **CalDAV** account. Enter its label, server URL, username, and
   password. Use the server's CalDAV URL and credentials; providers differ in
   URL format and account authorization.
3. Choose **Test** before saving. A successful test checks that the
   server responds to a CalDAV request with the supplied credentials. It does
   not confirm that every calendar can be read or written.
4. Save the account, return to Calendar, then choose **Calendar settings →
   Sync now**. Review the result shown beside the sync control.

New or updated CalDAV account passwords are encrypted by the application;
legacy account settings may retain plaintext passwords until updated. Passwords
are not returned to the browser in account listings. Use HTTPS for remote
accounts. Novum validates CalDAV URLs and blocks unsafe destinations; private
IP addresses require the operator's explicit
`ODYSSEUS_ALLOW_PRIVATE_CALDAV=1` setting. Redirects are
not followed. Ask the administrator to check server URL, credentials,
network access, and the server certificate when the test fails.

Sync pulls remote calendars and events into local storage. Event edits on a
CalDAV calendar are saved locally first and pushed to the remote server on a
best-effort basis. If remote write fails, the local change remains and is
marked pending. **Sync now** performs a pull; it does not retry pending writes.
Retry requires the sync API's `push` or `both` direction. A displayed sync
error means some account or calendar operation failed; inspect the specific error before
repeating changes. If the browser is offline, remote test and sync cannot
complete. Previously cached events may still display, but cached data can be
stale and edits may not reach the remote server.

## Import and export ICS

In **Calendar settings**, choose **Import .ics** and select an `.ics`,
`.ical`, or `.calendar` file. Novum creates or reuses a local calendar named
from the filename and imports eligible events there. Import creates fresh
local event IDs. Re-importing into that target calendar can skip events with
the same start and summary. The server enforces an upload-size limit; invalid
files and failed imports show an error beside the import control.

Choose a calendar's name under **Export calendar** to download that calendar
as an `.ics` file. Export each calendar separately. An ICS export is a useful
portable copy, but it is not a full application backup. ICS import/export
covers event fields the current importer/exporter handles; do not assume every
property from another calendar product is preserved. Review an export in its
destination app before relying on it as a migration.

## Recovery and data boundaries

Calendar data is stored in the Novum application database. Use the deployment
[backup procedure](tutorials/backup-update.md) to back up the database and its associated application data.
You can also export each calendar as ICS for a portable event copy. Restoring
an application backup and importing ICS are separate recovery paths; ICS does
not restore account credentials, calendar colors, reminder notes, or all
provider metadata.

Calendar access follows the signed-in workspace owner. In authentication-off
single-user deployments, data uses the configured fallback owner. CalDAV is
one provider path; local calendars and ICS files work without a CalDAV
provider. Email, chat-model, and CalDAV credentials are configured separately.

## Troubleshoot

- **No calendars or an error state:** check the displayed error, workspace
  account, and server health. Create a local calendar if needed; repair CalDAV
  under **Settings → Integrations**.
- **Events appear missing:** check the selected date, view, hidden calendar
  filters, and category filters. Then use **Sync now** for remote calendars.
- **Event edit does not appear remotely:** check the CalDAV account and sync
  result. The local edit may have succeeded while remote write-back failed.
- **Import reports skipped events:** matching events may already exist in the
  selected import calendar. Check that calendar before importing again.
- **Reminder did not notify:** check the reminder todo and due time in Notes,
  browser notification permission, and whether a Novum session was open.

For account and route behavior, see the
[Calendar, Tasks, and Notes specification](https://github.com/nerdrx/novum-xenium/blob/3c6f54a7637d79b84598c98c4f46a5f806c1a62c/specs/calendar-tasks-notes.md).
The frozen [calendar interface](https://github.com/nerdrx/novum-xenium/blob/3c6f54a7637d79b84598c98c4f46a5f806c1a62c/static/js/calendar.js),
[CalDAV settings](https://github.com/nerdrx/novum-xenium/blob/3c6f54a7637d79b84598c98c4f46a5f806c1a62c/static/js/settings.js),
[calendar routes](https://github.com/nerdrx/novum-xenium/blob/3c6f54a7637d79b84598c98c4f46a5f806c1a62c/routes/calendar_routes.py),
[CalDAV sync](https://github.com/nerdrx/novum-xenium/blob/3c6f54a7637d79b84598c98c4f46a5f806c1a62c/src/caldav_sync.py),
and [reminder polling](https://github.com/nerdrx/novum-xenium/blob/3c6f54a7637d79b84598c98c4f46a5f806c1a62c/static/js/calendar/reminders.js)
show the behavior this guide describes.
