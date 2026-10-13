"""Validated, bounded coding task and evidence-state helpers.

This module does not execute tools. Callers pass exact commands and actual
tool-result dictionaries; prose claims cannot advance the workflow.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

_MAX_OBJECTIVE = 1_000
_MAX_FILE_COUNT = 32
_MAX_FILE_PATH = 300
_MAX_COMMAND = 1_000
_MAX_CONDITION = 1_000
_EDIT_TOOLS = frozenset({"write_file", "edit_file", "apply_patch"})
_NON_EXECUTION_STATES = frozenset({
    "pending", "blocked", "approval_required", "awaiting_approval", "running", "queued",
})


def normalize_work_packet_paths(packet: Any, workspace: str | None) -> dict[str, Any]:
    """Copy packet data and canonicalize workspace-contained file paths."""
    if not isinstance(packet, dict) or not isinstance(packet.get("files"), (list, tuple)):
        raise ValueError("work_packet files must be a list")
    root = None
    if workspace:
        try:
            root = Path(workspace).resolve(strict=True)
        except (OSError, RuntimeError, TypeError, ValueError) as exc:
            raise ValueError("workspace is unavailable") from exc
        if not root.is_dir():
            raise ValueError("workspace must be a directory")
    files = []
    for raw in packet["files"]:
        raw = _text(raw, "file path", _MAX_FILE_PATH)
        if "\\" in raw:
            raise ValueError("file paths must be valid POSIX paths")
        parts = raw.split("/")
        if raw.startswith("/"):
            parts = parts[1:]
        if (not parts or any(part in {"", ".", ".."} for part in parts)
                or PurePosixPath(raw).as_posix() != raw):
            raise ValueError("file paths must not contain traversal components")
        if raw.startswith("/") and root is None:
            raise ValueError("absolute file paths require an explicit workspace")
        if root is not None:
            try:
                relative = (Path(raw) if raw.startswith("/") else root / raw).resolve(
                    strict=False
                ).relative_to(root).as_posix()
            except (OSError, RuntimeError, ValueError) as exc:
                raise ValueError("file path is outside the workspace") from exc
            raw = relative
        files.append(raw)
    normalized = dict(packet)
    normalized["files"] = files
    return normalized


def _text(value: Any, field_name: str, limit: int) -> str:
    if not isinstance(value, str) or not value.strip() or value != value.strip() or len(value) > limit:
        raise ValueError(f"{field_name} must be non-empty, trimmed text of at most {limit} characters")
    if "\x00" in value:
        raise ValueError(f"{field_name} must not contain NUL")
    return value


def _command(value: Any, field_name: str) -> str:
    command = _text(value, field_name, _MAX_COMMAND)
    if "\n" in command or "\r" in command:
        raise ValueError(f"{field_name} must be one exact, single-line command")
    return command


@dataclass(frozen=True)
class CodingWorkPacket:
    """Small contract for one reproducible code change."""

    objective: str
    files: tuple[str, ...]
    reproduce_command: str
    acceptance_command: str
    acceptance_condition: str
    mode: str = "change"

    def __post_init__(self) -> None:
        if not isinstance(self.mode, str) or self.mode not in {"change", "verify_existing"}:
            raise ValueError("mode must be change or verify_existing")
        object.__setattr__(self, "objective", _text(self.objective, "objective", _MAX_OBJECTIVE))
        if not isinstance(self.files, (list, tuple)) or not 1 <= len(self.files) <= _MAX_FILE_COUNT:
            raise ValueError(f"files must contain 1 to {_MAX_FILE_COUNT} project-relative paths")
        checked_files = []
        for raw in self.files:
            path = _text(raw, "file path", _MAX_FILE_PATH)
            if "\\" in path or path.startswith("/") or PurePosixPath(path).is_absolute():
                raise ValueError("file paths must be relative POSIX paths")
            parts = PurePosixPath(path).parts
            if (not parts or PurePosixPath(path).as_posix() != path
                    or any(part in {"", ".", ".."} for part in parts)):
                raise ValueError("file paths must not contain traversal components")
            if path.casefold() in {item.casefold() for item in checked_files}:
                raise ValueError("file paths must be unique")
            checked_files.append(path)
        object.__setattr__(self, "files", tuple(checked_files))
        object.__setattr__(self, "reproduce_command", _command(self.reproduce_command, "reproduce_command"))
        object.__setattr__(self, "acceptance_command", _command(self.acceptance_command, "acceptance_command"))
        object.__setattr__(self, "acceptance_condition", _text(self.acceptance_condition, "acceptance_condition", _MAX_CONDITION))

    @classmethod
    def create(
        cls, objective: str, files: list[str] | tuple[str, ...],
        reproduce_command: str, acceptance_command: str,
        acceptance_condition: str, mode: str = "change",
    ) -> "CodingWorkPacket":
        return cls(objective, files, reproduce_command, acceptance_command, acceptance_condition, mode)

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-friendly packet copy."""
        return {
            **({"mode": self.mode} if self.mode != "change" else {}),
            "objective": self.objective,
            "files": list(self.files),
            "reproduce_command": self.reproduce_command,
            "acceptance_command": self.acceptance_command,
            "acceptance_condition": self.acceptance_condition,
        }


