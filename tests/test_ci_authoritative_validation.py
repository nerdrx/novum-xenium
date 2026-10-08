"""Regression coverage for authoritative Python CI validation."""

import re
from pathlib import Path


_WORKFLOW = (
    Path(__file__).resolve().parent.parent / ".github" / "workflows" / "ci.yml"
)


def _indented_block(text: str, heading: str, indent: int) -> str:
    pattern = re.compile(
        rf"(?ms)^{' ' * indent}{re.escape(heading)}:\n"
        rf"(?P<body>(?:(?:{' ' * (indent + 2)}.*|\s*)\n)*)"
    )
    match = pattern.search(text)
    assert match is not None, f"missing {heading!r} block"
    return match.group(0)


def test_ci_runs_on_integrated_dev_pushes():
    workflow = _WORKFLOW.read_text()
    push = _indented_block(workflow, "push", 2)

    assert re.search(r"(?m)^    branches:\s*\[main,\s*dev\]\s*$", push)
    assert "paths-ignore:" not in push


def test_python_tests_are_authoritative():
    workflow = _WORKFLOW.read_text()
    python_tests = _indented_block(workflow, "python-tests", 2)

    assert "python -m pytest -q" in python_tests
    assert "continue-on-error:" not in python_tests


def test_manual_run_does_not_skip_tests_after_a_docs_commit(tmp_path):
    import os
    import subprocess
    import textwrap

    workflow = _WORKFLOW.read_text()
    step = workflow.split("      - name: Check for docs-only changes\n", 1)[1]
    script = step.split("        run: |\n", 1)[1].split("\n      - uses:", 1)[0]
    script = re.sub(r"\$\{\{\s*github.event_name\s*\}\}", "workflow_dispatch", script)
    script = re.sub(r"\$\{\{.*?\}\}", "unused", script)
    output = tmp_path / "outputs"
    # No Git repository is available: manual validation must bypass change
    # detection rather than accidentally treating the last commit as docs-only.
    result = subprocess.run(["bash", "-e", "-c", textwrap.dedent(script)],
                            cwd=tmp_path, env={**os.environ, "GITHUB_OUTPUT": str(output)},
                            capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert output.read_text().strip() == "docs_only=false"
