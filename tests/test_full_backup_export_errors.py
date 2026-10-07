"""Expected export failures give the administrator an actionable JSON response."""

import errno
import sqlite3

import pytest

import src.full_backup as full_backup
from tests.test_full_backup import backup_client


@pytest.mark.parametrize("error,status,guidance", [
    (ValueError("Backup has too many entries"), 400, "too many entries"),
    (OSError(errno.ENOTSUP, "private-source-path"), 503, "Linux Docker"),
    (OSError(errno.ELOOP, "private-source-path"), 409, "file moves"),
    (OSError(errno.ENOSPC, "private-source-path"), 500, "free disk space"),
    (sqlite3.OperationalError("private-source-path"), 409, "database health"),
])
def test_full_export_reports_expected_failures(backup_client, monkeypatch, error, status, guidance):
    client, _ = backup_client

    def fail(_):
        raise error

    monkeypatch.setattr(full_backup, "create_backup", fail)
    response = client.get("/api/backup/full", headers={"x-test-user": "admin"})
    assert response.status_code == status
    assert guidance in response.json()["detail"]
    assert "private-source-path" not in response.text
