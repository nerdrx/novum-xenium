# Coding-agent comparison

`scripts/coding_agent_comparison.py` runs one Novum adapter and one Aider
adapter on byte-identical starting workspaces. Each gets its own writable
copy. The runner records the requested model, shared endpoint, declared
settings, chosen run order, command durations, exit codes, actual acceptance-test results, and
an operator-editable manual-intervention field. It does not save agent output
or copy environment variables into the report.

## Current host check

On this host, `command -v aider` found no system Aider executable. Aider 0.86.2
is installed in the isolated venv
`/tmp/nx-coding-agent-comparison-aider-venv`; system Python was not changed.
The venv uses the bundled Python 3.12.14. `aider --version` and a help-only
check passed. An initial live wiring run is recorded in `evaluations/coding-wiring-20261013.json`; its limitations prevent treating it as a fair checked-workflow comparison.

## Task and evidence

Both agents receive `TASK.md`, which explicitly names the `add` function in `calc.py`, and the same initial `calc.py`, where `add(a, b)`
incorrectly subtracts. The fixed acceptance command checks positive, negative,
zero, and negative-pair inputs. The initial fixture fails that command. A task
counts as passing only when its real acceptance check passes; the adapter exit
status is also recorded. The harness never patches generated code.

## Configure and run

Use a fresh output directory for every run. Supply adapter invocations that
start each agent in its current working directory, send it the task, and wait
for completion. The command is split into argv tokens and launched without a
shell. These placeholders are available in each command:

| Placeholder | Value |
| --- | --- |
| `{workspace}` | That agent's isolated working directory |
| `{task_file}` | Absolute path to its `TASK.md` |
| `{prompt}` | Task text |
| `{model}` | Shared declared model name |
| `{endpoint}` | Shared non-secret HTTP(S) endpoint |
| `{settings_json}` | Shared declared settings JSON |

Use `--order aider-first` to run Aider before Novum; the default is
`--order novum-first`. The selected order is recorded in `report.json`.

The same values are also provided to both commands as
`CODING_AGENT_COMPARISON_MODEL`, `CODING_AGENT_COMPARISON_ENDPOINT`, and
`CODING_AGENT_COMPARISON_SETTINGS_JSON`. Use each agent/provider's documented
configuration to connect to the chosen endpoint and honor these settings.
Credentials must come from the process environment or an existing local
config; do not put secrets in command arguments, settings JSON, or endpoint
URLs. The report keeps the command template and endpoint, so treat it as a
local experiment record.

Example shape (replace adapter paths/options with the installed integrations):

```bash
python scripts/coding_agent_comparison.py \
  --model 'qwen3.5:9b' \
  --endpoint 'http://127.0.0.1:11434' \
  --settings-json '{"temperature":0,"top_p":1}' \
  --novum-command 'python /path/to/novum_adapter.py --workspace {workspace} --task {task_file} --model {model} --endpoint {endpoint} --settings {settings_json}' \
  --aider-command 'python /path/to/aider_adapter.py --workspace {workspace} --task {task_file} --model {model} --endpoint {endpoint} --settings {settings_json}' \
  --output-dir /tmp/agent-comparison-run-001
```

Use the bundled adapter for Aider by replacing the sample Aider command with:

```bash
--aider-command '/tmp/nx-coding-agent-comparison-aider-venv/bin/python /run/media/nerdrx/Lex/novum-xenium/scripts/coding_comparison_aider.py --task-file {task_file} --model {model} --endpoint {endpoint} --settings-json {settings_json} --provider ollama --aider-bin /tmp/nx-coding-agent-comparison-aider-venv/bin/aider'
```

For OpenAI-compatible servers whose advertised model ID differs from the
comparison's logical model name, pass `--endpoint-model ID` to the Aider
adapter. The Novum adapter accepts `--preset-id ID`; it sends that preset with
the chat request and includes the selected ID in its metadata record.

