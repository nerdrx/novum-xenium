import subprocess
import sys
from pathlib import Path

if __name__ == '__main__':
    try:
        result = subprocess.run(
            [sys.executable, '-m', 'unittest', '-v', 'test_solution'],
            cwd=Path(__file__).parent,
            timeout=15,
        )
    except subprocess.TimeoutExpired:
        print('Tests exceeded the 15-second limit.', file=sys.stderr)
        sys.exit(124)
    sys.exit(result.returncode)
