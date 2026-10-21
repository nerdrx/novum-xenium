"""Ensure CalDAV URL DNS validation does not block calendar request handling."""
import asyncio
import importlib
import json
import socket
import sys
import threading
import types
from contextlib import ExitStack

from fastapi import FastAPI

ROUTE = importlib.import_module("routes.calendar_routes")
CALDAV = importlib.import_module("src.caldav_sync")
REAL_HTTPX = importlib.import_module("httpx")

HOST = "caldav-proof.example.test"
URL = f"https://{HOST}/dav"
OWNER = "calendar-validation-test-owner"


class FakeAsyncClient:
    def __init__(self, **kwargs):
        self.kwargs = kwargs

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    async def request(self, *args, **kwargs):
        return types.SimpleNamespace(status_code=207, headers={})


def make_gated_resolver(loop, on_gate=None):
    entered = threading.Event()
    release = threading.Event()
    heartbeat_ran = threading.Event()
    observation = {"host": None, "heartbeat_ran_before_release": None, "heartbeat_ran_inside_resolver": None}

    def getaddrinfo(host, *args, **kwargs):
        observation["host"] = host
        entered.set()
        if not release.wait(3):
            raise RuntimeError("proof resolver gate was not released")
        observation["heartbeat_ran_inside_resolver"] = heartbeat_ran.is_set()
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]

    def controller():
        if not entered.wait(3):
            observation["controller_error"] = "resolver was not entered"
            release.set()
            return
        loop.call_soon_threadsafe(heartbeat_ran.set)
        if on_gate:
            on_gate()
        # Bounded event wait is only a deadlock guard. No sleep-based probe.
        observation["heartbeat_ran_before_release"] = heartbeat_ran.wait(0.25)
        release.set()

    return getaddrinfo, entered, release, heartbeat_ran, observation, controller


async def run_route_case(path, state=None, on_gate=None, expected_status=200):
    app = FastAPI()
    with ExitStack() as stack:
        stack.enter_context(importlib.import_module("unittest.mock").patch.object(ROUTE, "_require_user", return_value=OWNER))
        app.include_router(ROUTE.setup_calendar_routes())

        if path.endswith("/test"):
            fake_httpx = types.ModuleType("httpx")
            fake_httpx.AsyncClient = FakeAsyncClient
            fake_httpx.DigestAuth = lambda *args, **kwargs: object()
            stack.enter_context(importlib.import_module("unittest.mock").patch.dict(sys.modules, {"httpx": fake_httpx}))
        elif path.endswith("/sync"):
            stack.enter_context(importlib.import_module("unittest.mock").patch.object(
                CALDAV, "_load_caldav_accounts", return_value=[{
                    "id": "fixture-account", "label": "fixture", "url": URL,
                    "username": "fixture-user", "password": "fixture-password",
                }],
            ))
            secret_storage = importlib.import_module("src.secret_storage")
            stack.enter_context(importlib.import_module("unittest.mock").patch.object(secret_storage, "decrypt", side_effect=lambda value: value))
            worker_calls = []
            stack.enter_context(importlib.import_module("unittest.mock").patch.object(
                CALDAV, "_sync_blocking",
                side_effect=lambda owner, url, username, password, account_id="": (
                    worker_calls.append((owner, url, account_id)) or
                    {"calendars": 1, "events": 0, "deleted": 0, "errors": []}
                ),
            ))
        else:
            state = state if state is not None else []
            mock = importlib.import_module("unittest.mock")
            mock_get = lambda owner: [dict(item) for item in state]
            def save(owner, accounts):
                state[:] = [dict(item) for item in accounts]
            stack.enter_context(mock.patch.object(CALDAV, "_load_caldav_accounts", side_effect=mock_get))
            prefs_routes = importlib.import_module("routes.prefs_routes")
            stack.enter_context(mock.patch.object(prefs_routes, "_load_for_user", side_effect=lambda owner: {}))
            stack.enter_context(mock.patch.object(prefs_routes, "_save_for_user", side_effect=lambda owner, prefs: save(owner, prefs["caldav_accounts"])))
            secret_storage = importlib.import_module("src.secret_storage")
            stack.enter_context(mock.patch.object(secret_storage, "encrypt", side_effect=lambda value: f"enc:{value}"))

        getaddrinfo, entered, release, heartbeat_ran, observation, controller = make_gated_resolver(asyncio.get_running_loop(), on_gate)
        stack.enter_context(importlib.import_module("unittest.mock").patch.object(socket, "getaddrinfo", side_effect=getaddrinfo))
        thread = threading.Thread(target=controller, name="caldav-heartbeat-controller", daemon=True)
        thread.start()
        transport = REAL_HTTPX.ASGITransport(app=app)
        async with REAL_HTTPX.AsyncClient(transport=transport, base_url="http://asgi-proof.invalid") as client:
            if path.endswith("/test"):
                response = await client.post(path, json={"url": URL, "username": "u", "password": "p"})
            elif path.endswith("/sync"):
                response = await client.post(path)
            elif path == "/api/calendar/config":
                response = await client.post(path, json={"url": URL, "username": "updated"})
            elif path == "/api/calendar/config/accounts":
                response = await client.post(path, json={"url": URL, "username": "new", "password": "new-secret"})
            else:
                response = await client.put(path, json={"url": URL, "label": "updated"})
        thread.join(timeout=3)
        if thread.is_alive():
            release.set()
            raise AssertionError("heartbeat controller did not finish")
        if not heartbeat_ran.is_set():
            await asyncio.wait_for(asyncio.to_thread(heartbeat_ran.wait), timeout=3)
        assert "controller_error" not in observation, observation
        assert observation["host"] == HOST, observation
        assert observation["heartbeat_ran_before_release"] is True, observation
        assert observation["heartbeat_ran_inside_resolver"] is True, observation
        assert response.status_code == expected_status, response.text
        if expected_status == 404:
            assert response.json() == {"detail": "Account not found"}, response.text
            assert state == [], state
            return {"path": path, "status": response.status_code, **observation}
        if path.endswith("/test"):
            assert response.json() == {"ok": True}, response.text
        elif path.endswith("/sync"):
            assert response.json() == {"calendars": 1, "events": 0, "deleted": 0, "errors": []}, response.text
            assert worker_calls == [(OWNER, URL, "fixture-account")], worker_calls
        elif path == "/api/calendar/config":
            assert state[0]["password"] == "concurrent-secret", state
            assert len(state) == 2 and state[1]["id"] == "sibling", state
        elif path == "/api/calendar/config/accounts":
            assert len(state) == 3 and state[1]["id"] == "concurrent", state
        else:
            assert state[0]["password"] == "concurrent-secret", state
            assert state[0]["label"] == "updated", state
            assert state[1]["label"] == "concurrent-sibling", state
        return {"path": path, "status": response.status_code, **observation, "heartbeat_after_route": heartbeat_ran.is_set()}


