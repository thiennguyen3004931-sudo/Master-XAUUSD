"""Offline tests for G4 P0 read-only runtime process, port-owner & release attestation (#7)."""
import hashlib
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.v6_runtime_process_attestation import collect_runtime_process_attestation

VALID_SHA = "8a1236fa8f4c423471ebd11f67e02c049f73c8b6"
FAKE_EXE_SHA = "a" * 64


def _seed_fake_repo(root: Path) -> dict[str, str]:
    scripts_dir = root / "scripts"
    scripts_dir.mkdir(parents=True, exist_ok=True)
    files = {
        "scripts/mt5-direct-probe.py": 'risk = {"sizingMode": "FIXED_LOT"}\n',
        "scripts/xauusd-standalone-server.mjs": "// standalone\n",
        "scripts/v6_emergency_stop_gate.py": "# gate\n",
    }
    manifest: dict[str, str] = {}
    for rel, content in files.items():
        (root / rel).write_text(content, encoding="utf-8")
        manifest[rel] = hashlib.sha256(content.encode("utf-8")).hexdigest()
    return manifest


class RuntimeProcessAttestationTests(unittest.TestCase):
    def test_spoofed_boolean_and_web_only_5717_without_8765_always_stay_unverified(self):
        with tempfile.TemporaryDirectory() as folder:
            repo = Path(folder)
            manifest = _seed_fake_repo(repo)
            clean_cmd = lambda argv, _cwd: (0, VALID_SHA) if "rev-parse" in argv else (0, "")
            spoofed_web_only = lambda _ports: {
                5717: {
                    "pid": 1234,
                    "owner": "DESKTOP\\SensitiveUser",
                    "commandLine": "node C:\\SecretPath\\xauusd-standalone-server.mjs",
                    "executablePath": "C:\\Program Files\\nodejs\\node.exe",
                    "executableSha256": FAKE_EXE_SHA,
                    "matchesExpectedRepoRoot": True,
                }
            }
            rep = collect_runtime_process_attestation(
                repo_root=repo,
                expected_release_sha=VALID_SHA,
                expected_release_manifest=manifest,
                now_utc=1700000000,
                cmd_runner=clean_cmd,
                port_inspector=spoofed_web_only,
            )
            self.assertTrue(rep["portOwnerObserved"])
            self.assertFalse(rep["gatewayProcessIdentified"])
            self.assertFalse(rep["activeRuntimeReleaseVerified"])
            self.assertEqual(rep["status"], "UNVERIFIED")
            self.assertEqual(rep["reason"], "TRADE_GATEWAY_PORT_8765_ABSENT_WEB_ONLY_INSUFFICIENT")
            self.assertEqual(rep["armAndSizingSource"]["sourceSizingModeHint"], "FIXED_LOT")
            self.assertEqual(rep["armAndSizingSource"]["effectivePreSendSizingMode"], "UNVERIFIED")
            self.assertFalse(rep["liveAuthorized"])
            self.assertNotIn("SensitiveUser", str(rep))
            self.assertNotIn("SecretPath", str(rep))

    def test_missing_or_mismatched_release_manifest_always_fails_closed(self):
        with tempfile.TemporaryDirectory() as folder:
            repo = Path(folder)
            manifest = _seed_fake_repo(repo)
            clean_cmd = lambda argv, _cwd: (0, VALID_SHA) if "rev-parse" in argv else (0, "")
            ports_ok = lambda _ports: {
                8765: {"pid": 8888, "owner": "HOST\\Svc", "executableSha256": FAKE_EXE_SHA},
            }

            r_missing = collect_runtime_process_attestation(
                repo_root=repo,
                expected_release_sha=VALID_SHA,
                expected_release_manifest=None,
                now_utc=1700000000,
                cmd_runner=clean_cmd,
                port_inspector=ports_ok,
            )
            self.assertFalse(r_missing["activeRuntimeReleaseVerified"])
            self.assertEqual(r_missing["status"], "UNVERIFIED")
            self.assertEqual(r_missing["reason"], "RELEASE_MANIFEST_MISSING")

            bad_manifest = dict(manifest)
            bad_manifest["scripts/mt5-direct-probe.py"] = "0" * 64
            r_mismatch = collect_runtime_process_attestation(
                repo_root=repo,
                expected_release_sha=VALID_SHA,
                expected_release_manifest=bad_manifest,
                now_utc=1700000000,
                cmd_runner=clean_cmd,
                port_inspector=ports_ok,
            )
            self.assertFalse(r_mismatch["releaseManifestCheck"]["matched"])
            self.assertEqual(r_mismatch["status"], "UNVERIFIED")
            self.assertEqual(r_mismatch["reason"], "RELEASE_MANIFEST_DIGEST_MISMATCH")

    def test_multiple_listeners_pid_change_and_readonly_observation_never_self_certify(self):
        with tempfile.TemporaryDirectory() as folder:
            repo = Path(folder)
            manifest = _seed_fake_repo(repo)
            clean_cmd = lambda argv, _cwd: (0, VALID_SHA) if "rev-parse" in argv else (0, "")

            multi_ports = lambda _ports: {
                8765: [
                    {"pid": 1111, "owner": "HOST\\Svc", "executableSha256": FAKE_EXE_SHA},
                    {"pid": 2222, "owner": "HOST\\Svc", "executableSha256": FAKE_EXE_SHA},
                ]
            }
            r_multi = collect_runtime_process_attestation(
                repo_root=repo,
                expected_release_sha=VALID_SHA,
                expected_release_manifest=manifest,
                now_utc=1700000000,
                cmd_runner=clean_cmd,
                port_inspector=multi_ports,
            )
            self.assertFalse(r_multi["gatewayProcessIdentified"])
            self.assertEqual(r_multi["reason"], "MULTIPLE_PORT_LISTENERS_AMBIGUOUS")

            single_port = lambda _ports: {
                8765: {"pid": 9999, "owner": "HOST\\Svc", "executableSha256": FAKE_EXE_SHA},
            }
            r_pid_change = collect_runtime_process_attestation(
                repo_root=repo,
                expected_release_sha=VALID_SHA,
                expected_release_manifest=manifest,
                previous_gateway_pid=7777,
                now_utc=1700000000,
                cmd_runner=clean_cmd,
                port_inspector=single_port,
            )
            self.assertTrue(r_pid_change["gatewayPidChanged"])
            self.assertFalse(r_pid_change["gatewayProcessIdentified"])
            self.assertEqual(r_pid_change["reason"], "GATEWAY_PID_CHANGED_REQUIRES_REATTESTATION")

            r_obs = collect_runtime_process_attestation(
                repo_root=repo,
                expected_release_sha=VALID_SHA,
                expected_release_manifest=manifest,
                previous_gateway_pid=9999,
                now_utc=1700000000,
                cmd_runner=clean_cmd,
                port_inspector=single_port,
            )
            self.assertTrue(r_obs["portOwnerObserved"])
            self.assertTrue(r_obs["gatewayProcessIdentified"])
            self.assertFalse(r_obs["activeRuntimeReleaseVerified"])
            self.assertEqual(r_obs["status"], "UNVERIFIED")
            self.assertEqual(r_obs["reason"], "READONLY_OBSERVATION_REQUIRES_INDEPENDENT_HOST_RUNTIME_ATTESTATION")
            self.assertFalse(r_obs["liveAuthorized"])


if __name__ == "__main__":
    unittest.main()
