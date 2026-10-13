"""Per-turn tool policy composition for agent execution."""

from __future__ import annotations

import json
import os
import re
import shlex
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Iterable, Mapping, Optional, Set, Tuple


GUIDE_ONLY_DIRECTIVE = (
    "## GUIDE-ONLY MODE - TOOL POLICY\n"
    "The latest user turn explicitly forbids tool use. Do not call tools, do not "
    "run shell commands, and do not inspect local files or the environment. "
    "Respond in normal text by guiding the user or asking them to paste the "
    "output they will produce locally."
)

WEB_TOOL_NAMES = frozenset({"web_search", "web_fetch"})


_GITHUB_REPOSITORY_RE = re.compile(r"\b(?:github(?:\.com)?|git\s*hub)\b.{0,100}\b(?:repos?|repositories)\b|\b(?:repos?|repositories)\b.{0,100}\b(?:github(?:\.com)?|git\s*hub)\b", re.I | re.S)
_PRIVATE_REPOSITORY_RE = re.compile(r"\bprivate\b.{0,100}\b(?:repos?|repositories)\b|\b(?:repos?|repositories)\b.{0,100}\bprivate\b", re.I | re.S)
_PUBLIC_OVERRIDE_RE = re.compile(
    r"\b(?:make|set|switch|change|use)\b.{0,60}"
    r"\b(?:github(?:\.com)?\s+)?(?:repos?|repositories|visibility)\b.{0,40}\bpublic\b"
    ,
    re.I | re.S,
)
_PUBLIC_NEGATION_RE = re.compile(
    r"\b(?:don't|do not|never|not|avoid|without|can't|cannot|shouldn't|should not)\b",
    re.I,
)


def _has_clear_public_repository_override(latest: str) -> bool:
    for match in _PUBLIC_OVERRIDE_RE.finditer(latest):
        before = latest[max(0, match.start() - 50):match.start()]
        after = latest[match.end():match.end() + 50]
        if _PUBLIC_NEGATION_RE.search(before) or _PUBLIC_NEGATION_RE.search(after):
            continue
        paired_quote = any(
            latest.rfind(opening, 0, match.start()) > latest.rfind(closing, 0, match.start())
            and latest.find(closing, match.end()) >= match.end()
            for opening, closing in (("“", "”"), ("‘", "’"))
        )
        same_quote = False
        for quote in ("\"", "`", "'"):
            before_match = latest[:match.start()]
            opening_positions = [
                index for index, char in enumerate(before_match)
                if char == quote and (index == 0 or before_match[index - 1] != "\\")
            ]
            if quote == "'":
                opening_positions = [
                    index for index in opening_positions
                    if index + 1 < len(latest)
                    and (index == 0 or not before_match[index - 1].isalnum())
                    and latest[index + 1].isspace() is False
                ]
            for opening_index in opening_positions:
                closing_index = next(
                    (index for index in range(match.end(), len(latest))
                     if latest[index] == quote
                     and (index == 0 or latest[index - 1] != "\\")),
                    -1,
                )
                if closing_index < 0:
                    continue
                if quote == "'" and closing_index + 1 < len(latest) and latest[closing_index + 1].isalnum():
                    continue
                if quote == "'" and latest[opening_index + 1].isspace():
                    continue
                same_quote = True
                break
            if same_quote:
                break
        if paired_quote or same_quote:
            continue
        return True
    return False


def github_private_repository_requested(
    task_anchor: object, latest_user_request: object = "",
) -> bool:
    """True only for an explicit private GitHub repository task constraint."""
    task = str(task_anchor or "")[:8_000]
    latest = str(latest_user_request or "")[:2_000]
    if _has_clear_public_repository_override(latest):
        return False
    return bool(
        _GITHUB_REPOSITORY_RE.search(task)
        and _PRIVATE_REPOSITORY_RE.search(task)
        and not re.search(
            r"\b(?:not|never|don't|do not|isn't|is not|shouldn't|should not)\s+(?:be\s+)?private\b",
            task,
            re.I,
        )
    )


def _shell_commands(command: str, depth: int = 0) -> list[list[str]]:
    """Split common shell chains, recursively unpacking `sh -c` arguments."""
    if depth > 3:
        return []
    lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|")
    lexer.whitespace_split = True
    lexer.commenters = ""
    tokens = list(lexer)
    commands: list[list[str]] = []
    current: list[str] = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token in {"bash", "sh", "zsh", "dash"} and index + 2 < len(tokens):
            if tokens[index + 1] in {"-c", "-lc", "-ec", "--command"}:
                commands.extend(_shell_commands(tokens[index + 2], depth + 1))
                index += 3
                continue
        if token and set(token) <= {";", "&", "|"}:
            if current:
                commands.append(current)
                current = []
        else:
            current.append(token)
        index += 1
    if current:
        commands.append(current)
    return commands


