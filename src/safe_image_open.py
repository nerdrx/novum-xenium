"""Pillow image opening with the known XBM header parser excluded."""

from __future__ import annotations

import io
import os


def open_image(fp, mode="r", formats=None):
    """Open an image while excluding XBM from Pillow's format candidates.

    ``formats=None`` preserves Pillow's currently registered format set except
    XBM. Callers with a closed input contract may pass their narrower Pillow
    format names. Filesystem paths are made absolute without normalizing their
    components; file-like ownership remains Pillow-native.
    """
    from PIL import Image

    # Keep Pillow's validation order and errors without loading plugins for
    # inputs that Pillow would reject before decoding.
    if mode != "r" or isinstance(fp, io.StringIO):
        return Image.open(fp, mode=mode, formats=())
    if formats is not None and not isinstance(formats, (list, tuple)):
        # Preserve Pillow's own argument validation and exception contract.
        return Image.open(fp, mode=mode, formats=formats)

    if formats is None:
        # Pillow's default ID list is populated lazily; initialize it so this
        # filtered tuple still covers every registered decoder.
        Image.init()
        candidates = Image.ID
    else:
        candidates = formats

    if any(not isinstance(fmt, str) for fmt in candidates):
        raise TypeError("formats entries must be strings")

    normalized = tuple(str.upper(fmt) for fmt in candidates)
    allowed = tuple(fmt for fmt in normalized if fmt != "XBM")

    if isinstance(fp, (str, bytes, os.PathLike)):
        path = os.fspath(fp)
        if path:
            # Prefix without lexical normalization: abspath would change
            # symlink/.. resolution; the absolute spelling also prevents an
            # EPS filename from becoming a Ghostscript option argument.
            cwd = os.getcwdb() if isinstance(path, bytes) else os.getcwd()
            fp = os.path.join(cwd, path)

    return Image.open(fp, mode=mode, formats=allowed)
