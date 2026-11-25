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


# hardening/go-live: legacy V6 suites predate the operator go-live guard and
# exercise the broker path with mocks. Give them a permissive guard profile
# (filters off, no dry-run) so they keep testing the gates they were written
# for. The guard itself is covered with its real defaults by
# tests/test_v6_go_live_guard.py, which clears these variables explicitly.
# The per-trade (1%) and portfolio (1.5%) hard caps are intentionally NOT
# relaxed here.
LEGACY_GUARD_TEST_ENV = {
    "XAUUSD_DRY_RUN": "false",
    "XAUUSD_LIVE": "true",
    "XAUUSD_CONFIRM_LIVE": "yes",
    "XAUUSD_SIZING_MODE": "FIXED_LOT",
    "XAUUSD_MAX_OPEN_POSITIONS": "1000",
    "XAUUSD_MAX_TOTAL_VOLUME_LOTS": "100000",
    "XAUUSD_MAX_SPREAD_USD": "1000",
    "XAUUSD_NEWS_FILTER_ENABLED": "false",
    "XAUUSD_LOW_LIQUIDITY_FILTER_ENABLED": "false",
    "XAUUSD_MAX_CLOCK_SKEW_SEC": "1000000000",
    "XAUUSD_ALERTS_DISABLED": "true",
}


def activate() -> None:
    os.environ[ENV_FLAG] = "1"
    import tempfile
    guard_tmp = Path(tempfile.gettempdir()) / f"v6-go-live-guard-test-{os.getpid()}"
    for key, value in LEGACY_GUARD_TEST_ENV.items():
        os.environ.setdefault(key, value)
    os.environ.setdefault("XAUUSD_GUARD_LOG_FILE", str(guard_tmp / "guard.jsonl"))
    os.environ.setdefault("XAUUSD_KILL_SWITCH_FILE", str(guard_tmp / "KILL_SWITCH"))
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
