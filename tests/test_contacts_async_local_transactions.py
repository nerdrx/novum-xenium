"""Focused regressions for contacts route responsiveness and local JSON RMW."""
import asyncio
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress
from pathlib import Path
from types import SimpleNamespace

import httpx
from fastapi import FastAPI

import routes.contacts.contacts_routes as contacts


def _app():
    app = FastAPI()
    app.state.auth_manager = SimpleNamespace(is_configured=True, is_admin=lambda user: user == "fixture-admin")

    @app.middleware("http")
    async def fixture_identity(request, call_next):
        request.state.current_user = "fixture-admin"
        return await call_next(request)

    app.include_router(contacts.setup_contacts_routes())
    return app


def test_blocking_contacts_route_helpers_run_off_event_loop(monkeypatch):
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=_app()), base_url="http://fixture") as client:
            cases = [
                ("add_fetch", "POST", "/api/contacts/add", {"name": "Fixture"}, "_fetch_contacts", []),
                ("add_create", "POST", "/api/contacts/add", {"name": "Fixture"}, "_create_contact", True),
                ("import_vcf", "POST", "/api/contacts/import", {"vcf": "BEGIN:VCARD\nVERSION:4.0\nFN:Fixture\nEND:VCARD"}, "_import_vcards", {"imported": 1, "failed": 0, "total": 1}),
                ("import_csv", "POST", "/api/contacts/import", {"csv": "name,email\nFixture,fixture@example.invalid\n"}, "_import_csv_contacts", {"imported": 1, "failed": 0, "total": 1}),
                ("update", "PUT", "/api/contacts/fixture-uid", {"name": "Fixture"}, "_update_contact", True),
                ("delete", "DELETE", "/api/contacts/fixture-uid", None, "_delete_contact", True),
                ("clear", "DELETE", "/api/contacts/clear", None, "_clear_local_contacts", None),
            ]
            loop = asyncio.get_running_loop()
            for name, method, path, payload, target, result in cases:
                entered, release, heartbeat = threading.Event(), threading.Event(), threading.Event()

                def gated(*args, _result=result, **kwargs):
                    entered.set()
                    if not release.wait(5):
                        raise AssertionError(f"{name}: gate was not released")
                    return _result

                with monkeypatch.context() as m:
                    if name == "add_create":
                        m.setattr(contacts, "_fetch_contacts", lambda *a, **k: [])
                    elif name == "add_fetch":
                        m.setattr(contacts, "_create_contact", lambda *a, **k: True)
                    m.setattr(contacts, target, gated)
                    outcome = {}

                    def controller():
                        outcome["entered"] = entered.wait(3)
                        if outcome["entered"]:
                            loop.call_soon_threadsafe(heartbeat.set)
                            outcome["progressed_while_held"] = heartbeat.wait(0.5)
                        else:
                            outcome["progressed_while_held"] = False
                        release.set()

                    thread = threading.Thread(target=controller, daemon=True)
                    thread.start()
                    try:
                        response = await client.request(method, path, json=payload)
                        thread.join(2)
                        assert not thread.is_alive(), f"{name}: controller did not finish"
                        assert outcome == {"entered": True, "progressed_while_held": True}, (name, outcome)
                        assert response.status_code == 200, (name, response.status_code, response.text)
                    finally:
                        release.set()
                        thread.join(2)

    asyncio.run(run())


