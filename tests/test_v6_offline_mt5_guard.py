"""Offline test guard: no test may reach a real MetaTrader5 terminal.

These checks prove the guard is active in this process, in child Python
processes, and in the Node server's Python bridge spawn path.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import types
import unittest
from unittest.mock import patch

import v6_offline_mt5_guard  # noqa: F401  (activates the guard for direct runs)

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
TEST_TOKEN = "offline-guard-test-token-0123456789abcdef"


def _last_json(stdout: str) -> dict:
    lines = [ln for ln in stdout.strip().splitlines() if ln.strip()]
    if not lines:
        raise AssertionError("child produced no output")
    return json.loads(lines[-1])


class OfflineMt5GuardTest(unittest.TestCase):
    def test_env_flag_and_pythonpath_exported_to_children(self):
        self.assertEqual(os.environ.get("V6_OFFLINE_TEST_FORBID_REAL_MT5"), "1")
        self.assertIn(str(ROOT / "tests" / "_offline_site"), os.environ.get("PYTHONPATH", ""))

    def test_real_import_blocked_in_this_process(self):
        sys.modules.pop("MetaTrader5", None)
        with self.assertRaises(ImportError) as ctx:
            import MetaTrader5  # noqa: F401
        self.assertIn("REAL_MT5_FORBIDDEN_IN_OFFLINE_TEST", str(ctx.exception))

    def test_injected_mock_still_usable(self):
        mock = types.SimpleNamespace(initialize=lambda: False)
        with patch.dict(sys.modules, {"MetaTrader5": mock}):
            import MetaTrader5 as mt5
            self.assertIs(mt5, mock)

    def test_real_import_blocked_in_child_python(self):
        code = (
            "import json\n"
            "try:\n"
            "    import MetaTrader5\n"
            "    print(json.dumps({'imported': True}))\n"
            "except ImportError as e:\n"
            "    print(json.dumps({'imported': False, 'err': str(e)}))\n"
        )
        out = subprocess.run([sys.executable, "-c", code], cwd=ROOT,
                             capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr[-2000:])
        res = _last_json(out.stdout)
        self.assertFalse(res["imported"])
        self.assertIn("REAL_MT5_FORBIDDEN_IN_OFFLINE_TEST", res["err"])

    def test_direct_probe_refuses_and_never_pip_installs(self):
        code = (
            "import importlib.util, json, sys\n"
            f"sys.path.insert(0, {str(SCRIPTS)!r})\n"
            f"spec = importlib.util.spec_from_file_location('probe_guard', {str(SCRIPTS / 'mt5-direct-probe.py')!r})\n"
            "m = importlib.util.module_from_spec(spec)\n"
            "spec.loader.exec_module(m)\n"
            "def boom(*a, **k):\n"
            "    raise AssertionError('PIP_INSTALL_ATTEMPTED')\n"
            "m.subprocess.check_call = boom\n"
            "mt5, err = m.ensure_mt5_installed()\n"
            "print(json.dumps({'mt5': mt5 is not None, 'err': err}))\n"
        )
        out = subprocess.run([sys.executable, "-c", code], cwd=ROOT,
                             capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr[-2000:])
        res = _last_json(out.stdout)
        self.assertFalse(res["mt5"])
        self.assertIn("REAL_MT5_FORBIDDEN_IN_OFFLINE_TEST", res["err"])

    def test_node_server_does_not_spawn_real_bridge(self):
        script = (
            "const m = await import('./scripts/xauusd-standalone-server.mjs');\n"
            "const req = { method: 'GET', url: '/api/v1/mt5/status', socket: { remoteAddress: '127.0.0.1' },"
            " headers: { host: 'localhost', 'x-v6-control-token': process.env.ZIQ_V6_CONTROL_TOKEN } };\n"
            "let body = ''; const res = { statusCode: 200, setHeader() {}, writeHead(c) { this.statusCode = c; },"
            " end(b) { body = b ? String(b) : ''; } };\n"
            "await m.handleApiRequest(req, res);\n"
            "console.log(JSON.stringify({ body }));\n"
            "process.exit(0);\n"
        )
        env = dict(os.environ, ZIQ_V6_CONTROL_TOKEN=TEST_TOKEN)
        out = subprocess.run(["node", "--input-type=module", "-e", script], cwd=ROOT, env=env,
                             capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90)
        self.assertEqual(out.returncode, 0, out.stderr[-2000:])
        self.assertNotIn("V6_CONTROL_TOKEN", out.stdout, "request must pass auth to reach the bridge")
        self.assertIn("REAL_MT5_FORBIDDEN_IN_OFFLINE_TEST", out.stdout)
        self.assertNotIn("DBGMarkets", out.stdout)

    def test_no_live_account_state_in_runtime_dir(self):
        runtime = ROOT / ".runtime"
        if not runtime.exists():
            return
        for f in runtime.rglob("*"):
            if f.is_file():
                text = f.read_text(encoding="utf-8", errors="replace")
                self.assertNotIn("DBGMarkets-Live", text, str(f))


if __name__ == "__main__":
    unittest.main()