def _github_public_shell_action(command: str) -> str | None:
    try:
        commands = _shell_commands(str(command or "")[:16_000])
    except ValueError:
        return None
    for tokens in commands:
        for index, token in enumerate(tokens):
            if token.rsplit("/", 1)[-1] != "gh" or index + 2 >= len(tokens):
                continue
            subcommand_index = next(
                (
                    position
                    for position in range(index + 1, min(index + 8, len(tokens) - 1))
                    if tokens[position:position + 2]
                    in (["repo", "create"], ["repo", "edit"])
                ),
                None,
            )
            if subcommand_index is not None and tokens[subcommand_index:subcommand_index + 2] == ["repo", "create"]:
                options = tokens[subcommand_index + 2:]
                for option_index, option in enumerate(options):
                    if option == "--public" or option == "--visibility=public":
                        return "create"
                    if (option == "--visibility" and option_index + 1 < len(options)
                            and options[option_index + 1].casefold() == "public"):
                        return "create"
            if subcommand_index is not None and tokens[subcommand_index:subcommand_index + 2] == ["repo", "edit"]:
                options = tokens[subcommand_index + 2:]
                for option_index, option in enumerate(options):
                    if option == "--visibility=public":
                        return "visibility"
                    if (option == "--visibility" and option_index + 1 < len(options)
                            and options[option_index + 1].casefold() == "public"):
                        return "visibility"
            api_index = next(
                (
                    position
                    for position in range(index + 1, min(index + 8, len(tokens)))
                    if tokens[position] == "api"
                ),
                None,
            )
            if api_index is not None:
                args = tokens[api_index + 1:]
                endpoint = next((arg.split("?", 1)[0].lstrip("/") for arg in args
                                 if not arg.startswith("-") and "/" in arg), "")
                method = "POST" if any(
                    arg in {"-f", "-F", "--field", "--raw-field"}
                    or arg.startswith(("--field=", "--raw-field="))
                    for arg in args
                ) else "GET"
                for option_index, option in enumerate(args):
                    if option in {"-X", "--method"} and option_index + 1 < len(args):
                        method = args[option_index + 1].upper()
                    elif option.startswith("--method="):
                        method = option.split("=", 1)[1].upper()
                private_false = any(
                    re.fullmatch(r"(?:-f|--field|-F|--raw-field)\s*private=false", arg, re.I)
                    or re.fullmatch(r"(?:--field|--raw-field)=private=false", arg, re.I)
                    for arg in args
                ) or any(
                    args[j] in {"-f", "--field", "-F", "--raw-field"}
                    and j + 1 < len(args)
                    and args[j + 1].casefold() == "private=false"
                    for j in range(len(args))
                )
                create_endpoint = (
                    endpoint == "user/repos"
                    or re.fullmatch(r"orgs/[^/]+/repos", endpoint, re.I)
                )
                edit_endpoint = re.fullmatch(r"repos/[^/]+/[^/]+", endpoint, re.I)
                if private_false and (
                    (create_endpoint and method == "POST")
                    or (edit_endpoint and method in {"PATCH", "PUT"})
                ):
                    return "api"
    return None


def github_visibility_conflict(
    tool_name: object, content: object, *, task_anchor: object,
    latest_user_request: object = "",
) -> str | None:
    """Block explicit public GitHub visibility against a trusted private task."""
    if not github_private_repository_requested(task_anchor, latest_user_request):
        return None
    tool = str(tool_name or "").casefold()
    raw = str(content or "")
    action = _github_public_shell_action(raw) if tool == "bash" else None
    correction = "Use `gh repo create <name> --private` instead."
    if tool == "api_call":
        try:
            call = json.loads(raw)
        except (ValueError, TypeError):
            lines = raw.strip().splitlines()
            call = {"integration": lines[0].strip()} if lines else {}
            if len(lines) > 1:
                method_path = lines[1].strip().split(None, 1)
                if len(method_path) == 2:
                    call.update(method=method_path[0], path=method_path[1])
            if len(lines) > 2:
                try:
                    call["body"] = json.loads("\n".join(lines[2:]))
                except ValueError:
                    pass
        if isinstance(call, dict):
            integration = str(call.get("integration") or "")
            path = str(call.get("path") or "").split("?", 1)[0]
            method = str(call.get("method") or "GET").upper()
            body = call.get("body")
            github_integration = bool(re.search(r"github(?:\.com)?", integration, re.I))
            github_repo_path = (
                path.rstrip("/") == "/user/repos"
                or re.fullmatch(r"/orgs/[^/]+/repos/?", path, re.I)
                or re.fullmatch(r"/repos/[^/]+/[^/]+/?", path, re.I)
            )
            creates_or_edits_repo = (
                (method == "POST" and (path.rstrip("/") == "/user/repos"
                 or re.fullmatch(r"/orgs/[^/]+/repos/?", path, re.I)))
                or (method in {"PATCH", "PUT"}
                    and re.fullmatch(r"/repos/[^/]+/[^/]+/?", path, re.I))
            )
            if (github_integration and github_repo_path and creates_or_edits_repo
                    and isinstance(body, dict) and body.get("private") is False):
                action = "api"
                correction = "Set the GitHub API request body to `{'private': true}`."
    if action is None:
        return None
    if action == "visibility":
        correction = "Set `--visibility private` instead."
    elif action == "api":
        correction = "Set repository visibility to private (`private: true`) in the API request."
    return (
        "The original task explicitly requires a private GitHub repository, but "
        "this command requests public visibility. Do not create or change it "
        f"to public. {correction}"
    )


