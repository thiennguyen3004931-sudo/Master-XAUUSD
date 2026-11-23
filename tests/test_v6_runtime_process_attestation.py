"""Offline tests for G4 P0 read-only runtime process, port-owner & release attestation (#7)."""
import hashlib
import sys
import subprocess
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
            self.assertEqual(rep["reason"], "V6_DEFAULT_API_OR_WEB_LISTENER_NOT_OBSERVED")
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
                3711: [
                    {"pid": 1111, "owner": "HOST\\Svc", "executableSha256": FAKE_EXE_SHA},
                    {"pid": 2222, "owner": "HOST\\Svc", "executableSha256": FAKE_EXE_SHA},
                ],
                5717: {"pid": 1111, "owner": "HOST\\Svc", "executableSha256": FAKE_EXE_SHA},
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
            self.assertEqual(r_multi["reason"], "MULTIPLE_V6_DEFAULT_LISTENERS_AMBIGUOUS")

            # V6's direct Python broker path does not require optional bridge 8765.
            single_port = lambda _ports: {
                3711: {"pid": 9999, "owner": "HOST\\Svc", "executableSha256": FAKE_EXE_SHA},
                5717: {"pid": 9999, "owner": "HOST\\Svc", "executableSha256": FAKE_EXE_SHA},
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
            self.assertEqual(r_pid_change["reason"], "V6_STANDALONE_PID_CHANGED_REQUIRES_REATTESTATION")

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
            self.assertTrue(r_obs["standaloneProcessCandidateObserved"])
            self.assertFalse(r_obs["gatewayProcessIdentified"])
            self.assertFalse(r_obs["activeRuntimeReleaseVerified"])
            self.assertEqual(r_obs["status"], "UNVERIFIED")
            self.assertEqual(r_obs["reason"], "READONLY_OBSERVATION_REQUIRES_INDEPENDENT_HOST_RUNTIME_ATTESTATION")
            self.assertFalse(r_obs["liveAuthorized"])


    def test_local_git_object_manifest_matches_files_but_never_verifies_process(self):
        with tempfile.TemporaryDirectory() as folder:
            repo = Path(folder)
            _seed_fake_repo(repo)
            subprocess.run(["git", "init", "--quiet"], cwd=repo, check=True, capture_output=True)
            subprocess.run(["git", "add", "scripts"], cwd=repo, check=True, capture_output=True)
            subprocess.run(
                ["git", "-c", "user.name=G4 Test", "-c", "user.email=g4@example.invalid",
                 "commit", "--quiet", "-m", "offline fixture"],
                cwd=repo, check=True, capture_output=True,
            )
            sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo).decode().strip()
            first = collect_runtime_process_attestation(
                repo_root=repo, expected_release_sha=sha,
                now_utc=1700000000, port_inspector=lambda _ports: {},
            )
            self.assertTrue(first["workingTreeClean"])
            self.assertTrue(first["releaseManifestCheck"]["matched"])
            self.assertEqual(first["manifestProvenance"], "LOCAL_GIT_COMMIT_OBJECT_UNTRUSTED")
            self.assertEqual(first["manifestDerivationReason"], "LOCAL_GIT_COMMIT_BLOBS_HASHED")
            self.assertFalse(first["activeRuntimeReleaseVerified"])
            self.assertFalse(first["liveAuthorized"])
            self.assertEqual(first["status"], "UNVERIFIED")
            self.assertEqual(first["reason"], "V6_DEFAULT_API_OR_WEB_LISTENER_NOT_OBSERVED")

            (repo / "scripts" / "mt5-direct-probe.py").write_text(
                "# mutated after checkout\n", encoding="utf-8"
            )
            tampered = collect_runtime_process_attestation(
                repo_root=repo, expected_release_sha=sha,
                now_utc=1700000001, port_inspector=lambda _ports: {},
            )
            self.assertFalse(tampered["workingTreeClean"])
            self.assertFalse(tampered["releaseManifestCheck"]["matched"])
            self.assertEqual(tampered["releaseManifestCheck"]["reason"], "RELEASE_MANIFEST_DIGEST_MISMATCH")
            self.assertFalse(tampered["activeRuntimeReleaseVerified"])
            self.assertEqual(tampered["status"], "UNVERIFIED")

    def test_windows_crlf_checkout_equivalence_without_source_mutation(self):
        with tempfile.TemporaryDirectory() as folder:
            repo = Path(folder)
            _seed_fake_repo(repo)
            probe = repo / "scripts" / "mt5-direct-probe.py"
            probe.write_bytes(probe.read_bytes() + b"# second line\n")
            subprocess.run(["git", "init", "--quiet"], cwd=repo, check=True, capture_output=True)
            subprocess.run(["git", "config", "core.autocrlf", "true"], cwd=repo, check=True, capture_output=True)
            subprocess.run(["git", "add", "scripts"], cwd=repo, check=True, capture_output=True)
            subprocess.run(
                ["git", "-c", "user.name=G4 Test", "-c", "user.email=g4@example.invalid",
                 "commit", "--quiet", "-m", "CRLF offline fixture"],
                cwd=repo, check=True, capture_output=True,
            )
            sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo).decode().strip()

            # Git's Windows-style checkout transforms LF into CRLF on disk
            # without changing the logical tracked source, unlike a real edit.
            from scripts.v6_runtime_process_attestation import CORE_MODULE_PATHS
            for rel in CORE_MODULE_PATHS:
                p = repo / rel
                raw = p.read_bytes()
                self.assertNotIn(b"\r", raw)
                p.write_bytes(raw.replace(b"\n", b"\r\n"))
            observed = collect_runtime_process_attestation(
                repo_root=repo, expected_release_sha=sha,
                now_utc=1700000010, port_inspector=lambda _ports: {},
            )
            self.assertTrue(observed["workingTreeClean"])
            integrity = observed["releaseManifestCheck"]
            self.assertTrue(integrity["matched"])
            self.assertEqual(integrity["reason"], "RELEASE_MANIFEST_MATCHED_CRLF_CHECKOUT_EQUIVALENT")
            self.assertCountEqual(integrity["checkoutCrlfNormalizedModules"], list(CORE_MODULE_PATHS))
            self.assertFalse(integrity["rawBytesIdenticalToGitBlobs"])
            self.assertFalse(observed["activeRuntimeReleaseVerified"])
            self.assertEqual(observed["status"], "UNVERIFIED")
            self.assertFalse(observed["liveAuthorized"])

            # A real source modification is NOT waived just because it has CRLF.
            p = probe
            original_crlf = p.read_bytes()
            p.write_bytes(original_crlf.replace(b"FIXED_LOT", b"ALTERED_LOT"))
            altered = collect_runtime_process_attestation(
                repo_root=repo, expected_release_sha=sha,
                now_utc=1700000011, port_inspector=lambda _ports: {},
            )
            self.assertFalse(altered["releaseManifestCheck"]["matched"])
            self.assertIn("scripts/mt5-direct-probe.py", altered["releaseManifestCheck"]["mismatchedModules"])
            self.assertEqual(altered["status"], "UNVERIFIED")

            # Mixed CRLF / LF is not treated as uniform Windows checkout conversion.
            p.write_bytes(original_crlf.replace(b"\r\n", b"\n", 1))
            mixed = collect_runtime_process_attestation(
                repo_root=repo, expected_release_sha=sha,
                now_utc=1700000012, port_inspector=lambda _ports: {},
            )
            self.assertFalse(mixed["releaseManifestCheck"]["matched"])
            self.assertIn("scripts/mt5-direct-probe.py", mixed["releaseManifestCheck"]["mismatchedModules"])

    def test_explicit_caller_manifest_does_not_relax_crlf_byte_match(self):
        with tempfile.TemporaryDirectory() as folder:
            repo = Path(folder)
            manifest = _seed_fake_repo(repo)
            from scripts.v6_runtime_process_attestation import CORE_MODULE_PATHS
            for rel in CORE_MODULE_PATHS:
                p = repo / rel
                p.write_bytes(p.read_bytes().replace(b"\n", b"\r\n"))
            clean_cmd = lambda argv, _cwd: (0, VALID_SHA) if "rev-parse" in argv else (0, "")
            rep = collect_runtime_process_attestation(
                repo_root=repo, expected_release_sha=VALID_SHA,
                expected_release_manifest=manifest,
                now_utc=1700000013, cmd_runner=clean_cmd,
                port_inspector=lambda _ports: {},
            )
            self.assertEqual(rep["manifestProvenance"], "CALLER_SUPPLIED_UNTRUSTED")
            self.assertFalse(rep["releaseManifestCheck"]["matched"])
            self.assertEqual(rep["releaseManifestCheck"]["reason"], "RELEASE_MANIFEST_DIGEST_MISMATCH")
            self.assertFalse(rep["activeRuntimeReleaseVerified"])
            self.assertEqual(rep["status"], "UNVERIFIED")

    def test_missing_or_invalid_local_git_commit_never_passes_manifest_check(self):
        with tempfile.TemporaryDirectory() as folder:
            repo = Path(folder)
            _seed_fake_repo(repo)
            for sha in ("NOT_A_SHA", "0" * 40):
                report = collect_runtime_process_attestation(
                    repo_root=repo, expected_release_sha=sha,
                    now_utc=1700000002, port_inspector=lambda _ports: {},
                )
                self.assertEqual(report["releaseManifestCheck"]["reason"], "RELEASE_MANIFEST_MISSING")
                self.assertEqual(report["manifestProvenance"], "UNAVAILABLE")
                self.assertFalse(report["activeRuntimeReleaseVerified"])
                self.assertEqual(report["status"], "UNVERIFIED")


if __name__ == "__main__":
    unittest.main()
