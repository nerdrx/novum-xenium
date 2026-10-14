import ast
import re
from pathlib import Path


def test_unexecuted_image_placeholder_notice():
    source = (Path(__file__).resolve().parents[1] / "src/agent_loop.py").read_text()
    tree = ast.parse(source)
    function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "_unexecuted_image_notice")
    namespace = {"re": re}
    exec(compile(ast.Module(body=[function], type_ignores=[]), "agent_loop.py", "exec"), namespace)
    notice = namespace["_unexecuted_image_notice"]
    assert "No image was generated" in notice("Here is your picture:\n[Image]", [])
    assert notice("[New Image]", [])
    assert notice("Here is the robot: [image]", [])
    assert not notice("[Image]", [{"tool": "generate_image"}])
    assert not notice("![Image](/generated/robot.png)", [])
    assert not notice("The placeholder is [Image] in this example.", [])
    assert not notice("Hello!", [])