_DELETE_VERB = r"(?:delete|remove|wipe)"
_WHOLE_PROJECT_DELETE_RE = re.compile(
    rf"^\s*(?:please\s+)?{_DELETE_VERB}\s+(?:the\s+)?"
    r"(?:(?:entire|whole|complete|all)\s+)?"
    r"(?:project|repository|repo)\b"
    r"(?:\s*(?:[.!]|$)|\s+(?:(?:and|then)\s+(?:recreate|rebuild|replace|clone)\b.*))",
    re.I,
)
_WHOLE_WORKSPACE_DELETE_RE = re.compile(
    rf"^\s*(?:please\s+)?{_DELETE_VERB}\s+(?:the\s+)?"
    r"(?:(?:entire|whole|complete|all)\s+)?workspace\b"
    r"(?:\s*(?:[.!]|$)|\s+(?:(?:and|then)\s+(?:recreate|rebuild|replace|clone)\b.*))",
    re.I,
)
_AUTHORIZED_DELETE_SUFFIX = r"(?:\s+(?:project|repository|repo|workspace))?(?:\s*(?:[.!]|$)|\s+(?:(?:and|then)\s+(?:recreate|rebuild|replace|clone)\b.*))"
_DELETE_DENIAL_RE = re.compile(
    rf"^\s*(?:please\s+)?(?:do\s+not|don't|never)\s+{_DELETE_VERB}\b",
    re.I,
)


def _workspace_or_parent(path: str, workspace: str) -> bool:
    return path == workspace or workspace.startswith(path.rstrip(os.sep) + os.sep)


def _is_git_project_root(path: str) -> bool:
    marker = os.path.join(path, ".git")
    return os.path.isdir(marker) or os.path.isfile(marker)


