"""Node-driven regression coverage for body-portaled dropdown z-order.

Tool-modal z climbs unbounded via modalManager's bring-to-front counter, so the
old hardcoded `z-index: 10001` shared by ~16 body-portaled dropdowns eventually
rendered them BEHIND their own modal in a long session (#4720). topPortalZ()
replaces every one of those literals with a value derived from the live
tool-window stack. These tests pin that it always clears both the modal stack
and the dock-chip floor, without importing the browser-heavy UI modules.
"""

import json
import re
import shutil
import subprocess
import textwrap
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "static" / "js" / "toolWindowZOrder.js"
pytestmark = pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")


def _node_eval(source: str):
    proc = subprocess.run(
        ["node", "--input-type=module"],
        input=source,
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout.strip())


def test_portal_z_clears_dock_chip_floor_when_no_modal_is_open():
    # No tool window raised → topToolWindowZ floors at 250, but a portaled
    # dropdown must still clear the dock chips pinned up to 10030, so it lands
    # just above that floor.
    values = _node_eval(
        textwrap.dedent(
            f"""
            import {{ topPortalZ }} from '{HELPER.as_uri()}';
            const root = {{ querySelectorAll() {{ return []; }} }};
            console.log(JSON.stringify({{ z: topPortalZ({{ root, getStyle: () => ({{}}) }}) }}));
            """
        )
    )

    assert values == {"z": 10031}


def test_portal_z_sits_above_a_modal_whose_counter_has_climbed_past_10001():
    # The #4720 scenario: a long session bumped the owning modal's bring-to-front
    # z to 99999. A hardcoded 10001 dropdown rendered BEHIND it; topPortalZ must
    # land one above the live modal z.
    values = _node_eval(
        textwrap.dedent(
            f"""
            import {{ topPortalZ }} from '{HELPER.as_uri()}';
            const cls = (...names) => ({{ contains: (name) => names.includes(name) }});
            const modal = {{ id: 'memory-modal', classList: cls(), style: {{ zIndex: '99999' }} }};
            const root = {{ querySelectorAll() {{ return [modal]; }} }};
            console.log(JSON.stringify({{ z: topPortalZ({{ root, getStyle: (el) => el.style }}) }}));
            """
        )
    )

    assert values == {"z": 100000}


def test_portal_z_uses_chip_floor_when_the_open_modal_sits_below_it():
    # A modal raised to 5000 is still below the dock-chip floor, so the floor
    # (10030) wins and the dropdown lands at 10031 — never below a pinned chip.
    values = _node_eval(
        textwrap.dedent(
            f"""
            import {{ topPortalZ }} from '{HELPER.as_uri()}';
            const cls = (...names) => ({{ contains: (name) => names.includes(name) }});
            const modal = {{ id: 'cookbook-modal', classList: cls(), style: {{ zIndex: '5000' }} }};
            const root = {{ querySelectorAll() {{ return [modal]; }} }};
            console.log(JSON.stringify({{ z: topPortalZ({{ root, getStyle: (el) => el.style }}) }}));
            """
        )
    )

    assert values == {"z": 10031}


# tasks.js and skills.js were not in #4724's batch; #4767 routes their portaled
# dropdowns through the same helper. Pin that they use topPortalZ() and carry no
# hardcoded portal z-index, so they cannot regress to the #4720 bug.
@pytest.mark.parametrize("rel", [
    "static/js/tasks.js", "static/js/skills.js", "static/js/compare/selector.js",
    "static/js/compare/panes.js", "static/js/compare/index.js",
])
def test_late_routed_dropdowns_use_top_portal_z(rel):
    src = (ROOT / rel).read_text()
    assert "topPortalZ" in src, f"{rel} must import/use topPortalZ()"
    assert "topPortalZ()" in src, f"{rel} must call topPortalZ() for its dropdown z"


@pytest.mark.parametrize("rel", ["static/js/tasks.js", "static/js/skills.js", "static/style.css"])
def test_no_hardcoded_portal_z_literals_remain(rel):
    src = (ROOT / rel).read_text()
    # Match the exact 100000/100002 these dropdowns used; the trailing-digit
    # guard avoids false-matching an unrelated 1000000 elsewhere.
    hits = re.findall(r"z-index:\s*10000[02](?!\d)", src)
    assert not hits, f"{rel} still has hardcoded portal z: {hits}"


def test_modal_open_promotions_settle_and_only_reopening_raises_again():
    source = (ROOT / "static/js/ui.js").read_text()
    block = source[source.index("  let _zCounter = 1000;"):source.index("  const pickTopModal =")]
    values = _node_eval(f"""
        import {{ nextToolWindowZ, topToolWindowZ }} from '{HELPER.as_uri()}';
        const pending = [];
        let observer;
        globalThis.MutationObserver = class {{
            constructor(callback) {{ observer = callback; }}
            observe() {{}}
        }};
        function modal(id) {{
            const classes = new Set(['modal']);
            const el = {{ id, classList: {{ contains: name => classes.has(name) }}, classes }};
            el.style = {{ zIndex: '250', display: 'block', setProperty(name, value) {{
                this.zIndex = value;
                pending.push({{ type: 'attributes', target: el }});
            }} }};
            return el;
        }}
        const a = modal('a'), b = modal('b');
        globalThis.document = {{ body: {{}}, querySelectorAll: () => [a, b] }};
        globalThis.getComputedStyle = el => el.style;
        eval({json.dumps(block)});
        function flush() {{
            let rounds = 0;
            while (pending.length && ++rounds <= 20) observer(pending.splice(0));
            if (pending.length) throw new Error('Modal z-index observer never settles');
        }}
        flush();
        const initial = [Number(a.style.zIndex), Number(b.style.zIndex)];
        pending.push({{ type: 'attributes', target: a }});
        flush();
        const afterStyle = [Number(a.style.zIndex), Number(b.style.zIndex)];
        a.classes.add('hidden');
        pending.push({{ type: 'attributes', target: a }});
        flush();
        a.classes.delete('hidden');
        pending.push({{ type: 'attributes', target: a }});
        flush();
        console.log(JSON.stringify({{ initial, afterStyle, reopened: Number(a.style.zIndex) }}));
    """)
    assert values["initial"][1] > values["initial"][0]
    assert values["afterStyle"] == values["initial"]
    assert values["reopened"] > max(values["initial"])
