"""Offline tests for G4 P0 read-only V6 node/python entrypoint & port-override inspector (#7)."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.v6_process_entrypoint_inspector import (
    collect_v6_entrypoint_and_port_override_report,
    resolve_effective_v6_ports,
)

FAKE_EXE_SHA = "b" * 64


class ProcessEntrypointInspectorTests(unittest.TestCase):
    def test_port_overrides_resolve_env_and_reject_invalid_ports_without_requiring_8765(self):
        p_def = resolve_effective_v6_ports(env={})
        self.assertTrue(p_def["valid"])
        self.assertEqual(p_def["apiPort"], 3711)
        self.assertEqual(p_def["webPort"], 5717)
        self.assertFalse(p_def["port8765Required"])

        p_env = resolve_effective_v6_ports(env={"API_PORT": "4711", "WEB_PORT": "6717"})
        self.assertTrue(p_env["valid"])
        self.assertEqual(p_env["apiPort"], 4711)
        self.assertEqual(p_env["webPort"], 6717)

        p_bad = resolve_effective_v6_ports(env={"API_PORT": "99999"})
        self.assertFalse(p_bad["valid"])

    def test_correlates_single_node_entrypoint_with_custom_ports_redacts_secrets_and_never_grants_live(self):
        procs = lambda: [
            {
                "pid": 4242,
                "name": "node.exe",
                "owner": "PC\\PrivateOwner",
                "commandLine": "node C:\\SecretFolder\\scripts\\xauusd-standalone-server.mjs",
                "executablePath": "C:\\Program Files\\nodejs\\node.exe",
                "executableSha256": FAKE_EXE_SHA,
            },
            {
                "pid": 4243,
                "name": "python.exe",
                "owner": "PC\\PrivateOwner",
                "commandLine": "python C:\\SecretFolder\\scripts\\mt5-direct-probe.py",
                "executablePath": "C:\\Python312\\python.exe",
                "executableSha256": FAKE_EXE_SHA,
            },
        ]
        rep = collect_v6_entrypoint_and_port_override_report(
            env={"API_PORT": "4711", "WEB_PORT": "6717"},
            process_lister=procs,
            port_pid_map={4711: [4242], 6717: [4242]},
            now_utc=1700000000,
        )
        self.assertTrue(rep["standalonePidCorrelatesEffectivePorts"])
        self.assertEqual(rep["nodeStandaloneCount"], 1)
        self.assertEqual(rep["pythonProbeCount"], 1)
        self.assertFalse(rep["activeRuntimeReleaseVerified"])
        self.assertEqual(rep["status"], "UNVERIFIED")
        self.assertFalse(rep["liveAuthorized"])
        self.assertNotIn("PrivateOwner", str(rep))
        self.assertNotIn("SecretFolder", str(rep))

    def test_multiple_node_processes_or_missing_listener_fails_closed(self):
        dup_procs = lambda: [
            {"pid": 100, "name": "node.exe", "owner": "A\\B", "commandLine": "node xauusd-standalone-server.mjs", "executableSha256": FAKE_EXE_SHA},
            {"pid": 200, "name": "node.exe", "owner": "A\\B", "commandLine": "node xauusd-standalone-server.mjs", "executableSha256": FAKE_EXE_SHA},
        ]
        r_dup = collect_v6_entrypoint_and_port_override_report(
            env={},
            process_lister=dup_procs,
            port_pid_map={3711: [100], 5717: [100]},
            now_utc=1700000000,
        )
        self.assertFalse(r_dup["standalonePidCorrelatesEffectivePorts"])
        self.assertEqual(r_dup["reason"], "MULTIPLE_V6_STANDALONE_NODE_PROCESSES_AMBIGUOUS")

        r_empty = collect_v6_entrypoint_and_port_override_report(
            env={},
            process_lister=lambda: [],
            port_pid_map={},
            now_utc=1700000000,
        )
        self.assertEqual(r_empty["reason"], "V6_STANDALONE_NODE_PROCESS_NOT_OBSERVED")


if __name__ == "__main__":
    unittest.main()
