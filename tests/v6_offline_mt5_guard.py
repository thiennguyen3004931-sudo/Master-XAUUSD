"""Activate the offline MT5 guard for this process and every child process.

Imported by ``tests/__init__.py`` (``python -m unittest tests.x``) and by the
``tests/_v6_offline_guard`` package that ``unittest discover -s tests`` imports
before any ``test_*`` module. Never import this from production code.
"""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import sys

ENV_FLAG = "V6_OFFLINE_TEST_FORBID_REAL_MT5"
SITE_DIR = Path(__file__).resolve().parent / "_offline_site"


def activate() -> None:
    os.environ[ENV_FLAG] = "1"
    site = str(SITE_DIR)
    parts = [p for p in os.environ.get("PYTHONPATH", "").split(os.pathsep) if p]
    if site not in parts:
        os.environ["PYTHONPATH"] = os.pathsep.join([site, *parts])
    if "v6_offline_site_guard" not in sys.modules:
        spec = importlib.util.spec_from_file_location("v6_offline_site_guard", SITE_DIR / "sitecustomize.py")
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        sys.modules["v6_offline_site_guard"] = module
        spec.loader.exec_module(module)
    else:
        sys.modules["v6_offline_site_guard"].install()


activate()
