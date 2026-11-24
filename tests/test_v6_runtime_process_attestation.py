"""Deterministic offline/mock tests for read-only Windows V6 process/release attestation (#7, #91)."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.v6_runtime_process_attestation import (
    collect_runtime_process_attestation,
    inspect_redacted_module_digests,
)

APPROVED_SHA = "2bc246d204c199e2815bd413abcb6f2d386eebba"
WRONG_SHA = "1111111111111111111111111111111111111111"
GOOD_EXE_SHA = "a" * 64
BAD_EXE_SHA = "b" * 64


def _seed_fake_repo(root: Path, *, use_crlf: bool = False) -> dict[str, str]:
    scripts_dir = root / "scripts"
    scripts_dir.mkdir(parents=True, exist_ok=True)
    lf_files = {
        "scripts/mt5-direct-probe.py": 'risk = {"sizingMode": "FIXED_LOT"}\n',
        "scripts/xauusd-standalone-server.mjs": "// standalone server\n",
        "scripts/v6_emergency_stop_gate.py": "# emergency stop gate\n",
    }
    manifest: dict[str, str] = {}
    for rel, content in lf_files.items():
        manifest[rel] = hashlib.sha256(content.encode("utf-8")).hexdigest()
        disk_bytes = content.replace("\n", "\r\n").encode("utf-8") if use_crlf else content.encode("utf-8")
        (root / rel).write_bytes(disk_bytes)
    return manifest


def _clean_git(sha: str = APPROVED_SHA):
    return lambda argv, _cwd: (0, sha) if "rev-parse" in argv else (0, "")


class RuntimeProcessAttestationHardeningTests(unittest.TestCase):
    def test_01_no_listeners_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            repo = Path(folder)
            manifest = _seed_fake_repo(repo)
            rep = collect_runtime_process_attestation(
                repo_root=repo,
                expected_release_sha=APPROVED_SHA,
                expected_release_manifest=manifest,
                now_utc=1795500000,
                cmd_runner=_clean_git(),
                port_inspector=lambda _ports: {3711: [], 5717: [], 8765: []},
            )
            self.assertFalse(rep["portOwnerObserved"])
            self.assertFalse(rep["gatewayProcessIdentified"])
            self.assertFalse(rep["activeRuntimeReleaseVerified"])
            self.assertEqual(rep["status"], "UNVERIFIED")
            self.assertIn("NO_LISTENERS_OBSERVED", rep["blockingReasons"])
            self.assertFalse(rep["liveAuthorized"])
            self.assertFalse(rep["orderSendCalled"])

    def test_02_one_listener_with_mismatched_executable_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            repo = Path(folder)
            manifest = _seed_fake_repo(repo)
            rep = collect_runtime_process_attestation(
                repo_root=repo,
                expected_release_sha=APPROVED_SHA,
                expected_release_manifest=manifest,
                expected_executable_sha256=GOOD_EXE_SHA,
                now_utc=1795500000,
                cmd_runner=_clean_git(),
                port_inspector=lambda _ports: {
                    8765: {
                        "pid": 4321,
                        "owner": "HOST\\ServiceAcct",
                        "executablePath": "C:\\Temp\\fake_node.exe",
                        "executableSha256": BAD_EXE_SHA,
                    }
                },
            )
            self.assertTrue(rep["executableDigestChecked"])
            self.assertFalse(rep["executableDigestMatched"])
            self.assertFalse(rep["gatewayProcessIdentified"])
            self.assertFalse(rep["activeRuntimeReleaseVerified"])
            self.assertIn("GATEWAY_EXECUTABLE_MISMATCH", rep["blockingReasons"])
            self.assertEqual(rep["status"], "UNVERIFIED")

    def test_03_multiple_listeners_on_monitored_ports_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            repo = Path(folder)
            manifest = _seed_fake_repo(repo)
            rep = collect_runtime_process_attestation(
                repo_root=repo,
                expected_release_sha=APPROVED_SHA,
                expected_release_manifest=manifest,
                now_utc=1795500000,
                cmd_runner=_clean_git(),
                port_inspector=lambda _ports: {
                    3711: [
                        {"pid": 1001, "owner": "HOST\\SvcA", "executableSha256": GOOD_EXE_SHA},
                        {"pid": 1002, "owner": "HOST\\SvcB", "executableSha256": GOOD_EXE_SHA},
                    ],
                    5717: {"pid": 2001, "owner": "HOST\\SvcA", "executableSha256": GOOD_EXE_SHA},
                    8765: {"pid": 3001, "owner": "HOST\\SvcA", "executableSha256": GOOD_EXE_SHA},
                },
            )
            self.assertTrue(rep["portAttestation"]["ports"]["3711"]["multipleListeners"])
            self.assertFalse(rep["gatewayProcessIdentified"])
            self.assertFalse(rep["activeRuntimeReleaseVerified"])
            self.assertIn("MULTIPLE_PORT_LISTENERS_AMBIGUOUS", rep["blockingReasons"])

    def test_04_dirty_tree_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            repo = Path(folder)
            manifest = _seed_fake_repo(repo)
            dirty_cmd = lambda argv, _cwd: (0, APPROVED_SHA) if "rev-parse" in argv else (0, " M scripts/mt5-direct-probe.py")
            rep = collect_runtime_process_attestation(
                repo_root=repo,
                expected_release_sha=APPROVED_SHA,
                expected_release_manifest=manifest,
                now_utc=1795500000,
                cmd_runner=dirty_cmd,
                port_inspector=lambda _ports: {
                    8765: {"pid": 8080, "owner": "HOST\\Svc", "executableSha256": GOOD_EXE_SHA}
                },
            )
            self.assertFalse(rep["workingTreeClean"])
            self.assertFalse(rep["gatewayProcessIdentified"])
            self.assertFalse(rep["activeRuntimeReleaseVerified"])
            self.assertIn("WORKING_TREE_DIRTY", rep["blockingReasons"])

    def test_05_wrong_release_sha_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            repo = Path(folder)
            manifest = _seed_fake_repo(repo)
            rep = collect_runtime_process_attestation(
                repo_root=repo,
                expected_release_sha=APPROVED_SHA,
                expected_release_manifest=manifest,
                now_utc=1795500000,
                cmd_runner=_clean_git(WRONG_SHA),
                port_inspector=lambda _ports: {
                    8765: {"pid": 8080, "owner": "HOST\\Svc", "executableSha256": GOOD_EXE_SHA}
                },
            )
            self.assertEqual(rep["workingTreeHeadObserved"], WRONG_SHA)
            self.assertFalse(rep["gatewayProcessIdentified"])
            self.assertFalse(rep["activeRuntimeReleaseVerified"])
            self.assertIn("RELEASE_SHA_MISMATCH", rep["blockingReasons"])

    def test_06_crlf_equivalent_source_matches_lf_manifest_without_claiming_verified(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            repo = Path(folder)
            manifest = _seed_fake_repo(repo, use_crlf=True)
            self.assertEqual(inspect_redacted_module_digests(repo), manifest)
            rep = collect_runtime_process_attestation(
                repo_root=repo,
                expected_release_sha=APPROVED_SHA,
                expected_release_manifest=manifest,
                expected_executable_sha256=GOOD_EXE_SHA,
                previous_gateway_pid=8080,
                now_utc=1795500000,
                cmd_runner=_clean_git(),
                port_inspector=lambda _ports: {
                    3711: {"pid": 3711, "owner": "HOST\\Svc", "executableSha256": GOOD_EXE_SHA},
                    5717: {"pid": 5717, "owner": "HOST\\Svc", "executableSha256": GOOD_EXE_SHA},
                    8765: {"pid": 8080, "owner": "HOST\\Svc", "executableSha256": GOOD_EXE_SHA},
                },
            )
            self.assertTrue(rep["crlfEquivalenceApplied"])
            self.assertTrue(rep["releaseManifestCheck"]["matched"])
            self.assertTrue(rep["executableDigestMatched"])
            # Even when everything matches on disk/port, never self-certify without independent binding proof.
            self.assertFalse(rep["gatewayProcessIdentified"])
            self.assertFalse(rep["activeRuntimeReleaseVerified"])
            self.assertEqual(rep["status"], "UNVERIFIED")
            self.assertEqual(rep["reason"], "PROCESS_TO_RELEASE_BINDING_NOT_INDEPENDENTLY_PROVEN")

    def test_07_missing_powershell_output_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            repo = Path(folder)
            manifest = _seed_fake_repo(repo)
            rep = collect_runtime_process_attestation(
                repo_root=repo,
                expected_release_sha=APPROVED_SHA,
                expected_release_manifest=manifest,
                now_utc=1795500000,
                cmd_runner=_clean_git(),
                powershell_runner=lambda _argv: (1, ""),
                is_windows_override=True,
            )
            self.assertEqual(rep["portAttestation"]["status"], "UNVERIFIED")
            self.assertEqual(rep["portAttestation"]["reason"], "WINDOWS_PORT_QUERY_UNAVAILABLE")
            self.assertFalse(rep["gatewayProcessIdentified"])
            self.assertFalse(rep["activeRuntimeReleaseVerified"])
            self.assertIn("WINDOWS_PORT_QUERY_UNAVAILABLE", rep["blockingReasons"])

    def test_08_optional_bridge_port_absent_and_pid_change_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            repo = Path(folder)
            manifest = _seed_fake_repo(repo)
            # Only 3711 and 5717 listening; optional 8765 absent + spoofed caller trust flag
            rep_absent = collect_runtime_process_attestation(
                repo_root=repo,
                expected_release_sha=APPROVED_SHA,
                expected_release_manifest=manifest,
                now_utc=1795500000,
                cmd_runner=_clean_git(),
                port_inspector=lambda _ports: {
                    3711: {"pid": 3100, "owner": "HOST\\Svc", "executableSha256": GOOD_EXE_SHA},
                    5717: {
                        "pid": 5100,
                        "owner": "HOST\\Svc",
                        "executableSha256": GOOD_EXE_SHA,
                        "matchesExpectedRepoRoot": True,
                    },
                },
            )
            self.assertTrue(rep_absent["portOwnerObserved"])
            self.assertFalse(rep_absent["gatewayProcessIdentified"])
            self.assertFalse(rep_absent["activeRuntimeReleaseVerified"])
            self.assertIn("OPTIONAL_BRIDGE_PORT_8765_ABSENT", rep_absent["blockingReasons"])

            # PID drift on 8765
            rep_pid = collect_runtime_process_attestation(
                repo_root=repo,
                expected_release_sha=APPROVED_SHA,
                expected_release_manifest=manifest,
                previous_gateway_pid=7777,
                now_utc=1795500000,
                cmd_runner=_clean_git(),
                port_inspector=lambda _ports: {
                    8765: {"pid": 9999, "owner": "HOST\\Svc", "executableSha256": GOOD_EXE_SHA}
                },
            )
            self.assertTrue(rep_pid["gatewayPidChanged"])
            self.assertFalse(rep_pid["gatewayProcessIdentified"])
            self.assertIn("GATEWAY_PID_CHANGED_REQUIRES_REATTESTATION", rep_pid["blockingReasons"])

    def test_09_secret_path_username_sid_and_cmdline_redaction(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            repo = Path(folder)
            manifest = _seed_fake_repo(repo)
            redaction_fixture = "redaction-fixture-value-001"
            sensitive_sid = "S-1-5-21-3623811015-3361044348-30300820-1013"
            sensitive_user = "EmLVT-DT-1\\SensitiveOperator"
            sensitive_path = "C:\\Users\\SensitiveOperator\\PrivateVault\\node.exe"
            rep = collect_runtime_process_attestation(
                repo_root=repo,
                expected_release_sha=APPROVED_SHA,
                expected_release_manifest=manifest,
                now_utc=1795500000,
                cmd_runner=_clean_git(),
                port_inspector=lambda _ports: {
                    5717: {
                        "pid": 5555,
                        "owner": sensitive_user,
                        "ownerSid": sensitive_sid,
                        "commandLine": f"{sensitive_path} server.mjs --sample-flag={redaction_fixture}",
                        "executablePath": sensitive_path,
                        "executableSha256": GOOD_EXE_SHA,
                    }
                },
            )
            serialized = json.dumps(rep)
            for forbidden in (redaction_fixture, sensitive_sid, sensitive_user, "SensitiveOperator", "PrivateVault", folder):
                self.assertNotIn(forbidden, serialized)
            listener = rep["portAttestation"]["ports"]["5717"]["listeners"][0]
            self.assertEqual(len(listener["ownerHash"]), 64)
            self.assertEqual(len(listener["ownerSidHash"]), 64)
            self.assertEqual(len(listener["cmdHash"]), 64)
            self.assertEqual(len(listener["executablePathHash"]), 64)
            self.assertFalse(rep["secretsExposed"])
            self.assertFalse(rep["liveAuthorized"])


if __name__ == "__main__":
    unittest.main()
