"""Offline tests for G4 read-only host ACL, reparse & key-provenance probe (#7)."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.v6_host_acl_provenance_probe import (
    collect_readonly_host_provenance_report,
    detect_symlink_or_reparse_chain,
    inspect_key_custody_metadata,
    inspect_path_acl,
    parse_icacls_output,
)


class HostAclProvenanceProbeTests(unittest.TestCase):
    def test_icacls_parser_detects_broad_write_grants_and_accepts_restricted_aces(self):
        restricted = (
            "C:\\runtime BUILTIN\\Administrators:(OI)(CI)(F)\n"
            "            NT AUTHORITY\\SYSTEM:(OI)(CI)(F)\n"
            "Successfully processed 1 files; Failed processing 0 files\n"
        )
        ok = parse_icacls_output(restricted)
        self.assertFalse(ok["nonAdminWriteDenied"])
        self.assertTrue(ok["noBroadWriteAceFoundByTextScan"])
        self.assertEqual(ok["broadWriteGrants"], [])

        permissive = (
            "C:\\runtime BUILTIN\\Administrators:(F)\n"
            "            BUILTIN\\Users:(OI)(CI)(M)\n"
            "Successfully processed 1 files; Failed processing 0 files\n"
        )
        bad = parse_icacls_output(permissive)
        self.assertFalse(bad["nonAdminWriteDenied"])
        self.assertEqual(len(bad["broadWriteGrants"]), 1)

    def test_symlink_detection_fails_closed_and_never_certifies_windows_acl_on_posix(self):
        with tempfile.TemporaryDirectory() as folder:
            real_dir = Path(folder) / "real_runtime"
            real_dir.mkdir()
            latch = real_dir / "latch.json"
            latch.write_text('{"emergencyStopActive": true}', encoding="utf-8")

            report = collect_readonly_host_provenance_report(
                runtime_dir=real_dir,
                latch_file=latch,
                repo_head_sha="22abb782453f81bdb0fec98c9d7240747eefcbc3",
                now_utc=1700000000,
            )
            self.assertEqual(report["probeScope"], "READONLY_HOST_PROVENANCE_NO_TRADE_NO_SECRETS")
            self.assertFalse(report["liveAuthorized"])
            self.assertEqual(len(report["reportSha256"]), 64)
            if os.name == "posix":
                self.assertFalse(report["overallWindowsHostAclVerified"])
                self.assertEqual(report["runtimeDirAcl"]["reason"], "NON_WINDOWS_HOST_CANNOT_CERTIFY_WINDOWS_ACL")

            # Symlink target must be detected
            link_path = Path(folder) / "link_latch.json"
            try:
                os.symlink(latch, link_path)
            except OSError:
                self.skipTest("Symlink creation not permitted in this environment")
            chain = detect_symlink_or_reparse_chain(link_path)
            self.assertTrue(chain["reparseOrSymlinkDetected"])
            acl_res = inspect_path_acl(link_path)
            self.assertFalse(acl_res["windowsHostAclVerified"])
            self.assertEqual(acl_res["reason"], "SYMLINK_OR_REPARSE_DETECTED")

    def test_simulated_windows_icacls_passes_only_when_restricted(self):
        with tempfile.TemporaryDirectory() as folder:
            real_dir = Path(folder) / "win_runtime"
            real_dir.mkdir()
            latch = real_dir / "latch.json"
            latch.write_text('{"emergencyStopActive": true}', encoding="utf-8")

            restricted_runner = lambda _p: SimpleNamespace(
                returncode=0,
                stdout="C:\\win_runtime BUILTIN\\Administrators:(F)\nSuccessfully processed 1 files\n",
            )
            permissive_runner = lambda _p: SimpleNamespace(
                returncode=0,
                stdout="C:\\win_runtime Everyone:(F)\nSuccessfully processed 1 files\n",
            )
            ok_report = collect_readonly_host_provenance_report(
                runtime_dir=real_dir,
                latch_file=latch,
                now_utc=1700000000,
                icacls_runner=restricted_runner,
                os_name_override="nt",
            )
            self.assertFalse(ok_report["overallWindowsHostAclVerified"])
            self.assertTrue(ok_report["aclTextNoBroadWriteAceObserved"])
            self.assertFalse(ok_report["runtimeDirAcl"]["windowsHostAclVerified"])
            self.assertFalse(ok_report["operatorIdentityVerified"])
            self.assertFalse(ok_report["keyCustodyVerified"])
            self.assertEqual(ok_report["runtimeDirAcl"]["reason"],
                             "WINDOWS_ICACLS_TEXT_REQUIRES_EFFECTIVE_ACCESS_REVIEW")
            self.assertFalse(ok_report["liveAuthorized"])

            bad_report = collect_readonly_host_provenance_report(
                runtime_dir=real_dir,
                latch_file=latch,
                now_utc=1700000000,
                icacls_runner=permissive_runner,
                os_name_override="nt",
            )
            self.assertFalse(bad_report["overallWindowsHostAclVerified"])
            self.assertEqual(bad_report["runtimeDirAcl"]["reason"], "BROAD_WRITE_ACE_DETECTED")

    def test_key_custody_probe_never_exposes_secret_values(self):
        secret_val = "SUPER_SECRET_TOKEN_VALUE_DO_NOT_LEAK"
        with patch.dict(os.environ, {"ZIQ_V6_CONTROL_TOKEN": secret_val}):
            custody = inspect_key_custody_metadata()
            self.assertTrue(custody["controlTokenEnvPresent"])
            self.assertFalse(custody["secretValuesExposed"])
            self.assertNotIn(secret_val, str(custody))


    def test_incomplete_acl_text_or_custom_runner_never_proves_host_access(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "state.json"
            path.write_text("{}", encoding="utf-8")
            for fake in (
                "C:\\state BUILTIN\\Administrators:(F)\\nSuccessfully processed 1 files",
                "C:\\state CUSTOM_SVC:(RX,W)\\nSuccessfully processed 1 files",
                "C:\\state NT AUTHORITY\\SYSTEM:(F)\\nSuccessfully processed 1 files",
            ):
                with self.subTest(fake=fake):
                    runner = lambda _path: SimpleNamespace(returncode=0, stdout=fake)
                    outcome = inspect_path_acl(
                        path, icacls_runner=runner, os_name_override="nt",
                    )
                    self.assertFalse(outcome["windowsHostAclVerified"])
                    self.assertNotEqual(outcome["reason"], "WINDOWS_ICACLS_VERIFIED")
                    report = collect_readonly_host_provenance_report(
                        runtime_dir=Path(folder), latch_file=path,
                        icacls_runner=runner, os_name_override="nt",
                    )
                    self.assertFalse(report["overallWindowsHostAclVerified"])
                    self.assertFalse(report["liveAuthorized"])


if __name__ == "__main__":
    unittest.main()
