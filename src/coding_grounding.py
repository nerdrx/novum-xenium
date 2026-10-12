"""Small policy helper for research-first repository edits.

It tracks observed tool results, never tool-call intent: a proposed lookup is
not evidence. The caller owns schema selection and invokes ``may_mutate`` before
the first workspace write.
"""
from pathlib import PurePosixPath
import json
import re
from urllib.parse import urlsplit

from src.tool_capabilities import ToolEffect, capabilities_for_action, tool_result_is_successful


_SUBSTANTIVE_CODE_TASK = re.compile(
    r"\b(?:build|create|implement|integrate|migrate|upgrade|replace|add)\b"
    r".{0,100}\b(?:app(?:lication)?s?|gui|website|websites|cli|tool|tools|"
    r"module|modules|libraries|library|frameworks?|dependencies|packages?|"
    r"sdk|apis?|plugins?|services?)\b"
    r"|\b(?:integrate|migrate|upgrade|replace)\b.{0,80}"
    r"\b(?:library|framework|dependency|package|sdk|api|plugin|service)\b",
    re.IGNORECASE | re.DOTALL,
)
_NO_WEB = re.compile(
    r"\b(?:no (?:web|internet|online|network)|offline|local only|"
    r"don't use (?:the )?(?:web|internet|browser)|do not use (?:the )?"
    r"(?:web|internet|browser)|without (?:browsing|web access|internet access)|"
    r"(?:do not|don't) browse)\b",
    re.IGNORECASE,
)
_DOC_BASENAMES = re.compile(
    r"^(?:readme(?:\..*)?|agents\.md|contributing(?:\..*)?|"
    r"pyproject\.toml|package\.json|package-lock\.json|pnpm-lock\.yaml|"
    r"yarn\.lock|cargo\.toml|cargo\.lock|go\.mod|go\.sum|"
    r"requirements(?:[-_.].*)?\.txt|setup\.py|setup\.cfg|pom\.xml|"
    r"build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|"
    r"cmakelists\.txt|makefile|tsconfig\.json)$",
    re.IGNORECASE,
)
_RESEARCH_ATTEMPTS = frozenset({"web_search", "web_fetch", "read_file"})
_URL = re.compile(r"https?://[^\s<>\]\[(){}\"']+", re.IGNORECASE)


def _github_doc_coordinates(url):
    """Return only the strict owner/repo/revision/path GitHub doc identity."""
    parsed = urlsplit(str(url or ""))
    parts = parsed.path.strip("/").split("/")
    host = (parsed.hostname or "").lower()
    if host == "github.com" and len(parts) >= 5 and parts[2] == "blob":
        return tuple(parts[:2] + [parts[3]]) + ("/".join(parts[4:]),)
    if host == "raw.githubusercontent.com" and len(parts) >= 4:
        return tuple(parts[:3]) + ("/".join(parts[3:]),)
    return None


def _same_requested_url(preferred, fetched):
    if preferred == fetched:
        return True
    expected = _github_doc_coordinates(preferred)
    return bool(expected and expected == _github_doc_coordinates(fetched))


