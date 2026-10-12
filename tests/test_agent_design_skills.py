"""Bundled design procedures can be imported and discovered without cross-owner access."""
from pathlib import Path

from services.memory.skills import SkillsManager


ROOT = Path(__file__).resolve().parents[1]


def test_design_skill_templates_import_match_gui_task_and_preserve_ownership(tmp_path):
    manager = SkillsManager(str(tmp_path))
    for name in ('ui-design', 'visual-verification'):
        source = (ROOT / 'agent-skills' / name / 'SKILL.md').read_text()
        manager.import_bundle_from_files({'SKILL.md': source}, owner='alice', category='design')
    query = ('build me a ffmpeg wrapper gui with all bells and whistles; '
             'give it the modern nx design language')
    matched = manager.get_relevant_skills(query, skills=manager.load(owner='alice'), threshold=0.25)
    assert {skill['name'] for skill in matched} == {'ui-design', 'visual-verification'}
    bob_skills = manager.load(owner='bob')
    assert bob_skills
    assert all(skill['owner'] == 'bob' for skill in bob_skills)
    assert manager.read_skill_md('ui-design', owner='bob') is None
    assert all(skill['procedure'] and skill['verification'] for skill in matched)
    # A collision cannot replace an existing procedure.
    original = manager.load(owner='alice')
    manager.import_bundle_from_files({'SKILL.md': (ROOT / 'agent-skills/ui-design/SKILL.md').read_text()},
                                    owner='bob', category='design')
    assert manager.load(owner='alice') == original
    assert manager.load(owner='bob')[0]['name'] == 'ui-design-2'