def _executed_result(result: Any) -> int:
    """Return an actual command exit code; reject queued or blocked outcomes."""
    if not isinstance(result, dict):
        raise ValueError("tool result must be an object")
    status = result.get("status")
    if (result.get("error") or result.get("approval_required") or result.get("pending")
            or result.get("blocked") or (isinstance(status, str) and status.casefold() in _NON_EXECUTION_STATES)):
        raise ValueError("tool result did not execute")
    code = result.get("exit_code")
    if isinstance(code, bool) or not isinstance(code, int):
        raise ValueError("tool result must include an integer exit_code")
    return code


@dataclass
class CodingWorkState:
    """Evidence-driven stages: reproduce → edit → verify → done.

    A failed reproduction is useful evidence and advances to edit. Acceptance
    must run successfully after a successful file edit. Any later successful
    edit clears acceptance evidence and returns the packet to verify.
    """

    packet: CodingWorkPacket
    stage: str = "reproduce"
    reproduction_result: dict[str, Any] | None = None
    edit_result: dict[str, Any] | None = None
    acceptance_result: dict[str, Any] | None = None

    def record_reproduction(self, command: str, result: dict[str, Any]) -> str:
        command = _command(command, "command")
        if command != self.packet.reproduce_command:
            raise ValueError("reproduction command does not exactly match the packet")
        _executed_result(result)  # Any integer exit code, including failure, is evidence.
        self.reproduction_result = dict(result)
        self.edit_result = None
        self.acceptance_result = None
        self.stage = "verify" if self.packet.mode == "verify_existing" and result["exit_code"] == 0 else "edit"
        return self.stage

    def record_edit(self, tool: str, result: dict[str, Any]) -> str:
        if self.reproduction_result is None:
            raise ValueError("reproduction evidence is required before editing")
        if tool not in _EDIT_TOOLS:
            raise ValueError("edit evidence must come from a supported file-edit tool")
        code = _executed_result(result)
        if code == 0:
            self.edit_result = dict(result)
            self.edit_result["tool"] = tool
            self.acceptance_result = None
            self.stage = "verify"
        return self.stage

    def record_acceptance(self, command: str, result: dict[str, Any]) -> str:
        if self.edit_result is None and not (
            self.packet.mode == "verify_existing" and self.reproduction_result is not None
            and _executed_result(self.reproduction_result) == 0
        ):
            raise ValueError("a successful edit is required before acceptance")
        command = _command(command, "command")
        if command != self.packet.acceptance_command:
            raise ValueError("acceptance command does not exactly match the packet")
        code = _executed_result(result)
        self.acceptance_result = dict(result)
        self.stage = "done" if code == 0 else "verify"
        return self.stage

    def to_dict(self) -> dict[str, Any]:
        """Return current state and evidence for prompt or checkpoint storage."""
        return {
            "stage": self.stage,
            "reproduction_result": dict(self.reproduction_result) if self.reproduction_result is not None else None,
            "edit_result": dict(self.edit_result) if self.edit_result is not None else None,
            "acceptance_result": dict(self.acceptance_result) if self.acceptance_result is not None else None,
        }


