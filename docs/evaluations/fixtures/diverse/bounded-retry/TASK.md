Implement retry_call(operation, attempts, retry_on) in solution.py using only the standard library. Modify only solution.py. No sleep, network, logging, or external dependencies.

operation is a callable taking no arguments. attempts is the maximum TOTAL number of calls, including the first call; it must be a positive Python int (bool is invalid). Invalid attempts must raise ValueError before calling operation. retry_on is a tuple of Exception subclasses; this tuple is guaranteed valid, and may be empty.

Return the first successful result unchanged, including falsey values. When operation raises an exception matching retry_on (including subclasses), retry while calls remain. On the final permitted failure, re-raise that exact exception object, not a wrapper or a previous exception. Exceptions not matching retry_on must propagate immediately and unchanged. Never make an extra call after success or exhaustion. Each retry_call invocation has its own budget. Never catch nonmatching BaseException subclasses such as KeyboardInterrupt.

Run python3 qa_check.py. Do not edit tests or runner.
