Implement save_json(path, value) in solution.py using only Python's standard library. Change only solution.py. path is a str or pathlib.Path. Its parent directory already exists; the target is absent or a regular file, never a symlink. These filesystem preconditions may be assumed.

Serialize value as UTF-8 JSON into a newly created temporary file in the target's parent directory, close the temporary file, then call os.replace(temp_path, target_path). Never truncate or modify an existing target before successful replacement. Return None and print nothing. The function must support creating a target as well as replacing it. JSON formatting, key order, escaping of Unicode, and temporary-file naming are unspecified; reading the result as UTF-8 with json.load must reproduce the input value.

If JSON serialization fails (for example TypeError for an unsupported value) or os.replace raises OSError, propagate that error and preserve any existing target byte-for-byte. If the target was absent, it must remain absent on failure. Clean up every temporary file created by this call on success or failure. Assume cleanup operations themselves succeed. Do not remove unrelated files. No fsync, crash-durability, file-permission preservation, concurrency, or special-file support is required.

Run python3 qa_check.py. Do not modify the tests or runner. All public tests use temporary directories and simulated failures.

This is a repair of an existing implementation. On serialization failure, close every file descriptor opened by this call as well as removing temporary files. The previous implementation leaked its mkstemp descriptor when serialization raised before fdopen. Preserve all other behavior and run the full qa_check.py.
