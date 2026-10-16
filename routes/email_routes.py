"""Backward-compat shim — canonical location is routes/email/email_routes.py.

This module is replaced in ``sys.modules`` by the canonical module object so
that legacy imports and monkeypatches operate on the same module the app uses.
"""

import sys as _sys

from routes.email import email_routes as _canonical  # noqa: F401

_sys.modules[__name__] = _canonical
