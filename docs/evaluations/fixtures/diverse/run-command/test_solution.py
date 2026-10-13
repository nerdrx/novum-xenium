import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from solution import run_command


class RunCommandTests(unittest.TestCase):
    def test_captures_both_streams_and_preserves_whitespace(self):
        result = run_command([sys.executable, '-c',
                              "import sys; sys.stdout.write(' out \\n'); sys.stderr.write(' err\\n')"], 3)
        self.assertEqual(result, {'returncode': 0, 'stdout': ' out \n', 'stderr': ' err\n'})

    def test_arguments_are_literal(self):
        args = ['space inside', '$HOME', '$(echo nope)', '; echo nope', '*', '', 'a"b']
        result = run_command([sys.executable, '-c',
                              'import json,sys; print(json.dumps(sys.argv[1:]))', *args], 3)
        self.assertEqual(result['returncode'], 0)
        self.assertEqual(result['stderr'], '')
        self.assertEqual(json.loads(result['stdout']), args)

    def test_nonzero_returncode_is_returned(self):
        result = run_command([sys.executable, '-c', 'import sys; sys.exit(7)'], 3)
        self.assertEqual(result, {'returncode': 7, 'stdout': '', 'stderr': ''})

    def test_invalid_utf8_uses_replacement_in_both_streams(self):
        result = run_command([sys.executable, '-c',
                              "import os; os.write(1, b'caf\\xc3\\xa9\\xff\\n'); os.write(2, b'\\xfeerr')"], 3)
        self.assertEqual(result, {'returncode': 0, 'stdout': 'café\ufffd\n', 'stderr': '\ufffderr'})

    def test_missing_executable_propagates(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = str(Path(directory) / 'does-not-exist')
            with self.assertRaises(FileNotFoundError):
                run_command([missing], 3)

    def test_timeout_propagates(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            run_command([sys.executable, '-c', 'import time; time.sleep(5)'], 0.15)


if __name__ == '__main__':
    unittest.main()
