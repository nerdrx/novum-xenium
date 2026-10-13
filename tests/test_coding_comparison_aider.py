"""No-network checks for the Aider adapter's CLI and config generation."""
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "coding_comparison_aider.py"
spec = importlib.util.spec_from_file_location("coding_comparison_aider", SCRIPT)
aider_adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(aider_adapter)


class AiderAdapterTests(unittest.TestCase):
    def test_provider_model_names(self):
        self.assertEqual(aider_adapter.model_identifier("qwen3.5:9b", "ollama"), "ollama_chat/qwen3.5:9b")
        self.assertEqual(aider_adapter.model_identifier("qwen3.5:9b", "openai-compatible"), "openai/qwen3.5:9b")
        with self.assertRaisesRegex(ValueError, "bare model name"):
            aider_adapter.model_identifier("other/model", "ollama")

    def test_endpoint_model_override_uses_serving_id(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            (workspace / "TASK.md").write_text("Fix calc.py.\n")
            (workspace / "calc.py").write_text("def add(a,b): return a-b\n")
            fake = root / "fake-aider"
            fake.write_text(
                f"#!{sys.executable}\n"
                "import json, sys\n"
                "from pathlib import Path\n"
                "args = sys.argv[1:]\n"
                "Path('seen-model').write_text(args[args.index('--model') + 1])\n"
            )
            fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
            args = type("Args", (), {
                "endpoint": "http://127.0.0.1:8097/v1", "settings_json": "{}",
                "model": "qwen3.5:9b", "endpoint_model": "nx-model-5", "provider": "openai-compatible",
                "task_file": str(workspace / "TASK.md"), "aider_bin": str(fake), "timeout": 5,
                "pass_env": (),
            })()
            previous = Path.cwd()
            try:
                os.chdir(workspace)
                self.assertEqual(aider_adapter.run(args), 0)
            finally:
                os.chdir(previous)
            self.assertEqual((workspace / "seen-model").read_text(), "openai/nx-model-5")

    def test_endpoint_and_settings_reject_credentials(self):
        self.assertEqual(aider_adapter.validate_endpoint("http://localhost:11434/"), "http://localhost:11434")
        with self.assertRaisesRegex(ValueError, "without credentials"):
            aider_adapter.validate_endpoint("http://user:pass@localhost")
        with self.assertRaisesRegex(ValueError, "credential-like"):
            aider_adapter.parse_settings('{"extra_headers":{"Authorization":"Bearer secret"}}')
        self.assertEqual(
            aider_adapter.parse_settings('{"temperature":0.2,"max_tokens":8000}'),
            {"temperature": 0.2, "max_tokens": 8000},
        )
        for key in ("api_key", "access_token", "refresh_token", "client-secret"):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "credential-like"):
                aider_adapter.parse_settings(json.dumps({key: "private"}))

    def test_provider_environment_uses_same_endpoint_without_recording_keys(self):
        env = aider_adapter.child_environment("http://local-model:11434", "ollama", {
            "HOME": "/home/user", "AIDER_MODEL": "wrong/model",
            "OLLAMA_API_KEY": "credential-value", "OPENAI_API_BASE": "old-endpoint",
            "DB_PASSWORD": "unrelated-secret", "PROXY_MODE": "local",
        }, pass_env=("PROXY_MODE",))
        self.assertEqual(env["OLLAMA_API_BASE"], "http://local-model:11434")
        self.assertNotIn("AIDER_MODEL", env)
        self.assertNotIn("OPENAI_API_BASE", env)
        self.assertNotIn("DB_PASSWORD", env)
        self.assertEqual(env["PROXY_MODE"], "local")
        self.assertEqual(env["OLLAMA_API_KEY"], "credential-value")

    def test_aider_config_maps_shared_settings_to_litellm_params(self):
        with tempfile.TemporaryDirectory() as directory:
            config, model_settings = aider_adapter.write_aider_config(
                Path(directory), "ollama_chat/qwen3.5:9b", {"temperature": 0, "top_p": 1}
            )
            self.assertEqual(json.loads(config.read_text())["model"], "ollama_chat/qwen3.5:9b")
            entry = json.loads(model_settings.read_text())[0]
            self.assertEqual(entry["extra_params"], {"temperature": 0, "top_p": 1})
            self.assertTrue(entry["use_temperature"])

    def test_command_uses_one_shot_mode_and_prevents_aider_commits(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            command = aider_adapter.build_command(
                "/tmp/isolated/aider", "ollama_chat/qwen3.5:9b",
                root / "TASK.md", root / "config.yml", root / "settings.yml",
                root / "empty.env", root,
            )
        self.assertIn("--message-file", command)
        self.assertIn("--no-git", command)
        self.assertIn("--no-auto-commits", command)
        self.assertIn("--no-check-update", command)
        self.assertEqual(command[command.index("--file") + 1], "calc.py")
        self.assertNotIn("--openai-api-key", command)

    def test_source_files_are_validated_and_passed_to_aider(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "core.py").write_text("def total(values): return sum(values)\n")
            (root / "report.py").write_text("from core import total\n")
            files = aider_adapter.source_files('["core.py", "report.py"]', root)
            command = aider_adapter.build_command(
                "/tmp/isolated/aider", "openai/qwen3.5:9b", root / "TASK.md",
                root / "config.yml", root / "settings.yml", root / "empty.env", root, files,
            )
            self.assertEqual(
                [command[index + 1] for index, value in enumerate(command[:-1]) if value == "--file"],
                ["core.py", "report.py"],
            )
            for raw in ('[]', '["../secret"]', '["missing.py"]', '["core.py", "core.py"]'):
                with self.subTest(raw=raw), self.assertRaises(ValueError):
                    aider_adapter.source_files(raw, root)

    def test_run_executes_fake_cli_without_model_request(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            (workspace / "TASK.md").write_text("Fix calc.py.\n")
            (workspace / "calc.py").write_text("def add(a, b): return a - b\n")
            fake = root / "fake-aider"
            fake.write_text(
                f"#!{sys.executable}\n"
                "import json, os, sys\n"
                "from pathlib import Path\n"
                "args = sys.argv[1:]\n"
                "settings_path = Path(args[args.index('--model-settings-file') + 1])\n"
                "entry = json.loads(settings_path.read_text())[0]\n"
                "assert entry['extra_params'] == {'temperature': 0}\n"
                "assert os.environ['OLLAMA_API_BASE'] == 'http://127.0.0.1:11434'\n"
                "Path('calc.py').write_text('def add(a, b): return a + b\\n')\n"
            )
            fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
            args = type("Args", (), {
                "endpoint": "http://127.0.0.1:11434", "settings_json": '{"temperature":0}',
                "model": "qwen3.5:9b", "provider": "ollama", "task_file": str(workspace / "TASK.md"),
                "aider_bin": str(fake), "timeout": 5,
            })()
            previous = Path.cwd()
            try:
                os.chdir(workspace)
                self.assertEqual(aider_adapter.run(args), 0)
            finally:
                os.chdir(previous)
            self.assertIn("a + b", (workspace / "calc.py").read_text())
            self.assertEqual(sorted(path.name for path in workspace.iterdir()), ["TASK.md", "calc.py"])


if __name__ == "__main__":
    unittest.main()
