Implement stable_toposort(dependencies) in solution.py using only Python's standard library. Modify only solution.py. The input is an insertion-ordered dict mapping unique task-name strings to lists of dependency-name strings. All values have these types; no additional type validation is required.

Return a list containing every task name exactly once, after all of that task's dependencies. At EACH step choose the earliest task in the ORIGINAL dict insertion order among all tasks currently ready. Newly ready earlier tasks outrank later tasks already ready: for {"a":["b"], "b":[], "c":[]} the result must be ["b", "a", "c"]. This precise tie-breaking rule defines stable ordering; do not alphabetically sort names or append newly ready tasks behind existing ready tasks automatically.

Repeated dependency names within a list count as one dependency. Reject any reference to a name absent from the dict by raising ValueError. Raise ValueError for every cycle, including self-dependency and cycles in a disconnected component; do not return a partial ordering. Exact error message is unspecified. Empty input returns []. Do not mutate the dict or any dependency list. Inputs have at most 100 tasks; a simple readable algorithm is sufficient.

Run python3 qa_check.py. Do not edit tests or runner.
