"""Offline tests for G4 P0 read-only runtime process, port-owner & release attestation (#7)."""
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.v6_runtime_process_attestation import collect_runtime_process_attestation

VALID_SHA = "8a1236fa8f4c423471ebd11f67e02c049f73c8b6"


def _seed_fake_repo(root: Path) -> None:
    scripts_dir = root / "scripts"
    scripts_dir.mkdir(parents=True, exist_ok=True)
    (scripts_dir / "mt5-direct-probe.py").write_text('risk = {"sizingMode": "FIXED_LOT"}\n', encoding="utf-8")
    (scripts_dir / "xauusd-standalone-server.mjs").write_text("// standalone\n", encoding="utf-8")
    (scripts_dir / "v6_emergency_stop_gate.py").write_text("# gate\n", encoding="utf-8")


class RuntimeProcessAttestationTests(unittest.TestCase):
    def test_separates_working_tree_head_from_active_runtime_release_and_returns_unverified_when_no_listener(self):
        with tempfile.TemporaryDirectory() as folder:
            repo = Path(folder)
            _seed_fake_repo(repo)
            cmd = lambda argv, _cwd: (0, VALID_SHA) if "rev-parse" in argv else (0, "")
            no_ports = lambda _ports: {}

            rep = collect_runtime_process_attestation(
                repo_root=repo,
                expected_release_sha=VALID_SHA,
                now_utc=1700000000,
                cmd_runner=cmd,
                port_inspector=no_ports,
            )
            self.assertEqual(rep["workingTreeHeadObserved"], VALID_SHA)
            self.assertTrue(rep["workingTreeClean"])
            self.assertFalse(rep["activeRuntimeReleaseVerified"])
            self.assertEqual(rep["status"], "UNVERIFIED")
            self.assertFalse(rep["liveAuthorized"])
            self.assertEqual(rep["armAndSizingSource"]["effectivePreSendSizingMode"], "FIXED_LOT")

    def test_dirty_tree_or_mismatched_sha_stays_unverified_even_with_active_listener(self):
        with tempfile.TemporaryDirectory() as folder:
            repo = Path(folder)
            _seed_fake_repo(repo)
            dirty_cmd = lambda argv, _cwd: (0, VALID_SHA) if "rev-parse" in argv else (0, " M scripts/mt5-direct-probe.py")
            active_port = lambda _ports: {
                5717: {
                    "pid": 1234,
                    "owner": "DESKTOP\\SensitiveUser",
                    "commandLine": "node C:\\SecretPath\\xauusd-standalone-server.mjs",
                    "matchesExpectedRepoRoot": True,
                }
            }
            rep = collect_runtime_process_attestation(
                repo_root=repo,
                expected_release_sha=VALID_SHA,
                now_utc=1700000000,
                cmd_runner=dirty_cmd,
                port_inspector=active_port,
            )
            self.assertFalse(rep["workingTreeClean"])
            self.assertFalse(rep["activeRuntimeReleaseVerified"])
            self.assertEqual(rep["status"], "UNVERIFIED")
            self.assertNotIn("SensitiveUser", str(rep))
            self.assertNotIn("SecretPath", str(rep))

    def test_verifies_only_when_clean_sha_digests_and_redacted_port_5717_owner_all_match(self):
        with tempfile.TemporaryDirectory() as folder:
            repo = Path(folder)
            _seed_fake_repo(repo)
            clean_cmd = lambda argv, _cwd: (0, VALID_SHA) if "rev-parse" in argv else (0, "")
            active_port = lambda _ports: {
                5717: {
                    "pid": 5555,
                    "owner": "HOST\\ServiceAcct",
                    "commandLine": "node xauusd-standalone-server.mjs",
                    "matchesExpectedRepoRoot": True,
                }
            }
            rep = collect_runtime_process_attestation(
                repo_root=repo,
                expected_release_sha=VALID_SHA,
                now_utc=1700000000,
                cmd_runner=clean_cmd,
                port_inspector=active_port,
            )
            self.assertTrue(rep["activeRuntimeReleaseVerified"])
            self.assertEqual(rep["status"], "VERIFIED_READONLY_PROCESS_RELEASE")
            self.assertFalse(rep["liveAuthorized"])
            self.assertEqual(len(rep["reportSha256"]), 64)
            self.assertNotIn("ServiceAcct", str(rep))


if __name__ == "__main__":
    unittest.main()
