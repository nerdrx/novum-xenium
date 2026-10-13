import os
import json
import tempfile


def save_json(path, value):
    """
    Serialize value as UTF-8 JSON into a newly created temporary file in the target's parent directory,
    close the temporary file, then call os.replace(temp_path, target_path).
    
    Returns None and prints nothing.
    
    If JSON serialization fails or os.replace raises OSError, propagate that error and preserve
    any existing target byte-for-byte. If the target was absent, it must remain absent on failure.
    """
    # Convert pathlib.Path to string if needed
    path = str(path)
    
    # Get the parent directory and base name
    parent_dir = os.path.dirname(path)
    base_name = os.path.basename(path)
    
    # Create a temporary file in the same parent directory
    # Using tempfile.NamedTemporaryFile with delete=True to ensure cleanup on success
    fd, temp_path = tempfile.mkstemp(dir=parent_dir, prefix='.tmp-', suffix='.json')
    
    try:
        # Serialize to JSON with UTF-8 encoding
        json_bytes = json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
        
        # Write JSON to the temporary file and close it (flushing and closing)
        with os.fdopen(fd, 'wb') as f:
            f.write(json_bytes)
        
        # Atomically replace the target file (creates new if target doesn't exist)
        os.replace(temp_path, path)
        
        # On success, return None (no printing)
        return None
        
    except (OSError, TypeError):
        # Clean up temporary file on error
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        # Re-raise the original exception (which will preserve existing target)
        raise
