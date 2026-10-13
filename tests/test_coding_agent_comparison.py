"""Focused stdlib checks for the generic coding-agent comparison runner."""
import importlib.util
import json
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import shlex
import unittest
from types import SimpleNamespace


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "coding_agent_comparison.py"
spec = importlib.util.spec_from_file_location("coding_agent_comparison", SCRIPT)
comparison = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comparison)


class CodingAgentComparisonTests(unittest.TestCase):
    def test_fixture_starts_broken_and_has_stable_identity(self):
        self.assertEqual(comparison.fixture_hash(), comparison.fixture_hash())
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "calc.py").write_text(comparison.FIXTURE["calc.py"])
            result = subprocess.run(
                [sys.executable, "-c", comparison.ACCEPTANCE], cwd=directory,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        self.assertNotEqual(result.returncode, 0)

    def test_command_templates_are_argv_and_reject_secrets(self):
        result = comparison.command_argv(
            "python3 {task_file}", {"task_file": "/tmp/task file.md"}
        )
        self.assertEqual(result, ["python3", "/tmp/task file.md"])
        with self.assertRaisesRegex(ValueError, "credentials"):
            comparison.command_argv("aider --api-key secret", {})
        with self.assertRaisesRegex(ValueError, "unknown command placeholder"):
            comparison.command_argv("runner {oops}", {})

    def test_endpoint_rejects_invalid_or_credential_bearing_urls(self):
        for endpoint in (
            "ftp://localhost/model", "http://user:pass@localhost",
            "http://localhost/?token=x",
        ):
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                comparison.validate_endpoint(endpoint)

    def test_settings_reject_credentials_and_require_object(self):
        self.assertEqual(
            comparison.parse_settings('{"temperature":0,"max_tokens":128}'),
            {"temperature": 0, "max_tokens": 128},
        )
        with self.assertRaisesRegex(ValueError, "credential-like"):
            comparison.parse_settings('{"api_key":"secret"}')
        with self.assertRaisesRegex(ValueError, "JSON object"):
            comparison.parse_settings("[]")

    def test_runner_isolates_agents_and_tests_their_edits(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            adapter = root / "fix.py"
            adapter.write_text(
                "from pathlib import Path\n"
                "path = Path('calc.py')\n"
                "path.write_text(path.read_text().replace('a - b', 'a + b'))\n"
            )
            noop = root / "noop.py"
            noop.write_text("pass\n")
            command = f"{shlex.quote(sys.executable)} {shlex.quote(str(adapter))}"
            noop_command = f"{shlex.quote(sys.executable)} {shlex.quote(str(noop))}"
            args = SimpleNamespace(
                endpoint="http://127.0.0.1:11434", settings_json='{"temperature":0}',
                novum_command=command, aider_command=noop_command,
                output_dir=str(root / "run"), model="qwen3.5:9b", timeout=30,
            )

            self.assertEqual(comparison.run_comparison(args), 1)
            report = json.loads((root / "run" / "report.json").read_text())
            novum = Path(report["results"]["novum"]["workspace"])
            aider = Path(report["results"]["aider"]["workspace"])
            self.assertNotEqual(novum, aider)
            self.assertTrue(report["results"]["novum"]["passed"])
            self.assertFalse(report["results"]["aider"]["passed"])
            self.assertFalse(report["results"]["novum"]["manual_interventions"]["operator_recorded"])
            self.assertIn("a + b", (novum / "calc.py").read_text())
            self.assertIn("a - b", (aider / "calc.py").read_text())
            self.assertEqual(report["model"], "qwen3.5:9b")
            self.assertFalse(report["model_output_saved"])
            self.assertFalse(report["credentials_saved"])

    def test_runner_honors_and_records_aider_first_order(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            order_file = root / "order.txt"
            adapter = root / "record.py"
            adapter.write_text(
                "import sys\nfrom pathlib import Path\n"
                "with Path(sys.argv[2]).open('a') as out: out.write(sys.argv[1] + '\\n')\n"
            )
            command = f"{shlex.quote(sys.executable)} {shlex.quote(str(adapter))}"
            args = SimpleNamespace(
                endpoint="http://127.0.0.1:11434", settings_json="{}",
                novum_command=f"{command} novum {shlex.quote(str(order_file))}",
                aider_command=f"{command} aider {shlex.quote(str(order_file))}",
                output_dir=str(root / "run"), model="qwen3.5:9b", timeout=30,
                order="aider-first",
            )

            comparison.run_comparison(args)
            report = json.loads((root / "run" / "report.json").read_text())
            self.assertEqual(order_file.read_text().splitlines(), ["aider", "novum"])
            self.assertEqual(report["run_order"], ["aider", "novum"])


if __name__ == "__main__":
    unittest.main()
