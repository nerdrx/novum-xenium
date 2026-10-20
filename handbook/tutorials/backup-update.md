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

## Rollback

If an update fails, capture the error and current logs first. If the manager shows a **Recovery** action, review its target checkout and backup path before using it. Otherwise, stop the backend and follow the documented manual recovery procedure for that deployment. Restore from a known-good backup only after confirming the target checkout and data location. Restore replaces data and can lose changes made after the backup. Never restore over active writers.

The backup/restore tools and coverage depend on platform file APIs. See the [desktop manager guide](../desktop.md) and the source [desktop operations notes](https://github.com/nerdrx/novum-xenium/blob/main/docs/desktop.md).