async def run_positive_control():
    loop = asyncio.get_running_loop()
    getaddrinfo, entered, release, heartbeat_ran, observation, controller = make_gated_resolver(loop)
    from unittest.mock import patch
    with patch.object(socket, "getaddrinfo", side_effect=getaddrinfo):
        thread = threading.Thread(target=controller, name="caldav-positive-control", daemon=True)
        thread.start()
        validated = await asyncio.to_thread(CALDAV.validate_caldav_url, URL)
        thread.join(timeout=3)
        if thread.is_alive():
            release.set()
            raise AssertionError("positive control controller did not finish")
        assert validated == URL, validated
        assert observation["host"] == HOST, observation
        assert observation["heartbeat_ran_before_release"] is True, observation
        assert observation["heartbeat_ran_inside_resolver"] is True, observation
        return {"control": "same validator offloaded with asyncio.to_thread", **observation, "validated_url": validated}


async def main():
    config_state = [{"id": "first", "url": "https://old.example.test/dav", "username": "old", "password": "old-secret"}]
    def update_config_concurrently():
        config_state[0]["password"] = "concurrent-secret"
        config_state.append({"id": "sibling", "url": "https://sibling.example.test/dav", "username": "s", "password": "sibling-secret"})

    add_state = [{"id": "existing", "url": "https://old.example.test/dav", "username": "u", "password": "secret"}]
    def add_concurrently():
        add_state.append({"id": "concurrent", "url": "https://other.example.test/dav", "username": "v", "password": "keep"})

    update_state = [
        {"id": "fixture-account", "label": "before", "url": "https://old.example.test/dav", "username": "u", "password": "old-secret"},
        {"id": "sibling", "label": "before-sibling", "url": "https://sibling.example.test/dav", "username": "s", "password": "sibling-secret"},
    ]
    def update_concurrently():
        update_state[0]["password"] = "concurrent-secret"
        update_state[1]["label"] = "concurrent-sibling"

    removed_state = [
        {"id": "fixture-account", "label": "before", "url": "https://old.example.test/dav", "username": "u", "password": "secret"},
    ]
    def remove_concurrently():
        removed_state.clear()

    results = [
        await run_route_case("/api/calendar/test"),
        await run_route_case("/api/calendar/sync"),
        await run_route_case("/api/calendar/config", config_state, update_config_concurrently),
        await run_route_case("/api/calendar/config/accounts", add_state, add_concurrently),
        await run_route_case("/api/calendar/config/accounts/fixture-account", update_state, update_concurrently),
        await run_route_case("/api/calendar/config/accounts/fixture-account", removed_state, remove_concurrently, expected_status=404),
        await run_positive_control(),
    ]
    return results


def test_async_caldav_validation_and_account_revalidation():
    asyncio.run(main())


if __name__ == "__main__":
    print(json.dumps({"results": asyncio.run(main())}, sort_keys=True))
