Implement `parse_progress(lines: Iterable[str]) -> list[dict]` in progress.py using only Python's standard library. The input is FFmpeg `-progress` output, one text line per iterable item; accept generators as well as lists. Do not modify the public tests or qa_check.py.

Each record ends at `progress=continue` or `progress=end`. Emit exactly one dictionary with these four keys for each terminator:
- `time_seconds`: the `out_time_us` integer microsecond value divided by 1,000,000, as a float; missing or invalid means None.
- `speed`: a finite nonnegative float parsed from a value with a trailing `x`, such as `1.5x`; missing, `N/A`, absent suffix, malformed, negative, NaN, or infinite means None.
- `frame`: a nonnegative integer; missing or invalid means None.
- `done`: False for `continue`, True for `end`.

For frame and out_time_us, valid input is decimal digits only, optionally preceded by a plus sign. Negative values, decimal fractions, exponent notation, empty strings, N/A, NaN, infinity, and other malformed values are invalid. Treat time values whose conversion to seconds cannot produce a finite float as invalid. Zero is valid for all numeric fields.

Strip surrounding whitespace from each line, key, and value; split on the first `=` only. Ignore blank lines, lines without `=`, unknown keys, and unrecognized progress values. A later recognized numeric key replaces its earlier value within the same record, even when the later value is invalid. Every terminated record is independent: reset all fields after emitting, never carry previous values forward. An empty terminated record has all numeric fields None. Do not emit an unterminated final record. Continue parsing later records even after an end marker.

Run `python3 qa_check.py` to validate. Keep the implementation small and readable.
