"""Explicit, read-only data grants for sandboxed module panels."""
import asyncio
import os
import sqlite3
import subprocess
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request

from src.auth_helpers import require_user, storage_owner_for_request
from src.constants import AGENT_WORKSPACE_DIR, DATA_DIR
from src.tool_security import owner_is_admin_or_single_user


async def _existing_api(request, path):
    # Reuse the existing route's ownership and admin checks. No panel URL is accepted.
    headers = {key: request.headers[key] for key in ('cookie', 'authorization') if key in request.headers}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=request.app),
                                 base_url='http://module.internal', headers=headers) as client:
        response = await client.get(path)
    if response.status_code != 200:
        raise HTTPException(response.status_code, 'This data is unavailable for your account. Open the corresponding workspace tool for details.')
    return response.json()


def _items(data, key):
    values = data.get(key, []) if isinstance(data, dict) else data
    if isinstance(values, dict):
        values = list(values.values())
    return [item for item in values if isinstance(item, dict)][:50] if isinstance(values, list) else []


def _git_snapshot(workspace):
    from src.tool_execution import vet_workspace
    root = vet_workspace(workspace or AGENT_WORKSPACE_DIR)
    if not root:
        raise HTTPException(400, 'Choose an allowed workspace folder.')
    try:
        result = subprocess.run(['git', '-c', 'core.fsmonitor=false', '--no-optional-locks', '-C', root,
                                 'status', '--porcelain=v1', '-b', '-uno'],
                                capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        raise HTTPException(503, 'Git status could not finish. Check the workspace folder.') from None
    if result.returncode:
        raise HTTPException(400, 'This workspace is not a Git repository.')
    lines = result.stdout.splitlines()
    return {'title': 'Git desk', 'summary': {'Workspace': root, 'Branch': lines[0][3:] if lines else 'Unknown',
                                           'Tracked changes': len(lines[1:])},
            'items': [{'title': line[3:], 'status': line[:2], 'detail': 'Tracked working-tree change'} for line in lines[1:51]],
            'notice': 'Read-only snapshot. Untracked files are omitted. Open your Git client to commit or manage pull requests.'}


def _runs(owner):
    database = Path(DATA_DIR) / 'agent_runs.db'
    if not database.exists():
        return []
    with sqlite3.connect(f'file:{database}?mode=ro', uri=True, timeout=2) as connection:
        rows = connection.execute('SELECT run_id,session_id,status,updated FROM agent_run_checkpoints '
                                  'WHERE owner=? ORDER BY updated DESC LIMIT 50', (str(owner or ''),)).fetchall()
    return [{'title': f'Run {row[0][:12]}', 'detail': f'Chat {row[1]}', 'status': row[2]} for row in rows]


def setup_module_data_routes(store):
    router = APIRouter()

    @router.get('/{module_id}/data/{capability}')
    async def module_data(module_id: str, capability: str, request: Request,
                          workspace: str = '', user: str = Depends(require_user)):
        module = store.get(module_id)
        if not module or not module.get('enabled'):
            raise HTTPException(404, 'Module is disabled or missing.')
        if capability not in module.get('permissions', []):
            raise HTTPException(403, 'Module has no permission for this data.')
        if capability == 'git':
            if not owner_is_admin_or_single_user(user):
                raise HTTPException(403, 'Workspace Git status is admin-only.')
            return await asyncio.to_thread(_git_snapshot, workspace)
        if capability == 'runs':
            items = await asyncio.to_thread(_runs, storage_owner_for_request(request))
            return {'title': 'Run inbox', 'summary': {'Recent runs': len(items),
                    'Running': sum(item['status'] == 'running' for item in items)}, 'items': items,
                    'notice': 'Recent durable agent checkpoints. Open the chat to review approvals or continue interrupted work.'}
        if capability == 'images':
            data = await _existing_api(request, '/api/gallery/library?limit=50')
            items = [{'title': item.get('name') or item.get('prompt') or 'Image',
                      'detail': item.get('model') or '', 'status': 'Favorite' if item.get('favorite') else ''}
                     for item in _items(data, 'items')]
            return {'title': 'Image studio', 'summary': {'Recent images': len(items)}, 'items': items,
                    'notice': 'Open Gallery to view, edit and export images. Generate images through your chat image model or agent tools.'}
        if capability == 'research':
            data = await _existing_api(request, '/api/research/library?limit=50')
            items = [{'title': item.get('query') or 'Research', 'status': item.get('status', ''),
                      'detail': f"{item.get('source_count', 0)} sources · {item.get('duration') or 'Duration unavailable'}"}
                     for item in _items(data, 'research')]
            return {'title': 'Research shelf', 'summary': {'Reports': data.get('total', len(items))}, 'items': items,
                    'notice': 'Your saved research reports. Open Research for sources, citations and new investigations.'}
        if capability == 'downloads':
            data = await _existing_api(request, '/api/cookbook/state')
            items = [{'title': item.get('name') or item.get('model') or item.get('id') or 'Download',
                      'detail': str(item.get('progress') or item.get('phase') or ''), 'status': str(item.get('status') or 'Unknown')}
                     for item in _items(data, 'tasks') if item.get('type') == 'download']
            return {'title': 'Downloads watch', 'summary': {'Model downloads': len(items)}, 'items': items,
                    'notice': 'Model downloads tracked by Cookbook. Desktop browser downloads and background completion alerts are not exposed by this module API.'}
        if capability == 'models':
            data = await _existing_api(request, '/api/models')
            items = []
            for endpoint in _items(data, 'items'):
                for model in endpoint.get('models', []):
                    if isinstance(model, str):
                        items.append({'title': model, 'detail': endpoint.get('endpoint_name') or endpoint.get('host') or '',
                                      'status': 'Available'})
            items = items[:200]
            summary = {'Available models': len(items)}
            notice = 'Available models are not necessarily loaded. Runtime memory and unload controls depend on the provider.'
            if owner_is_admin_or_single_user(user):
                base = os.environ.get('OLLAMA_BASE_URL', 'http://127.0.0.1:11434/v1').rstrip('/')
                if base.endswith('/v1'):
                    base = base[:-3]
                try:
                    async with httpx.AsyncClient(timeout=4, follow_redirects=False, trust_env=False) as client:
                        response = await client.get(base + '/api/ps')
                        response.raise_for_status()
                        loaded = response.json().get('models', [])
                    summary['Loaded in Ollama'] = len(loaded)
                    summary['Ollama VRAM'] = f"{sum(int(model.get('size_vram') or 0) for model in loaded) / (1024 ** 3):.2f} GiB"
                    names = {model.get('name') for model in loaded}
                    for item in items:
                        if item['title'] in names:
                            item['status'] = 'Loaded in Ollama'
                except (httpx.HTTPError, ValueError, TypeError):
                    notice += ' Ollama runtime status is currently unavailable.'
            return {'title': 'Model monitor', 'summary': summary, 'items': items, 'notice': notice}
        raise HTTPException(404, 'Unknown module data capability.')

    return router
