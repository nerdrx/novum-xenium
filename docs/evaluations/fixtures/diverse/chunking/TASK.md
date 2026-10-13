Fix the off-by-one bug in `chunks(items, size)` in solution.py. Change only solution.py; preserve the public API and existing validation.

`items` is a list. Return a new list of consecutive nonempty list chunks in the original order, with at most `size` elements each. Include every element exactly once. A final shorter chunk must be retained. Empty input returns []. Do not mutate the input; each returned chunk must be a new list. `size` must be a positive Python int; reject zero, negative values, bool, floats, strings, and None with ValueError. No dependencies needed.

Run `python3 qa_check.py`. Do not change the tests or runner.
