"""Custom reference sections retain their labels across skill storage."""
from services.memory.skill_format import Skill


def test_custom_sections_survive_skill_roundtrip_without_changing_procedure():
    markdown = """---
name: runtime-guide
description: Native API references
---
## Procedure
1. Verify the bridge.

## Runtime Boundary Check
Keep renderer and native APIs separate.

## References
[IPC](https://www.electronjs.org/docs/latest/tutorial/ipc)
"""
    skill = Skill.from_markdown(markdown)
    assert skill.procedure == ["Verify the bridge."]
    saved = skill.to_markdown()
    assert "## Runtime Boundary Check" in saved
    assert "## References" in saved
    assert "Keep renderer and native APIs separate." in saved
    assert Skill.from_markdown(saved).body_extra == skill.body_extra
