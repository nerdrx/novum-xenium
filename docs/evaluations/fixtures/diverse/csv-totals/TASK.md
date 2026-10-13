Implement `totals(csv_text: str) -> dict[str, Decimal]` in solution.py using only Python's standard library. Change only solution.py. This is one function; no CLI or files are required.

Input is CSV text without a header, using standard comma delimiters and double-quote escaping. The input's CSV quoting is syntactically valid; quoted names may contain commas, escaped quotes, or newlines. Parse records with CSV semantics, not simple comma/line splitting.

Each valid record has exactly two fields: name and amount. Strip surrounding whitespace from each field. Names must be nonempty and are case-sensitive. Amount syntax is an optional + or - sign followed by one or more ASCII digits, optionally followed by a decimal point and one or more ASCII digits. Accept examples: 0, +12, -0.25, 001.20. Reject empty amounts, .5, 1., exponent notation, NaN, Infinity, currency signs, underscores, and other malformed amounts. Skip invalid records entirely, including blank records and records with the wrong field count.

Return a dict mapping each valid name to the sum of its valid amounts as Decimal values, not floats or strings. Repeated names accumulate; retain names whose total is zero. Empty input or only invalid records returns {}. Test inputs contain at most 100 records, with at most 12 integer and 4 fractional digits per amount, so normal Decimal precision suffices.

Run `python3 qa_check.py`. Do not modify the tests or runner.