def workspace_project_deletion_conflict(
    tool_name: object,
    content: object,
    *,
    workspace: object,
    working_directory: object,
    task_anchor: object = "",
    latest_user_request: object = "",
) -> str | None:
    """Block common recursive `rm` forms that remove a workspace or Git root.

    This is a narrow pre-dispatch guard, not a general shell parser. It handles
    direct `rm` commands, common shell chains, and simple `cd` paths only.
    """
    if str(tool_name or "").casefold() != "bash":
        return None
    workspace = str(workspace or "")
    working_directory = str(working_directory or "")
    if not workspace or not working_directory:
        return None
    try:
        workspace = os.path.realpath(workspace)
        current = os.path.realpath(working_directory)
        commands = _shell_commands(str(content or "")[:16_000])
    except (OSError, ValueError):
        return None

    latest_text = str(latest_user_request or "")[:2_000].strip()
    authorization_texts = [latest_text]
    if not _DELETE_DENIAL_RE.search(latest_text):
        # The trusted anchor is the original user task, not arbitrary history or
        # tool output, so an explicit same-task deletion remains authorized on
        # a short "continue" reply.
        anchor = str(task_anchor or "")[:8_000].strip()
        if anchor:
            authorization_texts.append(anchor)
    for tokens in commands:
        if not tokens:
            continue
        if os.path.basename(tokens[0]) == "cd":
            if len(tokens) == 2 and not re.search(r"[$*?`\\]", tokens[1]):
                target = tokens[1]
                current = os.path.realpath(
                    target if os.path.isabs(target) else os.path.join(current, target)
                )
            else:
                current = ""
            continue

        rm_index = 0
        if tokens[0] in {"sudo", "command"} and len(tokens) > 1:
            rm_index = 1
        if rm_index >= len(tokens) or os.path.basename(tokens[rm_index]) != "rm":
            continue
        options = tokens[rm_index + 1:]
        recursive = False
        targets = []
        parsing_options = True
        for value in options:
            if parsing_options and value == "--":
                parsing_options = False
            elif parsing_options and value == "--recursive":
                recursive = True
            elif parsing_options and value.startswith("-") and value != "-":
                if not value.startswith("--") and any(flag in value[1:] for flag in "rR"):
                    recursive = True
            elif value:
                targets.append(value)
        if not recursive:
            continue
        for target in targets:
            if not current or re.search(r"[$*?`\\]", target):
                continue
            candidate = os.path.realpath(
                target if os.path.isabs(target) else os.path.join(current, target)
            )
            workspace_exact = candidate == workspace
            workspace_ancestor = candidate != workspace and _workspace_or_parent(candidate, workspace)
            removes_git_root = _is_git_project_root(candidate)
            target_name = os.path.basename(candidate.rstrip(os.sep))
            def explicitly_authorizes_target(text: str) -> bool:
                named_delete = bool(target_name and re.match(
                    rf"^\s*(?:please\s+)?{_DELETE_VERB}\s+(?:(?:the|entire|whole|complete|all)\s+){{0,2}}"
                    rf"{re.escape(target_name)}\b{_AUTHORIZED_DELETE_SUFFIX}",
                    text,
                    re.I,
                ))
                return bool(
                    named_delete or _WHOLE_PROJECT_DELETE_RE.match(text)
                    or (workspace_exact and _WHOLE_WORKSPACE_DELETE_RE.match(text))
                )

            authorized = any(explicitly_authorizes_target(text) for text in authorization_texts)
            authorized = authorized and not workspace_ancestor and (
                workspace_exact or removes_git_root
            )
            if (workspace_exact or workspace_ancestor or removes_git_root) and not authorized:
                return (
                    "This recursive delete targets the workspace or a Git project root. "
                    "Preserve source and repair the existing project in place. Limit "
                    "cleanup to generated directories unless the current user request "
                    "explicitly directs deleting the whole project."
                )
    return None


def tool_toggle_enabled(value: object) -> bool:
    """Return true only for explicit true-like tool toggle values."""

    return str(value).lower() == "true"


def tool_toggle_explicitly_denied(value: object) -> bool:
    """Return true when a caller explicitly supplied a non-true toggle value."""

    return value is not None and not tool_toggle_enabled(value)


def is_web_search_explicitly_denied(allow_web_search: object) -> bool:
    """Whether the web-search agent toggle was explicitly set to false."""

    return tool_toggle_explicitly_denied(allow_web_search)


def web_search_enabled_for_turn(allow_web_search: object, use_web: object = None) -> bool:
    """Return true only when this request explicitly enables web search.

    Agent mode sends ``allow_web_search``; chat-mode pre-search sends
    ``use_web``. If both are present, an explicit ``allow_web_search=false``
    wins so a stale or conflicting intent path cannot re-enable web tools.
    """

    if is_web_search_explicitly_denied(allow_web_search):
        return False
    return tool_toggle_enabled(allow_web_search) or tool_toggle_enabled(use_web)


_COMMON_TOOL_NAMES = {
    "context_search",
    "api_call",
    "app_api",
    "archive_email",
    "ask_teacher",
    "ask_user",
    "bash",
    "bulk_email",
    "builtin_browser",
    "cancel_download",
    "chat_with_model",
    "create_document",
    "create_session",
    "delete_email",
    "download_model",
    "edit_document",
    "edit_file",
    "edit_image",
    "generate_image",
    "glob",
    "grep",
    "list_cached_models",
    "list_cookbook_servers",
    "list_downloads",
    "list_emails",
    "list_models",
    "list_serve_presets",
    "list_served_models",
    "list_sessions",
    "ls",
    "manage_calendar",
    "manage_contact",
    "manage_documents",
    "manage_endpoints",
    "manage_mcp",
    "manage_memory",
    "manage_notes",
    "manage_research",
    "manage_session",
    "manage_settings",
    "manage_skills",
    "manage_tasks",
    "manage_tokens",
    "manage_webhooks",
    "mark_email_read",
    "pipeline",
    "python",
    "read_email",
    "read_file",
    "reply_to_email",
    "resolve_contact",
    "search_chats",
    "search_hf_models",
    "send_email",
    "send_to_session",
    "serve_model",
    "serve_preset",
    "stop_served_model",
    "suggest_document",
    "trigger_research",
    "ui_control",
    "update_document",
    "update_plan",
    "vault_get",
    "vault_search",
    "vault_unlock",
    "web_fetch",
    "web_search",
    "write_file",
}


