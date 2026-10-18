"""The document library's synchronous ORM work must not block ASGI requests."""
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

import routes.document.document_routes as document_routes


class _BlockingQuery:
    def __init__(self, entered, release):
        self.entered = entered
        self.release = release

    def outerjoin(self, *args):
        return self

    def filter(self, *args):
        return self

    def group_by(self, *args):
        return self

    def order_by(self, *args):
        return self

    def offset(self, *args):
        return self

    def limit(self, *args):
        return self

    def all(self):
        self.entered.set()
        if not self.release.wait(3):
            raise TimeoutError("fake database query was not released")
        return []

    def scalar(self):
        return 0

    def count(self):
        return 0


class _BlockingSession:
    def __init__(self, entered, release):
        self.query_result = _BlockingQuery(entered, release)

    def query(self, *args):
        return self.query_result

    def close(self):
        pass


def test_library_blocking_orm_runs_off_asgi_event_loop(monkeypatch):
    entered = Event()
    release = Event()
    monkeypatch.setattr(document_routes, "get_current_user", lambda request: "alice")
    monkeypatch.setattr(document_routes, "SessionLocal", lambda: _BlockingSession(entered, release))

    app = FastAPI()
    app.include_router(document_routes.setup_document_routes(SimpleNamespace(), None))

    @app.get("/heartbeat")
    async def heartbeat():
        return {"ok": True}

    try:
        with TestClient(app) as client, ThreadPoolExecutor(max_workers=2) as pool:
            library = pool.submit(client.get, "/api/documents/library")
            assert entered.wait(2), "library request did not reach its fake ORM call"
            heartbeat = pool.submit(client.get, "/heartbeat")
            response = heartbeat.result(timeout=1)
            assert response.status_code == 200
            assert response.json() == {"ok": True}
            release.set()
            library_response = library.result(timeout=2)
            assert library_response.status_code == 200
            assert library_response.json()["documents"] == []
    finally:
        release.set()