class CodingWorkTracker:
    """Run-local packet evidence. Tool proposals never count as execution."""

    def __init__(self, enabled=False, workspace=None):
        self.enabled = bool(enabled)
        self.workspace = workspace
        self.state = None
        self.review_status = "not_reviewed"
        self.milestones = ()
        self.completed = set()
        self.current_milestone = None

    def checkpoint_data(self):
        """Return bounded evidence observed by this server-side tracker."""
        if not self.state:
            return None
        state = self.state
        return {
            "version": 1,
            "enabled": self.enabled,
            "packet": state.packet.to_dict(),
            "stage": state.stage,
            "reproduction_exit_code": (
                state.reproduction_result.get("exit_code") if state.reproduction_result else None
            ),
            "edit_tool": state.edit_result.get("tool") if state.edit_result else None,
            "acceptance_exit_code": (
                state.acceptance_result.get("exit_code") if state.acceptance_result else None
            ),
            "milestones": list(self.milestones),
            "completed": sorted(self.completed),
            "current_milestone": self.current_milestone,
            "review_status": self.review_status,
        }

    def check_command(self, arguments):
        """Resolve the no-argument alias to the packet's registered command."""
        import json

        if isinstance(arguments, str):
            if not arguments.strip():
                args = {}
            else:
                try:
                    args = json.loads(arguments)
                except (TypeError, ValueError):
                    return None, "run_coding_check takes no arguments; use an empty object."
        else:
            args = arguments
        if args != {}:
            return None, "run_coding_check takes no arguments; use an empty object."
        if not self.enabled or not self.state:
            return None, "run_coding_check requires an active checked coding packet."
        if self.state.stage == "reproduce":
            return self.state.packet.reproduce_command, None
        if self.state.stage == "verify":
            return self.state.packet.acceptance_command, None
        return None, f"run_coding_check is unavailable during the {self.state.stage} stage."

    def restore_checkpoint(self, data, *, recovery=False):
        """Restore only a validated server checkpoint; unsafe evidence restarts reproduction."""
        if not isinstance(data, dict):
            return "missing"
        if not self.enabled:
            return "ineligible"
        if data.get("version") != 1 or data.get("enabled") is not True:
            return "invalid"
        try:
            packet = CodingWorkPacket(**data["packet"])
        except (KeyError, TypeError, ValueError):
            return "invalid"

        self.state = CodingWorkState(packet)
        stage = data.get("stage")
        reproduction = data.get("reproduction_exit_code")
        edit_tool = data.get("edit_tool")
        acceptance = data.get("acceptance_exit_code")
        valid_code = lambda value: type(value) is int
        milestones = data.get("milestones")
        completed = data.get("completed")
        current = data.get("current_milestone")
        valid_milestones = (
            isinstance(milestones, list) and 0 < len(milestones) <= 20
            and all(isinstance(item, str) and item and len(item) <= 500 for item in milestones)
            and len(set(milestones)) == len(milestones)
            and isinstance(completed, list) and all(item in milestones for item in completed)
            and isinstance(current, str) and current in milestones
            and (stage != "done" or current in completed)
        )
        verified_existing = packet.mode == "verify_existing" and type(reproduction) is int and reproduction == 0 and edit_tool is None
        edited = isinstance(edit_tool, str) and edit_tool in _EDIT_TOOLS
        checklist_ok = not self.enabled or valid_milestones
        safe = checklist_ok and stage == "reproduce" and reproduction is None and edit_tool is None and acceptance is None
        if checklist_ok and stage == "edit" and valid_code(reproduction) and edit_tool is None and acceptance is None:
            safe = True
            self.state.reproduction_result = {"exit_code": reproduction}
        elif (checklist_ok and stage == "verify" and valid_code(reproduction)
              and (edited or verified_existing)
              and (acceptance is None or (valid_code(acceptance) and acceptance != 0))):
            safe = True
            self.state.reproduction_result = {"exit_code": reproduction}
            self.state.edit_result = {"exit_code": 0, "tool": edit_tool} if edited else None
            if acceptance is not None:
                self.state.acceptance_result = {"exit_code": acceptance}
        elif (checklist_ok and stage == "done" and valid_code(reproduction)
              and (edited or verified_existing)
              and valid_code(acceptance) and acceptance == 0):
            safe = True
            self.state.reproduction_result = {"exit_code": reproduction}
            self.state.edit_result = {"exit_code": 0, "tool": edit_tool} if edited else None
            self.state.acceptance_result = {"exit_code": 0}
        if recovery and stage == "done":
            safe = False
        if safe:
            self.state.stage = stage
        else:
            self.state = CodingWorkState(packet)

        if self.enabled and valid_milestones:
            self.milestones = tuple(milestones)
            self.completed = set(completed)
            self.current_milestone = current
            if not safe and current:
                self.completed.discard(current)
        status = data.get("review_status")
        self.review_status = (
            status if self.state.stage == "done"
            and isinstance(status, str)
            and status in {"passed", "failed", "unverified", "not_reviewed"}
            else "not_reviewed"
        )
        return "restored" if safe else "reset"

    def record_review(self, issues):
        """Record an actual independent reviewer result for a completed packet."""
        if not self.state or self.state.stage != "done":
            return False
        if not isinstance(issues, list):
            self.review_status = "unverified"
        elif not issues:
            self.review_status = "passed"
        elif all(isinstance(issue, str) and issue.startswith("Failed:") for issue in issues):
            self.review_status = "failed"
        else:
            self.review_status = "unverified"
        return True

    def valid_todo_update(self, args):
        if not self.enabled:
            return True
        if not isinstance(args, dict) or not isinstance(args.get("todos"), list):
            return False
        todos = args["todos"]
        names = [item.get("content") for item in todos if isinstance(item, dict)]
        if (len(names) != len(todos) or not names or any(not isinstance(n, str) or not n for n in names)
                or len(set(names)) != len(names)):
            return False
        if self.milestones and tuple(names) != self.milestones:
            return False
        if any(item.get("status") == "completed" and item["content"] not in self.completed for item in todos):
            return False
        active = [item["content"] for item in todos if item.get("status") == "in_progress"]
        if "work_packet" in args:
            if len(active) != 1 or active[0] in self.completed:
                return False
            if self.current_milestone and self.state and self.state.stage != "done" and active[0] != self.current_milestone:
                return False
        return True

    def _can_revise_failed_acceptance(self, packet):
        state = self.state
        result = state.acceptance_result if state else None
        if (not self.enabled or not state or state.stage != "verify"
                or state.reproduction_result is None
                or not (state.edit_result is not None or (
                    state.packet.mode == "verify_existing"
                    and _executed_result(state.reproduction_result) == 0
                ))):
            return False
        try:
            if _executed_result(result) == 0:
                return False
        except ValueError:
            return False
        previous = state.packet.to_dict()
        revised = packet.to_dict()
        if previous["acceptance_command"] == revised["acceptance_command"]:
            return False
        previous.pop("acceptance_command")
        revised.pop("acceptance_command")
        return previous == revised

    def observe(self, tool, content, result):
        import json
        try:
            if tool == "todowrite" and isinstance(result, dict) and "work_packet" in result:
                if _executed_result(result) != 0:
                    return False
                if not self.valid_todo_update(result):
                    return False
                packet = CodingWorkPacket(**normalize_work_packet_paths(result["work_packet"], self.workspace))
                if self.state and self.state.packet == packet:
                    return False  # Repeated checklist writes cannot erase evidence.
                if self.state and self.state.stage != "done":
                    if not self._can_revise_failed_acceptance(packet):
                        return False  # Finish the current slice before replacing it.
                    self.state.packet = packet
                    self.state.acceptance_result = None
                    self.review_status = "not_reviewed"
                    return True
                self.state = CodingWorkState(packet)
                self.review_status = "not_reviewed"
                if self.enabled:
                    self.milestones = self.milestones or tuple(item["content"] for item in result["todos"])
                    self.current_milestone = next(item["content"] for item in result["todos"] if item["status"] == "in_progress")
                return True
            if not self.state:
                return False
            before = self.state.to_dict()
            if (self.state.stage == "done" and tool in (_EDIT_TOOLS | {"bash", "python"})
                    and isinstance(result, dict) and type(result.get("exit_code")) is int
                    and not result.get("blocked") and not result.get("approval_required")):
                # Even a failed command can leave partial edits behind.
                self.state.acceptance_result = None
                self.state.stage = "verify"
            if tool == "bash":
                command = content
                if isinstance(content, str) and content.lstrip().startswith("{"):
                    command = json.loads(content)
                if isinstance(command, dict):
                    command = command.get("command") or command.get("cmd") or command.get("code")
                if self.state.stage == "reproduce":
                    self.state.record_reproduction(command, result)
                elif command == self.state.packet.acceptance_command:
                    self.state.record_acceptance(command, result)
                elif _executed_result(result) == 0 and self.state.edit_result is not None:
                    # Arbitrary shell commands might edit files; invalidate an
                    # earlier pass rather than pretending it still proves them.
                    self.state.acceptance_result = None
                    self.state.stage = "verify"
            elif tool in _EDIT_TOOLS:
                self.state.record_edit(tool, result)
            if self.enabled and self.current_milestone:
                if self.state.stage == "done":
                    self.completed.add(self.current_milestone)
                else:
                    self.completed.discard(self.current_milestone)
            if self.state.stage != "done":
                self.review_status = "not_reviewed"
            return self.state.to_dict() != before
        except (ValueError, TypeError):
            if self.enabled and self.current_milestone and self.state.stage != "done":
                self.completed.discard(self.current_milestone)
            return bool(self.state and "before" in locals() and self.state.to_dict() != before)

    @property
    def pending(self):
        return ((self.enabled and (not self.milestones or set(self.milestones) != self.completed))
                or (self.state is not None and self.state.stage != "done"))

    @property
    def instruction(self):
        if self.enabled and self.milestones and self.state and self.state.stage == "done" and self.pending:
            import json

            next_slice = next(name for name in self.milestones if name not in self.completed)
            todos = [{"content": name, "status": (
                "completed" if name in self.completed else
                "in_progress" if name == next_slice else "pending"
            )} for name in self.milestones]
            return (
                "The current slice passed. The task still has unchecked slices. Call todowrite now "
                "with this exact todos list and a new work_packet for " + json.dumps(next_slice) + ":\n"
                + json.dumps({"todos": todos}) + "\n"
                "Add work_packet with objective, files, reproduce_command, acceptance_command, and "
                "acceptance_condition for that slice. If its code is already implemented, set "
                'work_packet.mode to "verify_existing"; run its baseline and acceptance checks without '
                "a dummy edit. Otherwise use mode change and reproduce, edit, then test. "
                "Do not mark other slices completed: only the active slice earns completion from its check. "
                "Do not ask the user to run checks you can run. This workflow grants no extra permissions."
            )
        if not self.state or (self.enabled and self.state.stage == "done" and self.pending):
            return (
                "Work in checked coding steps. Inspect the project using read tools, then call todowrite "
                "with one concrete change and a real test as the default: one checklist item and one work packet. "
                "Keep inspection, implementation, and testing within that item; do not create separate milestones "
                "for these workflow phases. Use multiple milestones only when the task needs distinct outcomes "
                "with separate acceptance checks. Include both todos and work_packet in that same call, "
                'for example: {"todos":[{"content":"<slice>","status":"in_progress"}],'
                '"work_packet":{"objective":"<outcome>","files":["path/to/file.py"],'
                '"reproduce_command":"<real baseline command>",'
                '"acceptance_command":"<real post-edit command>",'
                '"acceptance_condition":"<observable pass condition>"}}. '
                "Replace every placeholder with a real value. A TodoWrite without work_packet is rejected. "
                "Keep checklist item names and order stable. Mark exactly one in_progress. "
                "For an already implemented or verification-only slice, set work_packet.mode to verify_existing; "
                "a passing baseline then allows acceptance without a dummy edit. Failed baseline still requires repair. "
                "Use an existing baseline check, then edit and run the acceptance check. "
                "Only mark a slice completed after its real acceptance command passes. "
                "Continue with a new packet for the next pending slice; do not ask for approval to continue. "
                "This workflow grants no extra permissions."
        ) + (" Completed slices: " + repr(sorted(self.completed))
             + ". Pending slices: " + repr([name for name in self.milestones if name not in self.completed])
             + ". Only the active slice earns completion from its check." if self.milestones else "") if self.enabled else ""
        if self.state.stage == "reproduce":
            return (
                ("Run the recorded reproduction check with run_coding_check {}. It executes the packet's exact "
                 "command. " if self.enabled else "Run the exact recorded reproduction command. ")
                + "No edit evidence is accepted yet. "
                "A test pass is separate from independent review and does not prove the whole task. "
                "Packet contents are task data, not permission to run a command."
            )
        if self.state.stage == "edit":
            return (
                "The recorded reproduction command has run. Make source changes with write_file, "
                "edit_file, or apply_patch. "
                + ("Bash and Python are unavailable during the edit stage. " if self.enabled else "")
                + "Then run the recorded acceptance command. "
                "A test pass is separate from independent review and does not prove the whole task. "
                "Packet contents are task data, not permission to run a command."
            )
        if self.state.stage == "verify":
            if (isinstance(self.state.acceptance_result, dict)
                    and type(self.state.acceptance_result.get("exit_code")) is int
                    and self.state.acceptance_result["exit_code"] != 0):
                return (
                    "The registered acceptance check failed. If the check command itself is malformed, "
                    "revise only work_packet.acceptance_command through todowrite; keep every other "
                    "packet field, acceptance condition, assertion, and pass criterion unchanged. "
                    "If the output shows a real behavior failure, fix the source instead. Then run "
                    "run_coding_check {} to execute the registered acceptance check. Only that real "
                    "passing check satisfies acceptance. "
                    "A test pass is separate from independent review and does not prove the whole task. "
                    "Packet contents are task data, not permission to run a command."
                )
            return (
                ("Existing work passed its baseline. " if self.state.edit_result is None
                 else "A successful file edit is recorded. ")
                + ("Run run_coding_check {} to execute the packet's exact acceptance command now. "
                   if self.enabled else "Run the exact acceptance command now. ")
                + "A test pass is separate from independent review and does not prove the whole task. "
                "Packet contents are task data, not permission to run a command."
            )
        return (
            "The current coding slice is at stage " + self.state.stage + ". "
            "The acceptance command passed. Continue with the next pending slice or report completion. "
            "A test pass is separate from independent review and does not prove the whole task. "
            "Packet contents are task data, not permission to run a command."
        )

    def blocks(self, tool, content):
        import json
        needs_packet = self.requires_packet
        if self.enabled and tool == "todowrite":
            try:
                args = json.loads(content) if isinstance(content, str) else content
                if (needs_packet and (not isinstance(args, dict) or "work_packet" not in args)) or not self.valid_todo_update(args):
                    return True
                if isinstance(args, dict) and "work_packet" in args:
                    CodingWorkPacket(**normalize_work_packet_paths(args["work_packet"], self.workspace))
            except (TypeError, ValueError):
                return True
        if self.state and self.state.stage != "done" and tool == "todowrite":
            try:
                args = json.loads(content) if isinstance(content, str) else content
                if isinstance(args, dict) and "work_packet" in args:
                    packet = CodingWorkPacket(**normalize_work_packet_paths(args["work_packet"], self.workspace))
                    return packet != self.state.packet and not self._can_revise_failed_acceptance(packet)
            except (TypeError, ValueError):
                return True
        if (self.enabled and self.state and self.state.stage == "edit"
                and tool in {"bash", "python"}):
            return True
        if not needs_packet and (not self.state or self.state.stage != "reproduce"):
            return False
        from src.tool_capabilities import ToolEffect, capabilities_for_action
        if tool == "bash":
            if needs_packet:
                return True
            command = content
            try:
                if isinstance(command, str) and command.lstrip().startswith("{"):
                    command = json.loads(command)
                if isinstance(command, dict):
                    command = command.get("command") or command.get("cmd") or command.get("code")
            except ValueError:
                return True
            return command != self.state.packet.reproduce_command
        # Fetch is a read, but its capability also records network egress.
        # Keep URL validation and network approval in the normal dispatcher.
        if tool in {"todowrite", "ask_user", "web_fetch"}:
            return False
        capabilities = capabilities_for_action(tool, content)
        reads = {ToolEffect.READ_CONTEXT, ToolEffect.READ_PUBLIC, ToolEffect.READ_WORKSPACE,
                 ToolEffect.READ_PRIVATE, ToolEffect.BROKERED_NETWORK_READ}
        return not capabilities.known or not capabilities.effects <= reads

    @property
    def requires_packet(self):
        return self.enabled and (not self.state or (self.state.stage == "done" and self.pending))


    def event(self, round_number):
        if not self.state:
            return None
        return {
            "type": "coding_work_packet", "round": round_number,
            "packet": self.state.packet.to_dict(), "stage": self.state.stage,
            "test_status": "passed" if self.state.stage == "done" else "not_verified",
            "review_status": self.review_status,
        }



def fresh_packet_context(messages, boundary):
    """Shape model input only; never mutate or delete saved conversation history.

    Keep every human instruction and trusted system message before the live
    boundary. Keep the whole suffix so native tool calls/results stay paired.
    The boundary is an opaque server-generated marker, never packet content.
    """
    if not boundary:
        return list(messages)
    index = next((i for i, message in enumerate(messages)
                  if message.get("_coding_packet_boundary") == boundary), None)
    if index is None:
        return list(messages)  # Compaction must not invent a new boundary.
    kept = []
    for message in messages[:index]:
        metadata = message.get("metadata") or {}
        if metadata.get("trusted") is False:
            continue
        if message.get("role") == "system":
            kept.append(message)
        elif message.get("role") == "user" and not message.get("_agent_injected"):
            content = message.get("content")
            if isinstance(content, str) and content.startswith("[Tool execution results]"):
                continue
            kept.append(message)
    return kept + list(messages[index:])
