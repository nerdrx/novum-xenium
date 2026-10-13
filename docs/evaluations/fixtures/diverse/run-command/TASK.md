Implement `run_command(argv, timeout) -> dict` in `solution.py` using Python's standard library.

Inputs are a nonempty list of command argument strings and a positive timeout in seconds. No input validation is required. Execute the command directly, without a shell, using `subprocess.run` so its normal timeout cleanup applies. Do not create background processes or change the working directory/environment.

Return exactly these keys:
- `returncode`: the child's integer exit code, including nonzero codes.
- `stdout`: captured standard output as a string.
- `stderr`: captured standard error as a string.

Decode both streams as UTF-8 with replacement for invalid bytes. Preserve whitespace and trailing newlines. Arguments containing spaces or shell metacharacters must reach the child literally. A nonzero exit is a normal returned result, not an exception. Propagate `subprocess.TimeoutExpired` when the timeout expires and `FileNotFoundError` when the executable does not exist. Do not print output yourself.

Change only `solution.py`. Run `python3 qa_check.py`. No dependencies.
