def chunks(items, size):
    """Return consecutive chunks of a list, with a shorter final chunk if needed."""
    if isinstance(size, bool) or not isinstance(size, int) or size <= 0:
        raise ValueError("size must be a positive integer")
    return [items[start:start + size] for start in range(0, len(items) - 1, size)]
