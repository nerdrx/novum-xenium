"""Conservative intent gate for the checked coding workflow, not tool routing."""

import re

_ACTION = r"\b(?:fix|debug|repair|implement|edit|add|remove|change|update|refactor|rewrite|restyle|redesign|build|create|develop|write|wire)\b"
_TARGET = (
    r"\b(?:code|codebase|repo|repository|app|application|gui|frontend|backend|website|"
    r"software|program|script|cli|component|function|method|class|module|test|tests|"
    r"bug|regression|ui|button|layout|route|config|css|javascript|typescript|python|rust)\b"
    r"|\b[A-Za-z_]\w*\s*\("
    r"|\b[\w.-]+\.(?:py|pyi|js|jsx|ts|tsx|mjs|cjs|rs|go|c|h|cpp|hpp|java|cs|"
    r"rb|php|swift|kt|sh|html|css|scss|sql|gd)\b"
)


def _use_checked_coding_workflow(text: str, workspace: str | None) -> bool:
    """Enable checked work for requested coding changes in a bound workspace."""
    if not workspace:
        return False
    return _coding_change_requested(text)


def _explicit_read_only_coding_followup(text: str) -> bool:
    """Recognize an explicit read-only override, never an implicit continuation."""
    value = str(text or "")
    return bool(
        re.search(r"\b(?:do\s+not|don't|never)\s+(?:" + _ACTION + r"|clone|run|execute)\b", value, re.I)
        and re.search(r"\b(?:only|just)\s+(?:read|explain|review|analy[sz]e|report|inspect|summarize)\b", value, re.I)
        and not _coding_change_requested(value)
    )


def _coding_change_requested(text: str) -> bool:
    text = re.sub(r"https?://[^\s<>]+", " ", str(text or ""), flags=re.I)
    # A filename's dot is not a sentence boundary. Keep positive clauses
    # after restrictions, but do not split coordinated negated action lists.
    clause_end = r"[;!?\n]|\.(?=\s|$)"
    coordinated_tail = (
        r"(?:(?!" + clause_end + r").)*\bor\s+(?:" + _ACTION + r"|run|clone|execute)\b"
    )
    text = re.sub(
        r"\b(?:do\s+not|don't|never)\b(?:(?!" + clause_end
        + r"|\b(?:but|instead|except)\b|,\s*(?=" + _ACTION + r")(?!"
        + coordinated_tail + r")).)*", " ", text, flags=re.I,
    )
    # Questions about making changes are explanations, not requests to edit.
    text = re.sub(
        r"\b(?:how\s+(?:to|do|does|would|can|should)|explain\s+(?:how|why))\b[^;!?\n]*",
        " ", text, flags=re.I,
    )
    text = re.sub(r"\b(?:write|create)\s+(?:a\s+)?(?:summary|explanation|description|review)\b[^;!?\n]*", " ", text, flags=re.I)
    return bool(re.search(_ACTION, text, re.I) and re.search(_TARGET, text, re.I))
