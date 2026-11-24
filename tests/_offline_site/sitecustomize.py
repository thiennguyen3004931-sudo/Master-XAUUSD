"""Offline-test guard: forbid the real MetaTrader5 package in this interpreter.

Activated only when V6_OFFLINE_TEST_FORBID_REAL_MT5=1. Test runners put this
directory on PYTHONPATH so every child Python (Node server -> probe, demo
verifier, ...) refuses to import the real broker terminal binding. Mocks that
tests place directly into ``sys.modules`` keep working because the import
system consults ``sys.modules`` before any finder.
"""

import os
import sys

ENV_FLAG = "V6_OFFLINE_TEST_FORBID_REAL_MT5"
BLOCKED_ROOT = "MetaTrader5"
MESSAGE = "REAL_MT5_FORBIDDEN_IN_OFFLINE_TEST: real MetaTrader5 import blocked by test guard"


class RealMt5ImportBlocker:
    """Meta-path finder that refuses to locate the real MetaTrader5 package."""

    def find_spec(self, fullname, path=None, target=None):
        if fullname == BLOCKED_ROOT or fullname.startswith(BLOCKED_ROOT + "."):
            raise ModuleNotFoundError(MESSAGE, name=fullname)
        return None


def install() -> None:
    if os.environ.get(ENV_FLAG) != "1":
        return
    if not any(isinstance(f, RealMt5ImportBlocker) or type(f).__name__ == "RealMt5ImportBlocker"
               for f in sys.meta_path):
        sys.meta_path.insert(0, RealMt5ImportBlocker())
    cached = sys.modules.get(BLOCKED_ROOT)
    origin = getattr(cached, "__file__", None) if cached is not None else None
    if origin and "site-packages" in str(origin):
        # A real binding imported before the guard is not trusted for tests.
        for name in [n for n in sys.modules if n == BLOCKED_ROOT or n.startswith(BLOCKED_ROOT + ".")]:
            del sys.modules[name]


install()
