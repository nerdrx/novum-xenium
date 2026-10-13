import subprocess,sys
raise SystemExit(subprocess.call([sys.executable,'-m','unittest','-v','test_solution.py']))
