"""Interrupted backup uploads must not leave private partial archives behind."""
import asyncio
import tempfile

import pytest

from routes import backup_routes


@pytest.mark.asyncio
async def test_cancelled_backup_upload_removes_partial_archive(tmp_path, monkeypatch):
    original = tempfile.NamedTemporaryFile
    monkeypatch.setattr(backup_routes.tempfile, "NamedTemporaryFile",
                        lambda **kwargs: original(dir=tmp_path, **kwargs))
    started = asyncio.Event()
    release = asyncio.Event()

    class Upload:
        headers = {"content-type": "application/zip"}

        async def stream(self):
            yield b"private partial backup"
            started.set()
            await release.wait()

    task = asyncio.create_task(backup_routes._save_upload(Upload(), 1024))
    try:
        await asyncio.wait_for(started.wait(), 2)
        assert len(list(tmp_path.glob("odysseus-restore-upload-*.zip"))) == 1
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert list(tmp_path.iterdir()) == []
    finally:
        release.set()
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_completed_backup_upload_remains_for_caller(tmp_path, monkeypatch):
    original = tempfile.NamedTemporaryFile
    monkeypatch.setattr(backup_routes.tempfile, "NamedTemporaryFile",
                        lambda **kwargs: original(dir=tmp_path, **kwargs))

    class Upload:
        headers = {"content-type": "application/zip"}

        async def stream(self):
            yield b"complete backup"

    path = await backup_routes._save_upload(Upload(), 1024)
    assert path.parent == tmp_path
    assert path.read_bytes() == b"complete backup"
    path.unlink()
