import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import tempfile
import subprocess
import sys
import threading
import time
import unittest
from contextlib import nullcontext, redirect_stdout
from unittest import mock


BRIDGE_PATH = Path(__file__).parents[1] / "src" / "zvram_bridge.py"
SPEC = importlib.util.spec_from_file_location("zvram_bridge_test", BRIDGE_PATH)
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


class ModelHelper:
    def build_server_command(self, model, alias, *, live_control=False, **kwargs):
        command = ["server", "--model", model, "--alias", alias]
        if not live_control:
            command.append("--no-live-control")
        return (command, {
            "ZVRAM_TYPED": "yes", "GGML_CACHE": "safe", "API_TOKEN": "never",
        })


class Manager:
    def __init__(self, home=None):
        self.home = Path(home or tempfile.mkdtemp())
        self.home.mkdir(parents=True, exist_ok=True)
        self.profiles_path = self.home / "profiles.json"
        self.starts = []
        self.stops = []
        self.seen_env = None

    def validate_name(self, name):
        return name

    def lock(self):
        return nullcontext()

    def job_path(self, name):
        return self.home / (name + ".job.json")

    def list_profiles(self):
        try:
            values = json.loads(self.profiles_path.read_text())
        except FileNotFoundError:
            return []
        return [dict(value, name=name, state="stopped") for name, value in values.items()]

    def start(self, name):
        self.starts.append(name)
        self.seen_env = dict(os.environ)
        return True

    def stop(self, name):
        self.stops.append(name)
        return True


class ModelHelpers(ModelHelper):
    def __init__(self, model):
        self.model = Path(model)
        self.registered = []
        self.projector = None

    def discover_models(self, checkout):
        try:
            size = self.model.stat().st_size
        except FileNotFoundError:
            return []
        row = {"name": "tiny", "path": str(self.model), "size": size}
        if self.projector is not None:
            row["mmproj_path"] = str(self.projector)
        return [row]

    def register_endpoint(self, alias, port, *, xenium):
        self.registered.append((alias, port, xenium))


class ManagerHelpers:
    RAM_GUARD_CAN_DISABLE = True

    def read_json(self, path, default):
        try:
            return json.loads(Path(path).read_text())
        except FileNotFoundError:
            return default

    def write_json(self, path, value):
        Path(path).write_text(json.dumps(value))

    def owned_worker(self, job):
        return bool(job.get("owned"))

    def memory_status(self):
        return {"available_mib": 1234}

    def gpu_status(self):
        return []