_GUIDE_ONLY_PATTERNS: Tuple[Tuple[re.Pattern[str], str], ...] = tuple(
    (re.compile(pattern, re.IGNORECASE), reason)
    for pattern, reason in (
        (r"\bguide[-\s]?only mode\b", "guide-only mode requested"),
        (r"\bno[-\s]?tools? mode\b", "no-tools mode requested"),
        (r"\bdo not use (?:any )?tools?\b", "user forbade tool use"),
        (r"\bdon'?t use (?:any )?tools?\b", "user forbade tool use"),
        (r"\bnot allowed to use (?:any )?tools?\b", "user forbade tool use"),
        (r"\bnot allowed to:?.{0,120}\buse (?:any )?tools?\b", "user forbade tool use"),
        (r"\bask (?:me )?(?:for confirmation )?before using tools?\b", "user requested confirmation before tools"),
    )
)


@dataclass(frozen=True)
class ToolPolicy:
    """Effective tool behavior for one agent turn."""

    disabled_tools: frozenset[str] = frozenset()
    hidden_tools: frozenset[str] = frozenset()
    reasons: Mapping[str, str] = field(default_factory=dict)
    mode: str = "normal"
    block_all_tool_calls: bool = False
    disable_mcp: bool = False

    def all_disabled_names(self) -> Set[str]:
        return set(self.disabled_tools) | set(self.hidden_tools)

    def blocks(self, tool_name: Optional[str]) -> bool:
        if not tool_name:
            return False
        return self.block_all_tool_calls or tool_name in self.disabled_tools or tool_name in self.hidden_tools

    def reason_for(self, tool_name: Optional[str]) -> str:
        if tool_name and tool_name in self.reasons:
            return self.reasons[tool_name]
        if self.block_all_tool_calls and self.mode == "guide_only":
            return "Tool use is disabled for this guide-only turn."
        return "Tool use is disabled for this turn."


def detect_guide_only_turn(message: object) -> Optional[str]:
    """Return a reason when the latest user turn strongly requests no tools."""

    if not isinstance(message, str) or not message.strip():
        return None
    text = re.sub(r"\s+", " ", message.strip())
    for pattern, reason in _GUIDE_ONLY_PATTERNS:
        if pattern.search(text):
            return reason
    return None


def known_tool_names() -> Set[str]:
    """Best-effort set of native tool names for prompt hiding and denylisting."""

    names = set(_COMMON_TOOL_NAMES)
    try:
        from src.tool_schemas import FUNCTION_TOOL_SCHEMAS

        for schema in FUNCTION_TOOL_SCHEMAS:
            name = (schema.get("function") or {}).get("name") or schema.get("name")
            if name:
                names.add(name)
    except Exception:
        pass
    try:
        from src.agent_loop import TOOL_SECTIONS

        names.update(TOOL_SECTIONS.keys())
    except Exception:
        pass
    try:
        from src.tool_security import PLAN_MODE_READONLY_TOOLS, _PLAN_MODE_KNOWN_MUTATORS

        names.update(PLAN_MODE_READONLY_TOOLS)
        names.update(_PLAN_MODE_KNOWN_MUTATORS)
    except Exception:
        pass
    return names


def build_effective_tool_policy(
    *,
    disabled_tools: Optional[Iterable[str]] = None,
    last_user_message: object = "",
) -> ToolPolicy:
    """Compose the effective policy for one agent turn.

    Existing callers still provide the already-composed disabled-tool denylist.
    This function adds higher-level turn policy on top so enforcement is not
    delegated to prompt compliance.
    """

    disabled = {str(t) for t in (disabled_tools or []) if t}
    hidden: Set[str] = set()
    reasons = {tool: "Tool is disabled for this request." for tool in disabled}

    guide_reason = detect_guide_only_turn(last_user_message)
    if guide_reason:
        all_tools = known_tool_names()
        disabled.update(all_tools)
        hidden.update(all_tools)
        reasons.update({tool: f"{guide_reason}." for tool in all_tools})
        return ToolPolicy(
            disabled_tools=frozenset(disabled),
            hidden_tools=frozenset(hidden),
            reasons=MappingProxyType(dict(reasons)),
            mode="guide_only",
            block_all_tool_calls=True,
            disable_mcp=True,
        )

    return ToolPolicy(
        disabled_tools=frozenset(disabled),
        hidden_tools=frozenset(hidden),
        reasons=MappingProxyType(dict(reasons)),
    )
