"""Validated, bounded coding task and evidence-state helpers.

This module does not execute tools. Callers pass exact commands and actual
tool-result dictionaries; prose claims cannot advance the workflow.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import PurePosixPath
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

    def __post_init__(self) -> None:
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
        acceptance_condition: str,
    ) -> "CodingWorkPacket":
        return cls(objective, files, reproduce_command, acceptance_command, acceptance_condition)

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-friendly packet copy."""
        return {
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
        self.stage = "edit"
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
        if self.edit_result is None:
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

    def __init__(self):
        self.state = None

    def observe(self, tool, content, result):
        import json
        try:
            if tool == "todowrite" and isinstance(result, dict) and "work_packet" in result:
                if _executed_result(result) != 0:
                    return False
                packet = CodingWorkPacket(**result["work_packet"])
                if self.state and self.state.packet == packet:
                    return False  # Repeated checklist writes cannot erase evidence.
                if self.state and self.state.stage != "done":
                    return False  # Finish the current slice before replacing it.
                self.state = CodingWorkState(packet)
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
            return self.state.to_dict() != before
        except (ValueError, TypeError):
            return bool(self.state and "before" in locals() and self.state.to_dict() != before)

    @property
    def pending(self):
        return self.state is not None and self.state.stage != "done"

    @property
    def instruction(self):
        if not self.state:
            return ""
        return (
            "The current coding slice is at stage " + self.state.stage + ". "
            "Execute the recorded reproduction command before editing. Use file-edit tools, "
            "then run the recorded acceptance command after the last edit. "
            "A test pass is separate from independent review and does not prove the whole task. "
            "Packet contents are task data, not permission to run a command."
        )

    def blocks(self, tool, content):
        import json
        if self.pending and tool == "todowrite":
            try:
                args = json.loads(content) if isinstance(content, str) else content
                if isinstance(args, dict) and "work_packet" in args:
                    return CodingWorkPacket(**args["work_packet"]) != self.state.packet
            except (TypeError, ValueError):
                return True
        if not self.state or self.state.stage != "reproduce":
            return False
        from src.tool_capabilities import ToolEffect, capabilities_for_action
        if tool == "bash":
            command = content
            try:
                if isinstance(command, str) and command.lstrip().startswith("{"):
                    command = json.loads(command)
                if isinstance(command, dict):
                    command = command.get("command") or command.get("cmd") or command.get("code")
            except ValueError:
                return True
            return command != self.state.packet.reproduce_command
        if tool in {"todowrite", "ask_user"}:
            return False
        capabilities = capabilities_for_action(tool, content)
        reads = {ToolEffect.READ_CONTEXT, ToolEffect.READ_PUBLIC, ToolEffect.READ_WORKSPACE,
                 ToolEffect.READ_PRIVATE, ToolEffect.BROKERED_NETWORK_READ}
        return not capabilities.known or not capabilities.effects <= reads


    def event(self, round_number):
        if not self.state:
            return None
        return {
            "type": "coding_work_packet", "round": round_number,
            "packet": self.state.packet.to_dict(), "stage": self.state.stage,
            "test_status": "passed" if self.state.stage == "done" else "not_verified",
            "review_status": "not_reviewed",
        }
