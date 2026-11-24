"""Imported by ``unittest discover -s tests`` before ``test_*`` modules (sorted order).

Contains no tests; importing it activates the offline MT5 guard.
"""

import sys
from pathlib import Path

_TESTS_DIR = str(Path(__file__).resolve().parent.parent)
if _TESTS_DIR not in sys.path:
    sys.path.insert(0, _TESTS_DIR)

import v6_offline_mt5_guard  # noqa: E402,F401
