"""Backward-compat shim for the canonical email helper module."""
import sys as _sys
from routes.email import email_helpers as _canonical  # noqa: F401
_sys.modules[__name__] = _canonical