def test_local_contact_mutations_share_transaction_and_preserve_semantics(tmp_path, monkeypatch):
    monkeypatch.setattr(contacts, "LOCAL_CONTACTS_FILE", tmp_path / "contacts.json")
    monkeypatch.setattr(contacts, "DATA_DIR", tmp_path)
    monkeypatch.setattr(contacts, "_get_carddav_config", lambda: {"url": "", "username": "", "password": ""})
    monkeypatch.setattr(contacts, "_contact_cache", {"contacts": [], "by_owner": {}, "fetched_at": None, "failed_at": None})
    contacts.LOCAL_CONTACTS_FILE.write_text(json.dumps({"contacts": []}), encoding="utf-8")

    started = threading.Barrier(2)
    both_attempted = threading.Event()
    original_load = contacts._load_local_contacts
    active_lock = threading.Lock()
    active = 0
    max_active = 0
    attempt_count = 0
    overlapping_load = threading.Event()
    overlap_during_first = []

    def observed_load(owner=None):
        nonlocal active, max_active
        with active_lock:
            first_loader = active == 0
            active += 1
            max_active = max(max_active, active)
            if not first_loader:
                overlapping_load.set()
        try:
            if first_loader:
                assert both_attempted.wait(3)
                overlap_during_first.append(overlapping_load.wait(0.25))
            return original_load(owner)
        finally:
            with active_lock:
                active -= 1

    monkeypatch.setattr(contacts, "_load_local_contacts", observed_load)

    def create(name, email):
        nonlocal attempt_count
        started.wait(timeout=3)
        with active_lock:
            attempt_count += 1
            if attempt_count == 2:
                both_attempted.set()
        return contacts._create_contact(name, email)

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(create, "One", "one@example.invalid")
        second = pool.submit(create, "Two", "two@example.invalid")
        results = [first.result(), second.result()]
    assert results == [True, True]
    rows = json.loads(contacts.LOCAL_CONTACTS_FILE.read_text(encoding="utf-8"))["contacts"]
    assert {row["name"] for row in rows} == {"One", "Two"}
    assert max_active == 1
    assert len(overlap_during_first) == 2 and not any(overlap_during_first)

    assert contacts._update_contact(rows[0]["uid"], "Updated", rows[0]["emails"], [], "", owner=None)
    updated = next(row for row in contacts._load_local_contacts() if row["uid"] == rows[0]["uid"])
    assert updated["name"] == "Updated"

    vcf = "BEGIN:VCARD\nVERSION:4.0\nFN:Imported\nEMAIL:imported@example.invalid\nEND:VCARD"
    result = contacts._import_vcards(vcf)
    assert result == {"imported": 1, "failed": 0, "total": 1}
    csv_result = contacts._import_csv_contacts("name,email\nCSV, csv@example.invalid\n")
    assert csv_result["imported"] == 1
    assert any(row["name"] == "CSV" for row in contacts._load_local_contacts())

    owner_rows = [
        {"uid": "owner-a", "name": "A", "emails": [], "phones": [], "address": "A street", "owner": "sft_a"},
        {"uid": "owner-b", "name": "B", "emails": [], "phones": [], "address": "B street", "owner": "sft_b"},
        {"uid": "shared", "name": "Shared", "emails": [], "phones": [], "address": "", "owner": ""},
    ]
    contacts._save_local_contacts(owner_rows)
    assert contacts._update_contact("owner-a", "A2", [], [], "", owner="sft_a")
    assert next(r for r in contacts._load_local_contacts() if r["uid"] == "owner-a")["address"] == "A street"
    assert contacts._delete_contact("owner-a", owner="sft_a")
    assert contacts._clear_local_contacts("sft_b") is None
    remaining = contacts._load_local_contacts()
    assert {r["uid"] for r in remaining} == {"shared"}


def test_cancelled_route_wait_does_not_release_worker_transaction(tmp_path, monkeypatch):
    monkeypatch.setattr(contacts, "LOCAL_CONTACTS_FILE", tmp_path / "contacts.json")
    monkeypatch.setattr(contacts, "DATA_DIR", tmp_path)
    monkeypatch.setattr(contacts, "_get_carddav_config", lambda: {"url": "", "username": "", "password": ""})
    monkeypatch.setattr(contacts, "_contact_cache", {"contacts": [], "by_owner": {}, "fetched_at": None, "failed_at": None})
    contacts.LOCAL_CONTACTS_FILE.write_text(json.dumps({"contacts": []}), encoding="utf-8")
    original_load = contacts._load_local_contacts
    first_entered, release_first = threading.Event(), threading.Event()
    second_entered, first_finished = threading.Event(), threading.Event()
    call_lock = threading.Lock()
    calls = 0

    def gated_load(owner=None):
        nonlocal calls
        with call_lock:
            calls += 1
            current = calls
        if current == 1:
            first_entered.set()
            try:
                if not release_first.wait(4):
                    raise AssertionError("first worker gate timed out")
            finally:
                first_finished.set()
        else:
            second_entered.set()
        return original_load(owner)

    monkeypatch.setattr(contacts, "_load_local_contacts", gated_load)

    async def run():
        first = asyncio.create_task(asyncio.to_thread(contacts._create_contact, "First", "first@example.invalid"))
        assert await asyncio.to_thread(first_entered.wait, 3)
        first.cancel()
        with suppress(asyncio.CancelledError):
            await first

        second_attempted = threading.Event()

        async def second_create():
            second_attempted.set()
            return await asyncio.to_thread(contacts._create_contact, "Second", "second@example.invalid")

        second = asyncio.create_task(second_create())
        assert await asyncio.to_thread(second_attempted.wait, 3)
        assert not await asyncio.to_thread(second_entered.wait, 0.25)
        release_first.set()
        assert await second is True
        assert await asyncio.to_thread(first_finished.wait, 3)

    try:
        asyncio.run(run())
    finally:
        release_first.set()
    rows = json.loads(contacts.LOCAL_CONTACTS_FILE.read_text(encoding="utf-8"))["contacts"]
    assert {row["name"] for row in rows} == {"First", "Second"}