class BridgeTests(unittest.TestCase):
    def test_model_rows_discovers_configured_gguf_library(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            checkout = home / "checkout"
            checkout.mkdir()
            repo = home / "hub/models--owner--Dolphin/snapshots/revision"
            repo.mkdir(parents=True)
            target = home / "hub/blobs/model-blob"
            target.parent.mkdir(parents=True)
            target.write_bytes(self.text_gguf())
            model = repo / "Dolphin.F16.gguf"
            model.symlink_to(target)
            (repo / "ignore.gguf").write_bytes(b"not GGUF")
            (repo / "Projector.gguf").write_bytes(self.text_gguf('clip'))
            (repo / "Split-00002-of-00002.gguf").write_bytes(self.text_gguf())
            config = home / ".config/dev.novum.xenium/config.json"
            config.parent.mkdir(parents=True)
            config.write_text(json.dumps({"checkout": str(checkout), "model_roots": [str(repo.parent.parent)]}))

            class EmptyModels:
                def discover_models(self, _checkout):
                    return []

            with mock.patch.object(bridge.Path, "home", return_value=home):
                rows = bridge._model_rows(EmptyModels(), checkout)
            self.assertEqual(rows, [{"name": "owner/Dolphin:Dolphin.F16",
                                     "path": str(target.resolve()), "size": len(self.text_gguf())}])

    @staticmethod
    def text_gguf(architecture='llama'):
        import struct
        key = b'general.architecture'
        arch = architecture.encode()
        return b'GGUF' + struct.pack('<IQQQ', 3, 0, 1, len(key)) + key + struct.pack('<IQ', 8, len(arch)) + arch

    def test_diffusion_or_missing_architecture_is_not_a_text_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'model.gguf'
            for contents in (b'GGUFdata', self.text_gguf('clip'), self.text_gguf('sd1'),
                             self.text_gguf('flux'), self.text_gguf('flux2')):
                path.write_bytes(contents)
                self.assertFalse(bridge._text_gguf_architecture(path))
            path.write_bytes(self.text_gguf())
            self.assertTrue(bridge._text_gguf_architecture(path))

    def test_cached_gguf_discovery_maps_only_complete_local_model_files(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory) / 'hf'
            repo = cache / 'hub/models--org--demo/snapshots/revision'
            repo.mkdir(parents=True)
            blobs = cache / 'hub/models--org--demo/blobs'
            blobs.mkdir()
            model = repo / 'Demo-Q4_K_M.gguf'
            model_blob = blobs / 'demo-blob'
            model_blob.write_bytes(self.text_gguf())
            model.symlink_to(model_blob)
            split1 = repo / 'Split-00001-of-00002.gguf'
            split2 = repo / 'Split-00002-of-00002.gguf'
            split1_blob = blobs / 'split-1'
            split1_blob.write_bytes(self.text_gguf())
            split1.symlink_to(split1_blob)
            # Missing second part must keep this candidate out of the picker.
            rows = [{
                'repo_id': 'org/demo', 'path': '/app/.cache/huggingface/hub',
                'has_incomplete': False, 'is_gguf': True, 'is_diffusion': False,
                'is_video': False, 'is_adapter': False,
                'gguf_files': [
                    {'name': model.name, 'rel_path': f'revision/{model.name}', 'role': 'model'},
                    {'name': split1.name, 'rel_path': f'revision/{split1.name}',
                     'role': 'model', 'split': True, 'parts': 2},
                    {'name': 'mmproj-demo.gguf', 'rel_path': 'revision/mmproj-demo.gguf', 'role': 'projector'},
                ],
            }, {
                'repo_id': 'org/diffusion', 'path': '/app/.cache/huggingface/hub',
                'has_incomplete': False, 'is_gguf': True, 'is_diffusion': True,
                'gguf_files': [{'name': 'x.gguf', 'rel_path': 'revision/x.gguf', 'role': 'model'}],
            }, {
                'repo_id': 'org/incomplete', 'path': '/app/.cache/huggingface/hub',
                'has_incomplete': True, 'is_gguf': True, 'gguf_files': [],
            }, {
                'repo_id': 'org/escape', 'path': '/tmp/foreign',
                'has_incomplete': False, 'is_gguf': True,
                'gguf_files': [{'name': 'x.gguf', 'rel_path': 'revision/x.gguf', 'role': 'model'}],
            }]
            class CachedHelper:
                def session_cookie(self, _path):
                    return 'odysseus_session=test'
                def _request(self, url, cookie):
                    self.request = (url, cookie)
                    return {'models': rows}
            helper = CachedHelper()
            ready = bridge._ready_cached_gguf_rows(
                helper, Path(directory) / 'cookie', 8000, cache,
            )
            self.assertEqual([item['name'] for item in ready], ['org/demo:Demo-Q4_K_M'])
            self.assertEqual(ready[0]['path'], str(model_blob.resolve()))
            split2_blob = blobs / 'split-2'
            split2_blob.write_bytes(self.text_gguf())
            split2.symlink_to(split2_blob)
            ready = bridge._ready_cached_gguf_rows(
                helper, Path(directory) / 'cookie', 8000, cache,
            )
            self.assertEqual([item['name'] for item in ready], [
                'org/demo:Demo-Q4_K_M', 'org/demo:Split',
            ])
            self.assertEqual(ready[1]['path'], str(split1))
            bridge._router_preset_path(self.manager).write_text('[nx-model-0]\nalias = tiny\nmodel = /existing\n')
            bridge._append_router_preset(self.manager, [ready[1]], self.checkout)
            self.assertIn('model = ' + str(split1), bridge._router_preset_path(self.manager).read_text())
            self.assertEqual(helper.request, ('http://127.0.0.1:8000/api/model/cached', 'odysseus_session=test'))
            helper._request = lambda *_args: {'models': [], 'error': 'private scan detail'}
            with self.assertRaisesRegex(ValueError, 'scan is pending'):
                bridge._ready_cached_gguf_rows(
                    helper, Path(directory) / 'cookie', 8000, cache,
                )

    def test_router_preset_addition_preserves_bytes_and_ids_and_is_idempotent(self):
        self.start_router()
        preset = self.home / 'router-models.ini'
        with preset.open('ab') as stream:
            stream.write(b'\n[unrelated]\nalias = ignored\nmodel = /tmp/ignored\n'
                         b'\n[nx-model-4]\nalias = org/repo:kept\nmodel = /models/kept.gguf\n'
                         b'load-on-startup = false\n')
        before = preset.read_bytes()
        model = self.checkout / 'downloaded.gguf'
        model.write_bytes(self.text_gguf())
        count, added = bridge._append_router_preset(self.manager, [
            {'name': 'org/repo:Q4_K_M', 'path': str(model)},
        ], self.checkout)
        after = preset.read_bytes()
        self.assertTrue(after.startswith(before))
        self.assertEqual((count, added), (3, 1))
        self.assertIn(f'[nx-model-5]\nalias = org/repo:Q4_K_M\nmodel = {model.resolve()}\nload-on-startup = false',
                      after.decode())
        self.assertEqual(bridge._append_router_preset(self.manager, [
            {'name': 'org/repo:Q4_K_M', 'path': str(model)},
        ], self.checkout), (3, 0))
        self.assertEqual(preset.read_bytes(), after)

    def test_router_sync_adds_and_registers_without_starting_or_stopping(self):
        self.start_router()
        cache = self.base / 'host-cache'
        model = cache / 'hub/models--org--repo/snapshots/rev/Model-Q4_K_M.gguf'
        model.parent.mkdir(parents=True)
        model.write_bytes(self.text_gguf())
        cache_row = {
            'repo_id': 'org/repo', 'path': '/app/.cache/huggingface/hub',
            'has_incomplete': False, 'is_gguf': True, 'is_diffusion': False,
            'is_video': False, 'is_adapter': False,
            'gguf_files': [{'name': model.name, 'rel_path': f'rev/{model.name}', 'role': 'model'}],
        }
        with (mock.patch.object(self.model_helper, 'session_cookie', return_value='session', create=True),
              mock.patch.object(self.model_helper, '_request', return_value={'models': [cache_row]}, create=True),
              mock.patch.object(bridge, '_router_supported', return_value=True),
              mock.patch.object(bridge, '_owned_profile_running', return_value=True),
              mock.patch.object(bridge, '_router_status', return_value={'healthy': True}),
              mock.patch.object(bridge, '_router_inventory', side_effect=lambda p: [
                  {'id': alias, 'status': 'unloaded'} for alias in p['model_ids']]),
              mock.patch.object(bridge, '_local_json', side_effect=[
                  ValueError('router reload pending'), {'data': []},
              ]) as local_json,
              mock.patch.object(bridge, '_register_router') as register,
              mock.patch.object(bridge, '_status', return_value={'router': {'running': True}})):
            with self.assertRaisesRegex(ValueError, 'router reload pending'):
                self.dispatch({'action': 'router_sync'}, cache_root=cache)
            saved = bridge._read_state(self.manager)['nx-zvram-router']
            self.assertEqual(saved['model_ids'], ['tiny'])
            result = self.dispatch({'action': 'router_sync'}, cache_root=cache)
        self.assertEqual(result['router_sync'], {'added': 0, 'models': 2})
        self.assertEqual(self.manager.starts, ['nx-zvram-router'])
        self.assertEqual(self.manager.stops, [])
        self.assertEqual(local_json.call_count, 2)
        self.assertEqual(local_json.call_args.args[0], 'http://127.0.0.1:8097/models?reload=1')
        self.assertEqual(register.call_args.args[1]['model_ids'], ['tiny', 'org/repo:Model-Q4_K_M'])
        self.assertFalse(register.call_args.kwargs['enable_existing'])

    def test_router_registration_preserves_disabled_owned_endpoint_in_background_mode(self):
        existing = {'id': 'owned', 'name': 'zVram · Local models',
                    'base_url': 'http://127.0.0.1:8097/v1', 'is_enabled': False}
        params = {'mode': 'zvram', 'port': 8097, 'model_ids': ['tiny']}
        api = 'http://127.0.0.1:8000/api/model-endpoints'

        def register(endpoints, **kwargs):
            helper = mock.Mock()
            helper.session_cookie.return_value = 'session'
            created = {'id': 'created', 'name': 'zVram · Local models',
                       'base_url': 'http://127.0.0.1:8097/v1'}
            helper._request.side_effect = [endpoints, existing if endpoints else created, {}]
            with (mock.patch.object(bridge, '_router_inventory', return_value=[{'id': 'tiny'}]),
                  mock.patch.object(bridge, '_local_json', return_value={'data': []})):
                bridge._register_router(helper, params, self.checkout, self.base / 'cookie', 8000,
                                        **kwargs)
            return helper._request.call_args_list

        background_calls = register([existing], enable_existing=False)
        self.assertEqual(background_calls[1].args[3], {
            'name': 'zVram · Local models', 'pinned_models': ['tiny'],
        })
        explicit_calls = register([existing])
        self.assertTrue(explicit_calls[1].args[3]['is_enabled'])
        missing_calls = register([], enable_existing=False)
        self.assertEqual(missing_calls[1].args[2], 'POST')
        self.assertTrue(missing_calls[1].kwargs['form'])

        foreign = {'id': 'foreign', 'name': 'Custom provider',
                   'base_url': 'http://127.0.0.1:8097/v1'}
        helper = mock.Mock()
        helper.session_cookie.return_value = 'session'
        helper._request.return_value = [foreign]
        with (mock.patch.object(bridge, '_router_inventory', return_value=[{'id': 'tiny'}]),
              mock.patch.object(bridge, '_local_json', side_effect=AssertionError('Foreign inventory must not be read')),
              self.assertRaisesRegex(ValueError, 'belongs to another provider')):
            bridge._register_router(helper, params, self.checkout, self.base / 'cookie', 8000,
                                    enable_existing=False)
        self.assertEqual(helper._request.call_count, 1)

    def test_enable_existing_request_flag_is_strictly_boolean(self):
        self.assertFalse(bridge._request_object({'action': 'router_register', 'enable_existing': False})[
            'enable_existing'])
        with self.assertRaisesRegex(ValueError, 'enable_existing must be a boolean'):
            bridge._request_object({'action': 'router_register', 'enable_existing': 0})

    def router_command(self, model, alias, **options):
        command = ['zvram']
        if not options.get('live_control', False):
            command.append('--no-live-control')
        return (command + ['--', 'server', '--model', model, '--alias', alias,
                 '--mmproj', '/tmp/single-model-projector.gguf', '--host', '127.0.0.1',
                 '--port', str(options['port']), '--ctx-size', str(options['context'])], {})

    def start_router(self, **options):
        options.setdefault('mode', 'zvram')
        with mock.patch.object(bridge, '_router_supported', return_value=True), \
                mock.patch.object(bridge, '_port_is_free', return_value=True), \
                mock.patch.object(bridge, '_supports_live_control', return_value=True), \
                mock.patch.object(self.model_helper, 'build_server_command', side_effect=self.router_command):
            return self.dispatch({'action': 'router_start', **options})

    def test_router_start_discovers_models_without_a_saved_profile(self):
        result = self.start_router(ignore_swap_guard=True)
        self.assertTrue(result['started'])
        self.assertEqual(self.manager.starts, ['nx-zvram-router'])
        self.assertEqual(result['profiles'], [])
        stored = json.loads(self.manager.profiles_path.read_text())['nx-zvram-router']
        argv = stored['command']
        self.assertNotIn('--model', argv)
        self.assertNotIn('--alias', argv)
        self.assertEqual(argv[argv.index('--models-max') + 1], '1')
        self.assertIn('--models-autoload', argv)
        self.assertTrue(stored['live_control'])
        self.assertNotIn('--no-live-control', argv)
        self.assertTrue(stored['ignore_swap_guard'])
        self.assertEqual(stored['min_available_mib'], 4096)
        self.assertIn('LLAMA_CACHE', stored['env'])
        preset = self.home / 'router-models.ini'
        self.assertEqual(preset.stat().st_mode & 0o777, 0o600)
        self.assertIn(f'[nx-model-0]\nalias = tiny\nmodel = {self.model}\nload-on-startup = false', preset.read_text())

    def test_ram_guard_opt_out_rejects_older_manager_before_start(self):
        with mock.patch.object(self.manager_helper, 'RAM_GUARD_CAN_DISABLE', False):
            with self.assertRaisesRegex(ValueError, 'newer zVram manager'):
                self.start_router(min_available_mib=0)
        self.assertEqual(self.manager.starts, [])
        self.assertEqual(self.manager.stops, [])

    def test_router_ram_floor_opt_out_persists_and_defaults_stay_guarded(self):
        result = self.start_router(min_available_mib=0, auto_start=False)
        stored = json.loads(self.manager.profiles_path.read_text())['nx-zvram-router']
        self.assertEqual(stored['min_available_mib'], 0)
        self.assertEqual(result['router']['min_available_mib'], 0)
        self.assertFalse(result['router']['auto_start'])
        state = json.loads((self.home / 'novum_profiles.json').read_text())
        self.assertEqual(state['nx-zvram-router']['min_available_mib'], 0)
        self.start_router()
        self.assertEqual(json.loads(self.manager.profiles_path.read_text())['nx-zvram-router']['min_available_mib'], 0)
        for value in (-1, True, '0', 1048577):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.start_router(min_available_mib=value)

    def test_router_start_includes_completed_cached_text_models_but_not_image_gguf(self):
        cache = self.base / 'hf-cache'
        repo = cache / 'hub/models--org--cookbook/snapshots/revision'
        repo.mkdir(parents=True)
        text_model = repo / 'Text-Q4_K_M.gguf'
        image_model = repo / 'Image-Projector.gguf'
        text_model.write_bytes(self.text_gguf())
        image_model.write_bytes(self.text_gguf('clip'))
        cache_row = {
            'repo_id': 'org/cookbook', 'path': '/app/.cache/huggingface/hub',
            'has_incomplete': False, 'is_gguf': True, 'is_diffusion': False,
            'is_video': False, 'is_adapter': False,
            'gguf_files': [
                {'name': text_model.name, 'rel_path': f'revision/{text_model.name}', 'role': 'model'},
                {'name': image_model.name, 'rel_path': f'revision/{image_model.name}', 'role': 'model'},
            ],
        }
        with (mock.patch.object(self.model_helper, 'session_cookie', return_value='session', create=True),
              mock.patch.object(self.model_helper, '_request', return_value={'models': [cache_row]}, create=True),
              mock.patch.object(bridge, '_router_supported', return_value=True),
              mock.patch.object(bridge, '_port_is_free', return_value=True),
              mock.patch.object(bridge, '_supports_live_control', return_value=True)):
            result = self.dispatch({'action': 'router_start', 'mode': 'regular'}, cache_root=cache)
        self.assertTrue(result['started'])
        saved = bridge._read_state(self.manager)['nx-zvram-router']
        self.assertEqual(saved['model_ids'], ['tiny', 'org/cookbook:Text-Q4_K_M'])
        preset = bridge._router_preset_path(self.manager).read_text()
        self.assertIn('alias = org/cookbook:Text-Q4_K_M', preset)
        self.assertNotIn('Image-Projector', preset)

    def test_router_preset_keeps_projector_bound_to_its_ollama_model(self):
        blobs = self.checkout / 'data/ollama/models/blobs'
        blobs.mkdir(parents=True)
        projector = blobs / ('sha256-' + 'a' * 64)
        projector.write_bytes(b'GGUF projector')
        self.model_helper.projector = projector
        result = self.start_router()
        self.assertTrue(result['started'])
        self.assertNotIn('mmproj_path', result['models'][0])
        preset = (self.home / 'router-models.ini').read_text()
        self.assertIn(f'mmproj = {projector.resolve()}', preset)
        stored = json.loads(self.manager.profiles_path.read_text())['nx-zvram-router']
        argv = stored['command']
        self.assertNotIn('--mmproj', argv)
        self.assertIn(f'[nx-model-0]\nalias = tiny\nmodel = {self.model}\nmmproj = {projector.resolve()}\nload-on-startup = false', preset)

    def test_router_ignores_unverified_projector_metadata(self):
        outside = self.base / 'outside-projector.gguf'
        outside.write_bytes(b'GGUF unrelated')
        self.model_helper.projector = outside
        result = self.start_router()
        self.assertTrue(result['started'])
        preset = (self.home / 'router-models.ini').read_text()
        self.assertNotIn('mmproj =', preset)

    def test_router_preset_rejects_projector_path_delimiters(self):
        unsafe_checkout = self.base / 'backend;#unsafe'
        blobs = unsafe_checkout / 'data/ollama/models/blobs'
        blobs.mkdir(parents=True)
        projector = blobs / ('sha256-' + 'b' * 64)
        projector.write_bytes(b'GGUF projector')
        with self.assertRaisesRegex(ValueError, 'projector path'):
            bridge._write_router_preset(self.manager, [{
                'name': 'tiny', 'path': str(self.model), 'mmproj_path': str(projector),
            }], unsafe_checkout)

    def test_regular_router_uses_native_server_and_persists_autostart(self):
        with mock.patch.object(bridge, '_router_supported', return_value=True), \
                mock.patch.object(bridge, '_port_is_free', return_value=True), \
                mock.patch.object(bridge, '_supports_live_control', return_value=True), \
                mock.patch.object(self.model_helper, 'build_server_command',
                                  return_value=(['/usr/bin/llama-server', '--model', str(self.model),
                                                 '--alias', 'local', '--host', '127.0.0.1',
                                                 '--port', '8097'], {'ZVRAM_BAD': 'drop', 'LLAMA_OK': 'keep'})):
            result = self.dispatch({'action': 'router_start', 'mode': 'regular'})
        stored = json.loads(self.manager.profiles_path.read_text())['nx-zvram-router']
        self.assertEqual(stored['mode'], 'native')
        self.assertEqual(stored['command'][0], '/usr/bin/llama-server')
        self.assertNotIn('zvram', stored['command'])
        self.assertEqual(stored['env'], {'LLAMA_CACHE': str(self.home / 'router-cache')})
        self.assertEqual(result['router']['mode'], 'regular')
        self.assertTrue(result['router']['auto_start'])

    def test_configure_while_stopped_persists_mode_and_autostart_without_starting(self):
        with mock.patch.object(bridge, '_router_supported', return_value=True), \
                mock.patch.object(bridge, '_port_is_free', return_value=True), \
                mock.patch.object(bridge, '_supports_live_control', return_value=True):
            result = self.dispatch({'action': 'router_configure', 'mode': 'regular',
                                    'auto_start': False})
        self.assertTrue(result['configured'])
        self.assertEqual(result['router']['mode'], 'regular')
        self.assertFalse(result['router']['auto_start'])
        self.assertEqual(self.manager.starts, [])

    def test_partial_configure_preserves_saved_router_tuning(self):
        with mock.patch.object(bridge, '_router_supported', return_value=True), \
                mock.patch.object(bridge, '_port_is_free', return_value=True), \
                mock.patch.object(bridge, '_supports_live_control', return_value=True), \
                mock.patch.object(self.model_helper, 'build_server_command',
                                  side_effect=self.router_command):
            self.dispatch({'action': 'router_configure', 'mode': 'zvram',
                           'port': 9081, 'context': 8192, 'auto_start': False})
            result = self.dispatch({'action': 'router_configure', 'mode': 'regular'})
        self.assertEqual(result['router']['port'], 9081)
        self.assertEqual(result['router']['context'], 8192)
        self.assertEqual(result['router']['mode'], 'regular')
        self.assertFalse(result['router']['auto_start'])

    def test_running_router_configure_waits_for_owned_worker_exit(self):
        class AsyncStopManager(Manager):
            def stop(self, name):
                self.stops.append(name)
                self.job_path(name).write_text(json.dumps({'owned': True}))

                def finish_stop():
                    time.sleep(0.15)
                    self.job_path(name).unlink(missing_ok=True)

                threading.Thread(target=finish_stop, daemon=True).start()
                return True

        manager = AsyncStopManager(self.home)
        with mock.patch.object(bridge, '_router_supported', return_value=True), \
                mock.patch.object(bridge, '_port_is_free', return_value=True), \
                mock.patch.object(bridge, '_supports_live_control', return_value=True), \
                mock.patch.object(bridge, '_owned_profile_running', side_effect=[True, False]), \
                mock.patch.object(self.model_helper, 'build_server_command',
                                  return_value=(['llama-server', '--model', str(self.model),
                                                 '--alias', 'local'], {})):
            result = bridge.dispatch(self.root, self.checkout, self.base / 'cookie', 8000,
                                     {'action': 'router_configure', 'mode': 'regular',
                                      'auto_start': True}, helpers=self.helpers, manager=manager)
        self.assertTrue(result['configured'])
        self.assertEqual(manager.stops, ['nx-zvram-router'])
        self.assertEqual(manager.starts, ['nx-zvram-router'])

    def test_router_start_validates_capability_port_and_name(self):
        with mock.patch.object(bridge, '_router_supported', return_value=False):
            with self.assertRaisesRegex(ValueError, 'router support'):
                self.dispatch({'action': 'router_start'})
        with mock.patch.object(bridge, '_router_supported', return_value=True), \
                mock.patch.object(bridge, '_port_is_free', return_value=False):
            with self.assertRaisesRegex(ValueError, 'port'):
                self.dispatch({'action': 'router_start'})
        with mock.patch.object(self.model_helper, 'discover_models', return_value=[
                {'name': 'bad]\n[evil', 'path': str(self.model), 'size': 4}]):
            with self.assertRaisesRegex(ValueError, 'represented safely'):
                self.start_router()
        self.assertEqual(self.manager.starts, [])

    def test_live_control_is_opt_out_and_old_runtime_defaults_off(self):
        result = self.start_router(live_control=False)
        stored = json.loads(self.manager.profiles_path.read_text())['nx-zvram-router']
        self.assertFalse(stored['live_control'])
        self.assertIn('--no-live-control', stored['command'])

        class OldModelHelper(ModelHelpers):
            def build_server_command(self, model, alias, **kwargs):
                return super().build_server_command(model, alias, **kwargs)

        old_helper = OldModelHelper(self.model)
        params = bridge._parameters({'model': str(self.model)}, old_helper, self.checkout)
        self.assertEqual(params['context'], 32768)
        self.assertFalse(params['live_control'])
        with self.assertRaisesRegex(ValueError, 'requires a newer zVram'):
            bridge._parameters({'model': str(self.model), 'live_control': True}, old_helper, self.checkout)
        self.assertTrue(result['live_control_supported'])
        legacy = {'router': True, 'compressed': False}
        status = bridge._router_status(self.model_helper, self.manager_helper, self.manager,
                                       {'nx-zvram-router': legacy})
        self.assertTrue(status['live_control'], 'stopped legacy router defaults on for its next launch')
        legacy['live_control'] = False
        status = bridge._router_status(self.model_helper, self.manager_helper, self.manager,
                                       {'nx-zvram-router': legacy})
        self.assertFalse(status['live_control'], 'explicit opt-out is preserved')

    def test_router_status_exposes_only_valid_saved_memory_budgets(self):
        budgets = {'resident_mib': 18000, 'cold_mib': 22000, 'clean_cache_mib': 512,
                   'headroom_mib': 768, 'virtual_gib': 48}
        params = {'nx-zvram-router': {'router': True, 'port': 8123, 'context': 8192, **budgets}}
        status = bridge._router_status(self.model_helper, self.manager_helper, self.manager, params)
        self.assertEqual({key: status[key] for key in budgets}, budgets)
        self.assertEqual((status['port'], status['context']), (8123, 8192))

        params['nx-zvram-router']['clean_cache_mib'] = 23000
        status = bridge._router_status(self.model_helper, self.manager_helper, self.manager, params)
        self.assertFalse(any(key in status for key in budgets), 'invalid persisted budgets are omitted as one set')

    def test_router_status_omits_out_of_range_saved_memory_budgets(self):
        budgets = {'resident_mib': 18000, 'cold_mib': 22000, 'clean_cache_mib': 512,
                   'headroom_mib': 768, 'virtual_gib': 48}
        budgets['headroom_mib'] = 1048577
        status = bridge._router_status(self.model_helper, self.manager_helper, self.manager,
                                       {'nx-zvram-router': {'router': True, **budgets}})
        self.assertFalse(any(key in status for key in budgets), 'out-of-range persisted budgets are not restored')

    def test_router_stop_and_registration_require_owned_router(self):
        with self.assertRaisesRegex(ValueError, 'Start the model router'):
            self.dispatch({'action': 'router_stop'})
        self.start_router()
        with self.assertRaisesRegex(ValueError, 'owned model router'):
            self.dispatch({'action': 'router_register'})
        self.dispatch({'action': 'router_stop'})
        self.assertEqual(self.manager.stops, ['nx-zvram-router'])
        status = self.dispatch({'action': 'status'})
        self.assertFalse(status['router']['auto_start'])

    def test_router_starting_worker_is_not_reported_as_stopped_or_replaced(self):
        self.start_router()
        preset = (self.home / 'router-models.ini').read_bytes()
        self.manager.job_path('nx-zvram-router').write_text(json.dumps({'owned': True}))
        params = bridge._read_state(self.manager)
        with mock.patch.object(self.manager, 'list_profiles', return_value=[{'name': 'nx-zvram-router', 'state': 'starting'}]), \
                mock.patch.object(bridge, '_owned_profile_running', return_value=False):
            status = bridge._router_status(self.model_helper, self.manager_helper, self.manager, params)
        self.assertEqual(status['state'], 'starting')
        self.assertFalse(status['healthy'])
        with self.assertRaisesRegex(ValueError, 'already running'):
            self.start_router(context=8192)
        self.assertEqual((self.home / 'router-models.ini').read_bytes(), preset)

    def test_router_registration_advertises_all_models_and_preserves_foreign_provider(self):
        params = {'port': 8097, 'model_ids': ['tiny', 'other']}
        inventory = [{'id': 'tiny', 'status': 'unloaded'}, {'id': 'other', 'status': 'loaded'}]
        with mock.patch.object(bridge, '_router_inventory', return_value=inventory), \
                mock.patch.object(self.model_helper, 'session_cookie', return_value='private', create=True), \
                mock.patch.object(bridge, '_local_json', return_value={'data': [{'id': 'nx-model-0:LOCAL'}, {'id': 'nx-model-1:LOCAL'}]}), \
                mock.patch.object(self.model_helper, '_request', create=True) as request:
            request.side_effect = [[], {'id': 'created'}, {}]
            bridge._register_router(self.model_helper, params, self.checkout, self.base / 'cookie', 8000)
            self.assertEqual(json.loads(request.call_args_list[1].args[3]['pinned_models']), ['tiny', 'other'])
            self.assertEqual(request.call_args_list[1].args[3]['name'], 'zVram · Local models')
            self.assertEqual(request.call_args.args[3]['hidden'], ['nx-model-0:LOCAL', 'nx-model-1:LOCAL'])
            request.reset_mock()
            request.side_effect = [[{'id': 'created', 'name': 'zVram · Local models', 'base_url': 'http://127.0.0.1:8097/v1'}], {'id': 'created'}, {}]
            bridge._register_router(self.model_helper, params, self.checkout, self.base / 'cookie', 8000)
            self.assertEqual(request.call_args_list[1].args[0], 'http://127.0.0.1:8000/api/model-endpoints/created')
            request.reset_mock()
            request.side_effect = [[{'id': 'foreign', 'name': 'Ollama', 'base_url': 'http://127.0.0.1:8097/v1'}]]
            with self.assertRaisesRegex(ValueError, 'another provider'):
                bridge._register_router(self.model_helper, params, self.checkout, self.base / 'cookie', 8000)
            self.assertEqual(request.call_count, 1)

    def test_router_registration_rejects_malformed_model_inventory_before_endpoint_changes(self):
        params = {'port': 8097, 'model_ids': ['tiny']}
        invalid_responses = [
            'not JSON',
            {'data': {}},
            {'data': ['not a model row']},
        ]
        for response in invalid_responses:
            with self.subTest(response=response):
                with (mock.patch.object(bridge, '_router_inventory', return_value=[{'id': 'tiny'}]),
                      mock.patch.object(bridge, '_local_json', return_value=response),
                      mock.patch.object(self.model_helper, 'session_cookie', return_value='session', create=True),
                      mock.patch.object(self.model_helper, '_request', create=True) as request):
                    request.return_value = []
                    with self.assertRaisesRegex(ValueError, 'invalid registration inventory'):
                        bridge._register_router(
                            self.model_helper, params, self.checkout, self.base / 'cookie', 8000,
                        )
                    request.assert_called_once_with('http://127.0.0.1:8000/api/model-endpoints', 'session')

    def test_port_check_allows_time_wait_but_rejects_a_listener(self):
        import socket
        with socket.socket() as server:
            server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server.bind(("127.0.0.1", 0))
            port = server.getsockname()[1]
            server.listen()
            self.assertFalse(bridge._port_is_free(port))
            with socket.create_connection(("127.0.0.1", port)) as client:
                connection, _ = server.accept()
                connection.close()
                self.assertEqual(client.recv(1), b"")
        self.assertTrue(bridge._port_is_free(port))

    def test_router_inventory_requires_expected_models_and_preserves_load_state(self):
        params = {'port': 8097, 'model_ids': ['tiny']}
        with mock.patch.object(bridge, '_local_json') as request:
            request.side_effect = [{'status': 'ok'}, {'data': [{'id': 'tiny', 'status': {'value': 'unloaded'}}]}]
            self.assertEqual(bridge._router_inventory(params), [{'id': 'tiny', 'status': 'unloaded'}])
            request.side_effect = [{'status': 'ok'}, {'data': [{'id': 'nx-model-0:LOCAL', 'aliases': ['tiny'], 'status': {'value': 'unloaded'}}]}]
            self.assertEqual(bridge._router_inventory(params), [{'id': 'tiny', 'status': 'unloaded'}])
            request.side_effect = [{'status': 'ok'}, {'data': []}]
            with self.assertRaisesRegex(ValueError, 'advertise'):
                bridge._router_inventory(params)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.root = self.base / "zvram"
        self.checkout = self.base / "backend"
        self.root.mkdir()
        (self.root / "VERSION").write_text("0.4.2\n")
        self.checkout.mkdir()
        self.model = self.checkout / "tiny.gguf"
        self.model.write_bytes(b"gguf")
        self.home = self.base / "manager"
        self.manager = Manager(self.home)
        self.model_helper = ModelHelpers(self.model)
        self.manager_helper = ManagerHelpers()
        self.helpers = (self.model_helper, self.manager_helper)

    def tearDown(self):
        self.temp.cleanup()

    def dispatch(self, request, **kwargs):
        return bridge.dispatch(self.root, self.checkout, self.base / "cookie", 8000,
                               request, helpers=self.helpers, manager=self.manager, **kwargs)

    def save_request(self, **extra):
        request = {"action": "save", "model": str(self.model), "profile": "tiny",
                   "alias": "tiny"}
        request.update(extra)
        return request

    def test_server_lookup_uses_user_bin_even_when_desktop_path_omits_it(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            server = home / ".local/bin/llama-server"
            server.parent.mkdir(parents=True)
            server.write_text("fixture")
            server.chmod(0o700)
            with mock.patch.object(bridge.Path, "home", return_value=home), mock.patch.object(bridge.shutil, "which", return_value=None):
                self.assertEqual(bridge._model_server(ModelHelper()), str(server.resolve()))
                server.chmod(0o600)
                self.assertIsNone(bridge._model_server(ModelHelper()))

    def test_missing_dependency_returns_a_structured_error(self):
        output = io.StringIO()
        with mock.patch.object(bridge, "dispatch", side_effect=ModuleNotFoundError("No module named 'zvram_control'")):
            with redirect_stdout(output):
                result = bridge.main(["/install", "/backend", "/cookie", "7000", '{"action":"status"}'])
        self.assertEqual(result, 1)
        self.assertIn("zvram_control", json.loads(output.getvalue())["error"])

    def test_one_shot_main_passes_optional_cache_root(self):
        for cache in (None, "/host/hf"):
            with self.subTest(cache_root=cache):
                output = io.StringIO()
                args = ["/install", "/backend", "/cookie", "7000", '{"action":"router_start"}']
                if cache is not None:
                    args.append(cache)
                with mock.patch.object(bridge, "dispatch", return_value={"started": True}) as dispatch, redirect_stdout(output):
                    self.assertEqual(bridge.main(args), 0)
                dispatch.assert_called_once_with(
                    "/install", "/backend", "/cookie", "7000", {"action": "router_start"}, cache_root=cache,
                )
                self.assertEqual(json.loads(output.getvalue()), {"started": True})

    def test_router_watch_passes_trusted_cache_root_and_retries(self):
        output = io.StringIO()
        with (mock.patch.object(bridge, '_load_runtime', return_value=('model', 'manager')),
              mock.patch.object(bridge, 'dispatch', side_effect=[
                  ValueError('Local health response is invalid'), {'router_sync': {'added': 0, 'models': 1}},
              ]) as dispatch,
              mock.patch.object(bridge.time, 'sleep', side_effect=[None, KeyboardInterrupt]),
              redirect_stdout(output)):
            self.assertEqual(bridge.main([
                'watch', '/zvram', '/backend', '/cookie', '8000', '/host/hf', '30',
            ]), 0)
        self.assertEqual(dispatch.call_args.kwargs['cache_root'], '/host/hf')
        self.assertEqual(dispatch.call_args.kwargs['helpers'], ('model', 'manager'))
        lines = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(lines, [
            {'sync': 'pending', 'error': 'Local health response is invalid'},
            {'sync': 'ok', 'added': 0, 'models': 1},
        ])
        self.assertEqual(dispatch.call_count, 2)

    def test_router_watch_rejects_unbounded_poll_interval(self):
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(bridge.main([
                'watch', '/zvram', '/backend', '/cookie', '8000', '/host/hf', '1',
            ]), 1)
        self.assertIn('between 10 and 300', json.loads(output.getvalue())['error'])

    def test_installation_config_requires_owned_regular_json_and_returns_checkout(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            checkout = root / 'zvram-0.4.25'
            checkout.mkdir()
            config = root / 'zvram.json'
            config.write_text(json.dumps({'checkout': str(checkout)}))
            config.chmod(0o600)
            self.assertEqual(bridge._read_installation_config(config), checkout.resolve())
            link = root / 'zvram-link.json'
            link.symlink_to(config)
            with self.assertRaisesRegex(ValueError, 'unavailable'):
                bridge._read_installation_config(link)
            config.write_text(json.dumps({'checkout': '/missing/zvram'}))
            config.chmod(0o600)
            with self.assertRaisesRegex(ValueError, 'unavailable'):
                bridge._read_installation_config(config)

    def test_watch_waits_for_install_config_and_loads_new_root_not_removed_old_install(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            old_root = state / 'zvram-0.4.24'
            new_root = state / 'zvram-0.4.25'
            new_root.mkdir()
            config = state / 'zvram.json'
            reads = 0
            def read_config(_path):
                nonlocal reads
                reads += 1
                if reads == 1:
                    raise ValueError('The configured zVram installation is unavailable')
                return new_root
            def sleep(_interval):
                if reads == 1:
                    config.write_text(json.dumps({'checkout': str(new_root)}))
                    config.chmod(0o600)
                else:
                    raise KeyboardInterrupt
            output = io.StringIO()
            with (mock.patch.object(bridge, '_read_installation_config', side_effect=read_config),
                  mock.patch.object(bridge, '_load_runtime', return_value=('new-model-helper', 'shared-manager')) as load,
                  mock.patch.object(bridge, 'dispatch', return_value={'router_sync': {'added': 0, 'models': 1}}) as dispatch,
                  mock.patch.object(bridge.time, 'sleep', side_effect=sleep),
                  redirect_stdout(output)):
                self.assertEqual(bridge.main([
                    'watch', str(old_root), '/backend', '/cookie', '8000',
                    '/host/hf', '30', str(config),
                ]), 0)
            self.assertEqual(load.call_args_list, [mock.call(new_root)])
            self.assertEqual(dispatch.call_count, 1)
            self.assertEqual(dispatch.call_args.args[0], new_root)
            self.assertEqual(dispatch.call_args.kwargs['helpers'], ('new-model-helper', 'shared-manager'))
            self.assertEqual([json.loads(line)['sync'] for line in output.getvalue().splitlines()], ['pending', 'ok'])

    def test_isolated_runtime_can_import_its_sibling_modules(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "zvram_model.py").write_text("from pathlib import Path\nROOT=Path(__file__).parent\n")
            (root / "zvram_manager.py").write_text(
                "from pathlib import Path\nfrom dataclasses import dataclass\nROOT=Path(__file__).parent\n"
                "@dataclass\nclass Manager:\n value: int = 0\n"
                " def __post_init__(self):\n  import zvram_control\n  self.value=zvram_control.value()\n")
            (root / "zvram_control.py").write_text(
                "def value():\n from zvram_manager import Manager\n return 42\n")
            code = (
                "import importlib.util,sys; "
                "s=importlib.util.spec_from_file_location('bridge',sys.argv[1]); "
                "b=importlib.util.module_from_spec(s);s.loader.exec_module(b); "
                "model,manager=b._load_runtime(sys.argv[2]); "
                "assert manager.Manager().value==42"
            )
            result = subprocess.run([sys.executable, "-I", "-c", code, str(BRIDGE_PATH), directory],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_request_rejects_unknown_fields(self):
        with self.assertRaisesRegex(ValueError, "unsupported fields"):
            bridge._request_object({"action": "status", "command": ["evil"]})
        self.assertEqual(bridge._request_object({'action': 'router_start', 'port': None}),
                         {'action': 'router_start'})

    def test_generated_profile_keeps_only_model_helper_overrides(self):
        profile = bridge._build_manager_profile(ModelHelper(), "demo", {
            "model": "/models/a.gguf", "alias": "a", "port": 8097,
            "context": 4096, "compressed": False, "resident_mib": 19456,
            "cold_mib": 26624, "clean_cache_mib": 1024,
            "headroom_mib": 1536, "virtual_gib": 96, "ignore_swap_guard": False,
            "live_control": True,
        })
        self.assertEqual(profile["env"], {"ZVRAM_TYPED": "yes", "GGML_CACHE": "safe"})
        self.assertNotIn("API_TOKEN", profile["env"])

    def test_start_temporarily_scrubs_inherited_zvram_environment(self):
        key = "ZVRAM_BRIDGE_TEST_INHERITED"
        manager = Manager()
        old = os.environ.get(key)
        os.environ[key] = "must-not-reach-child"
        try:
            bridge._start_manager(manager, "demo")
            self.assertNotIn(key, manager.seen_env)
            self.assertEqual(os.environ[key], "must-not-reach-child")
        finally:
            if old is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = old

    def test_health_requires_health_and_matching_model_alias(self):
        with mock.patch.object(bridge, "_local_json", side_effect=[
            {"status": "ok"}, {"data": [{"id": "the-alias"}]},
        ]) as request:
            self.assertTrue(bridge._health(None, "the-alias", 8097))
            self.assertEqual(request.call_count, 2)
        with mock.patch.object(bridge, "_local_json", side_effect=[
            {"status": "ok"}, {"data": [{"id": "other"}]},
        ]):
            self.assertFalse(bridge._health(None, "the-alias", 8097))

    def test_health_rejects_unhealthy_endpoint(self):
        with mock.patch.object(bridge, "_local_json", return_value={"status": "bad"}) as request:
            self.assertFalse(bridge._health(None, "the-alias", 8097))
            request.assert_called_once()

    def test_local_json_normalizes_malformed_status_and_incomplete_http_body(self):
        for response in (
            b"HTTP/1.1 not-a-status\r\nContent-Length: 0\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nContent-Length: 20\r\nConnection: close\r\n\r\n{}",
        ):
            listener = socket.socket()
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            listener.settimeout(2)

            def respond():
                connection, _ = listener.accept()
                with connection:
                    connection.settimeout(2)
                    connection.recv(4096)
                    connection.sendall(response)
                    connection.shutdown(socket.SHUT_WR)

            worker = threading.Thread(target=respond)
            worker.start()
            try:
                with self.subTest(response=response):
                    with self.assertRaisesRegex(ValueError, "^Local health response is invalid$"):
                        bridge._local_json(f"http://127.0.0.1:{listener.getsockname()[1]}/health")
            finally:
                listener.close()
                worker.join(timeout=2)
            self.assertFalse(worker.is_alive())

    def test_router_status_and_watch_survive_malformed_local_http_response(self):
        params = {'nx-zvram-router': {
            'router': True, 'mode': 'zvram', 'port': 8097, 'model_ids': ['tiny'],
        }}
        with (mock.patch.object(bridge, '_owned_profile_running', return_value=True),
              mock.patch.object(bridge, '_local_json', side_effect=ValueError('Local health response is invalid'))):
            status = bridge._router_status(
                self.model_helper, self.manager_helper, self.manager, params,
            )
        self.assertTrue(status['running'])
        self.assertFalse(status['healthy'])

    def test_save_then_status_exposes_typed_owned_profile(self):
        result = self.dispatch(self.save_request())
        self.assertTrue(result["saved"])
        self.assertEqual(result["installation"], str(self.root))
        self.assertEqual(result["profiles"][0]["name"], "tiny")
        stored = json.loads(self.manager.profiles_path.read_text())["tiny"]
        self.assertEqual(stored["command"][:2], ["server", "--model"])
        self.assertEqual(stored["env"], {"ZVRAM_TYPED": "yes", "GGML_CACHE": "safe"})
        status = self.dispatch({"action": "status"})
        self.assertEqual(status["profiles"][0]["alias"], "tiny")

    def test_ignore_swap_guard_defaults_on_for_supported_zvram_and_persists(self):
        result = self.dispatch(self.save_request())
        self.assertTrue(result["ignore_swap_guard_supported"])
        self.assertTrue(result["profiles"][0]["ignore_swap_guard"])
        manager_profile = json.loads(self.manager.profiles_path.read_text())["tiny"]
        saved_state = json.loads((self.home / bridge._STATE_NAME).read_text())["tiny"]
        self.assertIs(manager_profile["ignore_swap_guard"], True)
        self.assertIs(saved_state["ignore_swap_guard"], True)

        # An explicit opt-out remains stable when saving again.
        result = self.dispatch(self.save_request(ignore_swap_guard=False))
        self.assertFalse(result["profiles"][0]["ignore_swap_guard"])
        manager_profile = json.loads(self.manager.profiles_path.read_text())["tiny"]
        self.assertIs(manager_profile["ignore_swap_guard"], False)

    def test_regular_mode_never_ignores_swap_growth(self):
        result = self.start_router(mode="regular")
        self.assertFalse(result["router"]["ignore_swap_guard"])
        profile = json.loads(self.manager.profiles_path.read_text())[bridge._ROUTER_NAME]
        self.assertIs(profile["ignore_swap_guard"], False)

    def test_ignore_swap_guard_requires_zvram_042(self):
        (self.root / "VERSION").write_text("0.4.1\n")
        self.assertFalse(bridge._supports_ignore_swap_guard(self.root))
        result = self.dispatch(self.save_request())
        self.assertFalse(result["profiles"][0]["ignore_swap_guard"])
        manager_profile = json.loads(self.manager.profiles_path.read_text())["tiny"]
        self.assertIs(manager_profile["ignore_swap_guard"], False)
        with self.assertRaisesRegex(ValueError, "requires zVram 0.4.2 or newer"):
            self.dispatch(self.save_request(ignore_swap_guard=True))

    def test_save_rejects_undiscovered_model_and_backend_port(self):
        with self.assertRaisesRegex(ValueError, "discovered GGUF"):
            self.dispatch(self.save_request(model=str(self.base / "elsewhere.gguf")))
        with self.assertRaisesRegex(ValueError, "differ from the Novum backend port"):
            self.dispatch(self.save_request(port=8000))

    def test_running_profile_requires_same_child_identity_and_worker_parent(self):
        from types import SimpleNamespace
        saved = {"pid": 200, "start": "old", "uid": 1000}
        job = {"identity": {"pid": 100}, "child_pid": 200, "child_identity": saved}
        helper = SimpleNamespace(read_json=lambda *_: job, owned_worker=lambda *_: True,
                                 identity=mock.Mock(return_value=saved))
        manager = SimpleNamespace(job_path=lambda _: Path('/fake/job'))
        argv = b'\0'.join(x.encode() for x in
                          ['server', '--port', '8097', '--alias', 'demo', '--host', '127.0.0.1'])
        params = {"port": 8097, "alias": "demo"}
        def check(parent=100):
            with mock.patch.object(Path, 'read_bytes', return_value=argv), \
                    mock.patch.object(Path, 'read_text', return_value=f'200 (server) S {parent} 0'):
                return bridge._owned_profile_running(helper, manager, 'demo', params)
        self.assertTrue(check())
        helper.identity.return_value = {**saved, "start": "reused"}
        self.assertFalse(check())
        helper.identity.return_value = saved
        self.assertFalse(check(parent=999))
        helper.identity.side_effect = [saved, {**saved, "start": "reused"}]
        self.assertFalse(check())
        helper.identity.side_effect = None
        job.pop('child_identity')
        self.assertFalse(check())

    def test_save_refuses_overwriting_owned_running_profile(self):
        self.dispatch(self.save_request())
        with mock.patch.object(bridge, "_owned_profile_running", return_value=True):
            with self.assertRaisesRegex(ValueError, "Stop the running profile"):
                self.dispatch(self.save_request(context=8192))

    def test_start_rebuilds_persisted_command_and_checks_port(self):
        self.dispatch(self.save_request())
        saved = json.loads((self.home / bridge._STATE_NAME).read_text())
        saved["tiny"].pop("live_control")
        (self.home / bridge._STATE_NAME).write_text(json.dumps(saved))
        profiles = json.loads(self.manager.profiles_path.read_text())
        profiles["tiny"]["command"] = ["/attacker/command"]
        self.manager.profiles_path.write_text(json.dumps(profiles))
        with mock.patch.object(bridge, "_port_is_free", return_value=False):
            with self.assertRaisesRegex(ValueError, "already in use"):
                self.dispatch({"action": "start", "profile": "tiny"})
        self.assertEqual(self.manager.starts, [])
        with mock.patch.object(bridge, "_port_is_free", return_value=True):
            result = self.dispatch({"action": "start", "profile": "tiny"})
        self.assertTrue(result["started"])
        stored = json.loads(self.manager.profiles_path.read_text())["tiny"]
        self.assertEqual(stored["command"][:2], ["server", "--model"])
        self.assertIn("--no-live-control", stored["command"])
        saved = json.loads((self.home / bridge._STATE_NAME).read_text())
        self.assertIs(saved["tiny"]["live_control"], False)
        self.assertEqual(self.manager.starts, ["tiny"])

    def test_register_requires_owned_running_healthy_endpoint(self):
        self.dispatch(self.save_request())
        with mock.patch.object(bridge, "_owned_profile_running", return_value=False):
            with self.assertRaisesRegex(ValueError, "Start this Novum-owned"):
                self.dispatch({"action": "register", "profile": "tiny"})
        self.assertEqual(self.model_helper.registered, [])
        with (mock.patch.object(bridge, "_owned_profile_running", return_value=True),
              mock.patch.object(bridge, "_health", return_value=False)):
            with self.assertRaisesRegex(ValueError, "not healthy"):
                self.dispatch({"action": "register", "profile": "tiny"})
        self.assertEqual(self.model_helper.registered, [])
        with (mock.patch.object(bridge, "_owned_profile_running", return_value=True),
              mock.patch.object(bridge, "_health", return_value=True)):
            result = self.dispatch({"action": "register", "profile": "tiny"})
        self.assertTrue(result["registered"])
        self.assertEqual(self.model_helper.registered[0][2]["checkout"], str(self.checkout))

    def test_stop_works_after_model_disappears(self):
        self.dispatch(self.save_request())
        self.model.unlink()
        result = self.dispatch({"action": "stop", "profile": "tiny"})
        self.assertTrue(result["stopped"])
        self.assertEqual(self.manager.stops, ["tiny"])


if __name__ == "__main__":
    unittest.main()
