"""Execute terminal stream-error classification under Node."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest


_REPO = Path(__file__).resolve().parents[1]
_MODULE = (_REPO / "static" / "js" / "chatStreamErrors.js").as_uri()


def test_terminal_provider_errors_preserve_text_and_never_auto_retry():
    if not shutil.which("node"):
        pytest.skip("node is not installed")

    script = f"""
      import {{ createTerminalStreamError, isRecoverableStreamError, isUnsupportedToolCapabilityError }} from {json.dumps(_MODULE)};
      const stringError = createTerminalStreamError({{ status: 401, error: 'invalid key' }});
      const objectError = createTerminalStreamError({{ status: 404, error: {{ message: 'model missing' }} }});
      const explained = createTerminalStreamError({{ status: 504, error: 'Read timeout', hint: 'No data arrived. Check the model service and retry.' }});
      console.log(JSON.stringify({{
        stringMessage: stringError.message,
        objectMessage: objectError.message,
        explainedMessage: explained.message,
        explainedRecoverable: isRecoverableStreamError(explained),
        terminalRecoverable: isRecoverableStreamError(stringError),
        eofRecoverable: isRecoverableStreamError(new Error('Stream closed before completion')),
        networkRecoverable: isRecoverableStreamError(new TypeError('fetch failed')),
        unsupported400: isUnsupportedToolCapabilityError(400, 'The model does not support tools'),
        unsupported422: isUnsupportedToolCapabilityError(422, 'Function calling is not supported'),
        toolExecutionError: isUnsupportedToolCapabilityError(500, 'Tool execution failed; automatic retry stopped'),
        unrelatedToolMention: isUnsupportedToolCapabilityError(400, 'Tool budget exceeded'),
        malformedCall: isUnsupportedToolCapabilityError(400, 'Invalid tool call arguments: expected a JSON object'),
        invalidSchema: isUnsupportedToolCapabilityError(422, 'Invalid tool schema: required field has no matching property'),
      }}));
    """
    result = subprocess.run(
        ["node", "--input-type=module"],
        input=script,
        capture_output=True,
        text=True,
        cwd=_REPO,
        timeout=30,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {
        "stringMessage": "invalid key",
        "objectMessage": "model missing",
        "explainedMessage": "Read timeout\nNo data arrived. Check the model service and retry.",
        "explainedRecoverable": False,
        "terminalRecoverable": False,
        "eofRecoverable": True,
        "networkRecoverable": True,
        "unsupported400": True,
        "unsupported422": True,
        "toolExecutionError": False,
        "unrelatedToolMention": False,
        "malformedCall": False,
        "invalidSchema": False,
    }