class CodingGrounding:
    """Track whether a substantive coding task has enough observed grounding."""

    max_attempts = 6
    max_failures = 2

    def __init__(self, task, *, disabled_tools=(), web_allowed=True,
                 plan_mode=False, guide_mode=False):
        self.task = str(task or "").strip()
        self.disabled_tools = set(disabled_tools or ())
        self.web_allowed = bool(web_allowed) and not _NO_WEB.search(self.task)
        self.required = bool(
            self.task and not plan_mode and not guide_mode
            and _SUBSTANTIVE_CODE_TASK.search(self.task)
        )
        self.attempts = 0
        self.failures = 0
        self.evidence = set()
        self.preferred_urls = {url.rstrip(".,;!") for url in _URL.findall(self.task)}
        self.fetched_urls = set()

    @property
    def research_tools(self):
        """Available tools for a brief lookup phase; no deep-research sidebar."""
        tools = {"get_workspace", "ls", "glob", "grep", "read_file", "search_tools", "ask_user", "manage_skills"}
        if self.web_allowed:
            tools.update({"web_search", "web_fetch"})
        return tools - self.disabled_tools if self.required else set()

    def allows_tool(self, tool_name, content=None):
        """Expose skill discovery, while keeping skill mutations behind the gate."""
        if self.may_mutate:
            return True
        if tool_name not in self.research_tools:
            return False
        if tool_name == "manage_skills":
            return capabilities_for_action(tool_name, content).effects == frozenset({ToolEffect.READ_PRIVATE})
        return True

    @property
    def directive(self):
        if not self.required:
            return ""
        source_rule = (
            "Use web_search to locate primary documentation, then web_fetch to read it. "
            if self.web_allowed else "Use local project documentation only; web lookup is disabled. "
        )
        url_rule = (
            "Your next documentation lookup should be web_fetch for a URL supplied by the user: "
            + ", ".join(sorted(self.preferred_urls))[:1500]
            + ". Read it before searching for alternatives or relying on generic local manifests. "
            if self.preferred_urls and self.web_allowed else ""
        )
        return (
            "## Coding research gate\n"
            "Before the first workspace mutation, inspect relevant local project guidance and documentation. "
            "Load any relevant available skill with manage_skills action=view; skill reads are permitted during research. "
            + source_rule
            + url_rule
            + "Count evidence only after a successful tool result returns readable source or document content. "
            "Search snippets alone are leads, not evidence. Keep this brief; do not start a Deep Research job. "
            "If two lookups fail, or six research calls produce no usable source, proceed with clearly stated uncertainty."
        )

    @property
    def has_evidence(self):
        if self.preferred_urls and self.web_allowed:
            return any(
                _same_requested_url(preferred, fetched)
                for preferred in self.preferred_urls
                for fetched in self.fetched_urls
            )
        return bool(self.evidence)

    @property
    def may_mutate(self):
        return bool(
            not self.required or self.has_evidence
            or self.failures >= self.max_failures
            or self.attempts >= self.max_attempts
            or not (self.research_tools & _RESEARCH_ATTEMPTS)
        )

    def observe(self, tool_name, result, content=None):
        """Record actual result; return True only when it supplies usable evidence."""
        if not self.required or tool_name not in self.research_tools:
            return False
        if tool_name == "ask_user" or tool_name not in _RESEARCH_ATTEMPTS:
            return False
        self.attempts += 1
        output = result.get("output") if isinstance(result, dict) else None
        successful = tool_result_is_successful(result)
        readable = isinstance(output, str) and bool(output.strip())
        evidence = False
        if successful and readable:
            if tool_name == "web_fetch":
                fetched = str(content or "").strip()
                try:
                    args = json.loads(fetched)
                    if isinstance(args, dict):
                        fetched = str(args.get("url") or "")
                except (TypeError, ValueError):
                    fetched = fetched.splitlines()[0].strip()
                fetched = fetched.rstrip(".,;!")
                if fetched.startswith(("http://", "https://")):
                    self.fetched_urls.add(fetched)
                evidence = not self.preferred_urls or any(
                    _same_requested_url(preferred, fetched)
                    for preferred in self.preferred_urls
                )
            elif tool_name == "read_file":
                path = str(content or "").strip()
                try:
                    args = json.loads(path)
                    if isinstance(args, dict):
                        path = str(args.get("path") or "")
                except (TypeError, ValueError):
                    path = path.splitlines()[0].strip()
                path = path.replace("\\", "/")
                basename = PurePosixPath(path).name
                evidence = (not self.preferred_urls or not self.web_allowed) and bool(
                    _DOC_BASENAMES.match(basename)
                    or "/docs/" in f"/{path.strip('/')}/"
                    or path.strip("/").lower().startswith("docs/")
                )
        if evidence:
            self.evidence.add(tool_name)
            return True
        # Navigation and successful search results are progress, not failed
        # lookups. Only unsuccessful reads/searches/fetches consume the escape.
        if not successful:
            self.failures += 1
        return False
