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
    text = re.sub(r"https?://[^\s<>]+", " ", str(text or ""), flags=re.I)
    # Keep a positive instruction after a restriction, including comma-separated
    # requests: "Don't rewrite everything, fix main.py". A comma followed
    # by a final ", or" still belongs to the coordinated restriction.
    text = re.sub(
        r"\b(?:do\s+not|don't|never)\b(?:(?![;.!?\n]|\b(?:but|instead|except)\b|,\s*(?="
        + _ACTION + r")(?![^;.!?\n]*,\s*or\b)).)*", " ", text, flags=re.I,
    )
    # Questions about making changes are explanations, not requests to edit.
    text = re.sub(
        r"\b(?:how\s+(?:to|do|does|would|can|should)|explain\s+(?:how|why))\b[^;!?\n]*",
        " ", text, flags=re.I,
    )
    text = re.sub(r"\b(?:write|create)\s+(?:a\s+)?(?:summary|explanation|description|review)\b[^;!?\n]*", " ", text, flags=re.I)
    return bool(re.search(_ACTION, text, re.I) and re.search(_TARGET, text, re.I))
