import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import solution
from solution import save_json


@contextlib.contextmanager
def replace_mock(side_effect):
    # Support both `import os` and direct/aliased imports of os.replace.
    original = os.replace
    with contextlib.ExitStack() as stack:
        replacement = stack.enter_context(patch("os.replace", side_effect=side_effect))
        for name, value in vars(solution).items():
            if value is original:
                stack.enter_context(patch.object(solution, name, replacement))
        yield replacement


class SaveJsonTests(unittest.TestCase):
    def test_create_unicode_and_return_none_without_output(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "result.json"
            value = {"name": "München 🐾", "items": [1, None, True, {"λ": 2.5}]}
            stdout, stderr = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                result = save_json(target, value)
            self.assertIsNone(result)
            self.assertEqual(json.loads(target.read_text(encoding="utf-8")), value)
            self.assertEqual(stdout.getvalue(), "")
            self.assertEqual(stderr.getvalue(), "")
            self.assertEqual(set(Path(directory).iterdir()), {target})

    def test_replace_existing_and_preserve_unrelated_file(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "result.json"
            other = Path(directory) / "unrelated.txt"
            target.write_bytes(b"old contents")
            other.write_bytes(b"keep me")
            save_json(str(target), ["new", 4])
            self.assertEqual(json.loads(target.read_text(encoding="utf-8")), ["new", 4])
            self.assertEqual(other.read_bytes(), b"keep me")
            self.assertEqual(set(Path(directory).iterdir()), {target, other})

    def test_serialization_failure_preserves_existing_and_cleans_up(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "result.json"
            original = b"unchanged\x00bytes"
            target.write_bytes(original)
            with self.assertRaises(TypeError):
                save_json(target, {"valid": [1, 2], "bad": object()})
            self.assertEqual(target.read_bytes(), original)
            self.assertEqual(set(Path(directory).iterdir()), {target})

    def test_serialization_failure_does_not_create_target(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "result.json"
            with self.assertRaises(TypeError):
                save_json(target, {"bad": object()})
            self.assertFalse(target.exists())
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_replace_failure_preserves_existing_and_cleans_up(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "result.json"
            target.write_bytes(b"original")
            error = OSError("simulated replacement failure")
            with replace_mock(error) as replace:
                with self.assertRaises(OSError) as caught:
                    save_json(target, {"new": 1})
            self.assertIs(caught.exception, error)
            self.assertEqual(replace.call_count, 1)
            self.assertEqual(target.read_bytes(), b"original")
            self.assertEqual(set(Path(directory).iterdir()), {target})

    def test_replace_failure_leaves_absent_target_absent(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "result.json"
            with replace_mock(OSError("simulated failure")):
                with self.assertRaises(OSError):
                    save_json(target, [1, 2, 3])
            self.assertFalse(target.exists())
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_replacement_uses_complete_sibling_temp_before_touching_target(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "result.json"
            target.write_bytes(b"original")
            value = {"complete": [1, 2, 3]}
            real_replace = os.replace
            observed = []
            def inspect_replace(source, destination):
                source, destination = Path(source), Path(destination)
                self.assertEqual(source.resolve().parent, target.resolve().parent)
                self.assertNotEqual(source.resolve(), target.resolve())
                self.assertEqual(destination.resolve(), target.resolve())
                self.assertEqual(target.read_bytes(), b"original")
                self.assertEqual(json.loads(source.read_text(encoding="utf-8")), value)
                observed.append(source)
                return real_replace(source, destination)
            with replace_mock(inspect_replace):
                save_json(target, value)
            self.assertEqual(len(observed), 1)
            self.assertFalse(observed[0].exists())
            self.assertEqual(json.loads(target.read_text(encoding="utf-8")), value)
            self.assertEqual(set(Path(directory).iterdir()), {target})
