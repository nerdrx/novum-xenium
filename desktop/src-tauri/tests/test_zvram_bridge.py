import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest
from contextlib import nullcontext, redirect_stdout
from unittest import mock


BRIDGE_PATH = Path(__file__).parents[1] / "src" / "zvram_bridge.py"
SPEC = importlib.util.spec_from_file_location("zvram_bridge_test", BRIDGE_PATH)
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


class ModelHelper:
    def build_server_command(self, model, alias, **kwargs):
        return (["server", "--model", model, "--alias", alias], {
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

    def discover_models(self, checkout):
        try:
            size = self.model.stat().st_size
        except FileNotFoundError:
            return []
        return [{"name": "tiny", "path": str(self.model), "size": size}]

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
    def router_command(self, model, alias, **options):
        return (['zvram', '--no-live-control', '--', 'server', '--model', model, '--alias', alias,
                 '--host', '127.0.0.1', '--port', str(options['port']), '--ctx-size', str(options['context'])], {})

    def start_router(self, **options):
        with mock.patch.object(bridge, '_router_supported', return_value=True), \
                mock.patch.object(bridge, '_port_is_free', return_value=True), \
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
        self.assertTrue(stored['ignore_swap_guard'])
        self.assertEqual(stored['min_available_mib'], 4096)
        self.assertIn('LLAMA_CACHE', stored['env'])
        preset = self.home / 'router-models.ini'
        self.assertEqual(preset.stat().st_mode & 0o777, 0o600)
        self.assertIn(f'[nx-model-0]\nalias = tiny\nmodel = {self.model}\nload-on-startup = false', preset.read_text())

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

    def test_router_stop_and_registration_require_owned_router(self):
        with self.assertRaisesRegex(ValueError, 'Start the model router'):
            self.dispatch({'action': 'router_stop'})
        self.start_router()
        with self.assertRaisesRegex(ValueError, 'owned model router'):
            self.dispatch({'action': 'router_register'})
        self.dispatch({'action': 'router_stop'})
        self.assertEqual(self.manager.stops, ['nx-zvram-router'])

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

    def test_generated_profile_keeps_only_model_helper_overrides(self):
        profile = bridge._build_manager_profile(ModelHelper(), "demo", {
            "model": "/models/a.gguf", "alias": "a", "port": 8097,
            "context": 4096, "compressed": False, "resident_mib": 19456,
            "cold_mib": 26624, "clean_cache_mib": 1024,
            "headroom_mib": 1536, "virtual_gib": 96, "ignore_swap_guard": False,
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

    def test_ignore_swap_guard_is_opt_in_and_persisted_to_manager(self):
        result = self.dispatch(self.save_request(ignore_swap_guard=True))
        self.assertTrue(result["ignore_swap_guard_supported"])
        self.assertTrue(result["profiles"][0]["ignore_swap_guard"])
        manager_profile = json.loads(self.manager.profiles_path.read_text())["tiny"]
        saved_state = json.loads((self.home / bridge._STATE_NAME).read_text())["tiny"]
        self.assertIs(manager_profile["ignore_swap_guard"], True)
        self.assertIs(saved_state["ignore_swap_guard"], True)

        self.dispatch(self.save_request())
        manager_profile = json.loads(self.manager.profiles_path.read_text())["tiny"]
        self.assertIs(manager_profile["ignore_swap_guard"], False)

    def test_ignore_swap_guard_requires_zvram_042(self):
        (self.root / "VERSION").write_text("0.4.1\n")
        self.assertFalse(bridge._supports_ignore_swap_guard(self.root))
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
