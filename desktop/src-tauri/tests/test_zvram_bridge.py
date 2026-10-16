import importlib.util
import io
import json
import os
from pathlib import Path
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
            target.write_bytes(b"GGUFfixture")
            model = repo / "Dolphin.F16.gguf"
            model.symlink_to(target)
            (repo / "ignore.gguf").write_bytes(b"not GGUF")
            config = home / ".config/dev.novum.xenium/config.json"
            config.parent.mkdir(parents=True)
            config.write_text(json.dumps({"checkout": str(checkout), "model_roots": [str(repo.parent.parent)]}))

            class EmptyModels:
                def discover_models(self, _checkout):
                    return []

            with mock.patch.object(bridge.Path, "home", return_value=home):
                rows = bridge._model_rows(EmptyModels(), checkout)
            self.assertEqual(rows, [{"name": "owner/Dolphin:Dolphin.F16",
                                     "path": str(target.resolve()), "size": 11}])

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

    def dispatch(self, request):
        return bridge.dispatch(self.root, self.checkout, self.base / "cookie", 8000,
                               request, helpers=self.helpers, manager=self.manager)

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