The Novum adapter uses the app API and requires the explicit host-to-container
workspace mapping. Provide the app session cookie through `ODYSSEUS_SESSION`
in the environment; never place it in the command or report. For example, the
Novum command template has this shape (replace the container path mapping for
the mounted fixture):

```text
python /run/media/nerdrx/Lex/novum-xenium/scripts/coding_comparison_novum.py --task-file {task_file} --host-workspace {workspace} --container-workspace /workspace/path/to/this/fixture --api-base http://127.0.0.1:7000 --endpoint-id ENDPOINT_ID --model {model}
```

It creates a session, streams the task in agent mode, and prints one JSON
metadata record with session ID, run ID, actual route, bounded outcome evidence, and status; it does not save model output. Stream termination alone never counts as verified completion. External acceptance results remain separate from the agent's own completion status. If Novum pauses for tool approval, the adapter reports
`approval_needed` without approving it. On timeout it stops only the run ID
received for that session. Verify the app's live endpoint/model mapping before
running. The current app stream route obtains generation temperature from the
selected preset, rather than accepting per-request `temperature` or `top_p`;
matching generation settings with Aider requires a Novum preset that matches
Aider's declared settings. Defaults can differ between the two integrations,
so a defaults-only comparison does not establish matching settings.

The adapter follows Aider's documented `ollama_chat/<model>` naming and
`OLLAMA_API_BASE` endpoint setting. Use `--provider openai-compatible` for an
OpenAI-compatible endpoint instead; adapter then uses `openai/<model>` and
`OPENAI_API_BASE`. Required provider keys can remain in the caller's process
environment; the adapter passes only that provider's standard API-key variable
to Aider. It drops unrelated caller variables. If endpoint access needs another
variable, add an explicit `--pass-env NAME` to the Aider command. No key value
is written to the temporary config or report.
The adapter puts the shared settings JSON into Aider's temporary model settings
as LiteLLM `extra_params`. Provider-specific fields may differ; endpoint may
reject unsupported parameters. Aider's prompts and editing behavior remain
agent-specific, so matching the model and API parameters does not prove identical
internal prompts.

Novum's existing evaluator selects an app endpoint by ID; that ID is not a raw
provider URL for Aider. Supply the underlying Ollama or OpenAI-compatible URL
explicitly, and verify the endpoint's current model mapping before a comparison.

The adapter creates a temporary Aider home, config, and history paths, disables
automatic commits and Git integration, and uses `--message-file` for one-shot
task execution. Temporary files are removed when Aider exits.

The adapter commands above are examples only; they do not claim that either
agent was run. The endpoint must not contain credentials,
query parameters, or a fragment. `--settings-json` must be a JSON object with
non-secret fields. `--timeout` sets the per-agent wall-clock limit (default
600 seconds). The adapter passes only the chosen provider's standard API-key
variable plus explicit `--pass-env NAME` values to Aider; unrelated caller
environment variables are dropped. Neither key values nor those variables are
written to `report.json`.

Aider CLI details follow its official [installation](https://aider.chat/docs/install.html),
[Ollama](https://aider.chat/docs/llms/ollama.html),
[scripting](https://aider.chat/docs/scripting.html),
[options](https://aider.chat/docs/config/options.html), and
[advanced model settings](https://aider.chat/docs/config/adv-model-settings.html)
documentation.

Review `report.json` and the two saved workspaces. `seconds` is measured around
each agent process, and `acceptance_returncode` is the actual checker result.
After observing the runs, fill each result's `manual_interventions.count` and
`notes`; leave `operator_recorded` false when nobody observed or can attest to
the count. Do not treat an empty intervention field as proof of zero.

## Limits

This is one small, deterministic Python repair. It helps check wiring and
compare this narrow task, but cannot establish general coding ability, tool
quality, or repeatability. It does not verify that an adapter actually used
the reported model/settings; confirm those in the serving agent and model
endpoint. Larger claims need a predeclared task suite, repeated trials, and
separate review of tool-use behavior. No larger evaluation is included here.
