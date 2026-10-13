from pathlib import Path
import subprocess
import sys

if __name__ == "__main__":
    try:
        result = subprocess.run(["node", "--test", "test_solution.mjs"], cwd=Path(__file__).parent, timeout=15)
    except subprocess.TimeoutExpired:
        print("Tests exceeded the 15-second limit", file=sys.stderr)
        raise SystemExit(124)
    raise SystemExit(result.returncode)
