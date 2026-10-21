# Tutorial: back up before an update

Backups contain private application data and may include provider credentials, chats, and documents. Store them on storage you control. Keep the application running normally unless the manager's backup flow tells you to stop it.

## Use the desktop manager

1. Open the manager for the correct Compose checkout.
2. Confirm the backend identity and checkout shown in the manager.
3. Use its backup action and wait for the completion result.
4. Confirm the backup file exists at the chosen destination and record its date.
5. Only then review and apply the container update.

The manager's update process prepares a backup before changing persistent state. If the backup fails, do not proceed with the update. Review the displayed error and logs; preserve the existing data while diagnosing it.

## Compose users

The standard application data is under `data/`. For a manual backup, stop the Compose services cleanly and copy the application data directory to a private destination, then restart. Example from the repository directory:

```sh
docker compose stop
tar -czf novum-data-backup.tar.gz data
docker compose start
```

The archive may contain credentials and personal content; protect it accordingly. This file copy covers the standard local `data/` directory only. It does not include Compose named volumes for ChromaDB, SearXNG, or ntfy, or files stored outside `data/`. Back those up separately if their contents matter. If you configured another `APP_DATA_DIR`, external database, or other storage, use that storage's backup procedure. Do not remove the original data as part of a backup.

## Full-backup ZIP in Settings

As an administrator, open **Settings → System → Data Backup**. **Export Data**
and **Import Data** use the JSON format described below. They do not
replace the full application-data ZIP.

1. Use **Download Full Backup**, wait for the download to finish, and verify
   the archive exists in your private destination. The ZIP includes eligible
   application data and a consistent SQLite snapshot; external Docker volumes,
   runtime caches, logs, and model downloads require separate backup plans.
2. Use **Preview Full Restore** to choose a ZIP. Preview validates and summarizes
   the archive without replacing live data. Check its date, file count,
   database coverage, and encryption-key information before proceeding.
3. Take a fresh backup of the current installation before using **Stage Restore
   and Require Restart**. Confirm the replacement only for the intended archive.
   Staging prepares a restore; it does not immediately replace the running data.
4. Plan a clean backend stop and start to activate the staged restore. This
   replaces eligible application data and can discard changes made after the
   archive was created. External Docker volumes and runtime caches remain in
   place; vector indexes may need rebuilding.

Only one restore can be pending. Previewing another ZIP does not replace an
already staged restore. If you see **A restore is already pending**, review
which restore you intend to activate before restarting; repeated staging is
not an overwrite mechanism. A newer preview remains separate from the result
of an earlier staging request.

See the pinned [restore controls](https://github.com/nerdrx/novum-xenium/blob/cfffb7ec2eee2ec56701e0b699450ef7c13e570c/static/js/admin.js) and [backup staging implementation](https://github.com/nerdrx/novum-xenium/blob/cfffb7ec2eee2ec56701e0b699450ef7c13e570c/src/full_backup.py).

## Import exported settings data

Admin's **Import Data** reads a JSON export; it is separate from restoring a full
application backup. Importing presets can replace the active custom persona.
A custom persona supplied as a list or text is rejected before preset settings
are replaced.
A failed preset write reports an error instead of a successful import. Earlier
sections of the file may already have been imported, so check their state before
retrying the whole file.

## Rollback

If an update fails, capture the error and current logs first. If the manager shows a **Recovery** action, review its target checkout and backup path before using it. Otherwise, stop the backend and follow the documented manual recovery procedure for that deployment. Restore from a known-good backup only after confirming the target checkout and data location. Restore replaces data and can lose changes made after the backup. Never restore over active writers.

The backup/restore tools and coverage depend on platform file APIs. See the [desktop manager guide](../desktop.md) and the source [desktop operations notes](https://github.com/nerdrx/novum-xenium/blob/main/docs/desktop.md).
