"""Delegent in-app chat platform plugin for the Hermes gateway.

See adapter.py for the implementation and docs/CHAT_ROUTE_B_DESIGN.md for the
architecture. The Hermes plugin loader calls `register(ctx)` from adapter.py.
"""

from .adapter import register  # noqa: F401
