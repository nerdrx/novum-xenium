import io
import json
import sqlite3
import zipfile
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from routes import module_data_routes as data_routes
from src.auth_helpers import require_user
from src.module_store import ModuleStore, _read_package


def test_shipped_catalog_packages_validate(tmp_path):
    root = Path(__file__).parents[1] / 'modules'
    catalog = json.loads((root / 'index.json').read_text())
    ids = set()
    for entry in catalog['modules']:
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w') as archive:
            for filename in entry['files']:
                archive.writestr(filename, (root / entry['path'] / filename).read_bytes())
        manifest, _, _ = _read_package(output.getvalue())
        assert manifest['id'] not in ids
        ids.add(manifest['id'])
    assert len(ids) == 7


def test_real_api_shapes_and_owner_filtered_runs(tmp_path, monkeypatch):
    store = ModuleStore(tmp_path)
    package = io.BytesIO()
    with zipfile.ZipFile(package, 'w') as archive:
        archive.writestr('module.json', json.dumps({'api_version': 1, 'id': 'test-panel', 'name': 'Test',
            'version': '1.0.0', 'panel': 'panel.html', 'permissions': ['images', 'models', 'research', 'downloads', 'runs']}))
        archive.writestr('panel.html', '<h1>Test</h1>')
    store.install(package.getvalue())
    store.set_enabled('test-panel', True)
    monkeypatch.setattr(data_routes, 'DATA_DIR', str(tmp_path))
    monkeypatch.setattr(data_routes, 'storage_owner_for_request', lambda request: 'alice')
    monkeypatch.setattr(data_routes, 'owner_is_admin_or_single_user', lambda user: False)
    with sqlite3.connect(tmp_path / 'agent_runs.db') as db:
        db.execute('CREATE TABLE agent_run_checkpoints(run_id,session_id,status,updated,owner)')
        db.executemany('INSERT INTO agent_run_checkpoints VALUES(?,?,?,?,?)', [
            ('alice-run', 'alice-chat', 'running', 2, 'alice'),
            ('bob-secret', 'bob-chat', 'running', 3, 'bob')])
    app = FastAPI()
    app.dependency_overrides[require_user] = lambda: 'alice'
    app.include_router(data_routes.setup_module_data_routes(store), prefix='/api/modules')

    @app.get('/api/gallery/library')
    def gallery():
        return {'items': [{'prompt': 'My picture', 'model': 'image-model'}], 'total': 1}

    @app.get('/api/models')
    def models():
        return {'hosts': [], 'items': [{'endpoint_name': 'Local', 'models': ['model-a', 'model-b']}]}

    @app.get('/api/research/library')
    def research():
        return {'research': [{'query': 'A topic', 'source_count': 3, 'status': 'done'}], 'total': 1}

    @app.get('/api/cookbook/state')
    def downloads():
        return {'tasks': [{'type': 'download', 'name': 'Model file', 'status': 'running', 'progress': '45%'},
                          {'type': 'serve', 'name': 'Not a download'}]}

    client = TestClient(app)
    for capability, title in [('images', 'My picture'), ('models', 'model-a'),
                              ('research', 'A topic'), ('downloads', 'Model file'), ('runs', 'Run alice-run')]:
        response = client.get(f'/api/modules/test-panel/data/{capability}')
        assert response.status_code == 200, response.text
        assert response.json()['items'][0]['title'] == title
        assert 'bob-secret' not in response.text
    assert client.get('/api/modules/test-panel/data/git').status_code == 403
    store.set_enabled('test-panel', False)
    assert client.get('/api/modules/test-panel/data/images').status_code == 404
