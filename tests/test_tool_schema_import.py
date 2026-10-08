from __future__ import annotations

import os
import subprocess
import sys


def test_tool_schema_and_parser_import_directly_in_fresh_interpreter(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    env = os.environ.copy()
    env["ODYSSEUS_DATA_DIR"] = str(data)
    env["DATABASE_URL"] = f"sqlite:///{data / 'app.db'}"
    result = subprocess.run(
        [sys.executable, "-c", "import src.tool_schemas; import src.tool_parsing"],
        cwd=os.path.dirname(os.path.dirname(__file__)),
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, result.stderr
