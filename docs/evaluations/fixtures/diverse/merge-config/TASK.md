Implement `merge_config(defaults, overrides) -> dict` in `solution.py` using only Python's standard library.

Both inputs are dictionaries with string keys and acyclic JSON-like values: dictionaries, lists, strings, numbers, booleans, and None. No argument validation is required.

Return a new dictionary containing all keys from either input. When a key occurs in both and both values are dictionaries, merge those dictionaries recursively with the same rules. Otherwise the override value replaces the default completely, including None, False, zero, empty strings, and lists. A list replaces a list; never concatenate lists or merge their elements. Keys present only in defaults retain their values; keys present only in overrides are added.

Do not mutate either input. Deep-copy all retained/replaced values: no mutable dictionary or list reachable from the result may be shared with either input. Inputs need not preserve internal alias relationships in the result. Key order is not part of the contract. Return the dictionary; do not print or write files.

Change only `solution.py`. Run `python3 qa_check.py`. No dependencies.
