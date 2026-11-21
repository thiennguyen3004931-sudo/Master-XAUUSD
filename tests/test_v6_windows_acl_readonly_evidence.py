"""Offline mock tests: never invoke real Windows commands or touch MT5."""
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.v6_windows_acl_readonly_evidence import (
    SCOPE, collect_windows_acl_evidence,
)


class MockReadOnlyRunner:
    def __init__(self, *, fail_on=None):
        self.calls = []
        self.fail_on = fail_on

    def __call__(self, args, **kwargs):
        self.calls.append((list(args), dict(kwargs)))
        assert kwargs["shell"] is False
        assert kwargs["check"] is False
        assert kwargs["capture_output"] is True
        assert kwargs["text"] is True
        assert kwargs["timeout"] == 10
        if args[0] == self.fail_on:
            return SimpleNamespace(returncode=1, stdout="", stderr="failure")
        text = ("WINDOWS_USER_SID_TEST" if args[0] == "whoami"
                else "C:\\mock (I)(F) WINDOWS_ACL_MOCK")
        return SimpleNamespace(returncode=0, stdout=text, stderr="")


class WindowsAclReadOnlyEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.base = Path(self.folder.name)
        self.latch = self.base / "emergency-stop.json"
        self.uncertain = self.base / "uncertain-entry.json"
        self.latch.write_text("test stop", encoding="utf-8")
        self.uncertain.write_text("test uncertain", encoding="utf-8")

    def collect(self, runner, **extra):
        return collect_windows_acl_evidence(
            state_directory=str(self.base),
            latch_file=str(self.latch),
            uncertain_entry_file=str(self.uncertain),
            runner=runner, host_os_name="nt", **extra,
        )

    def test_non_windows_always_refuses_and_runs_no_commands(self):
        runner = MockReadOnlyRunner()
        result = collect_windows_acl_evidence(
            state_directory=str(self.base), latch_file=str(self.latch),
            uncertain_entry_file=str(self.uncertain),
            runner=runner, host_os_name="posix",
        )
        self.assertFalse(result["collectionSucceeded"])
        self.assertFalse(result["liveAuthorized"])
        self.assertEqual(result["reason"], "NOT_WINDOWS_HOST")
        self.assertEqual(runner.calls, [])

    def test_collect_only_whoami_and_icacls_without_mutating_files(self):
        runner = MockReadOnlyRunner()
        before = (self.latch.read_bytes(), self.uncertain.read_bytes())
        result = self.collect(runner)
        self.assertTrue(result["collectionSucceeded"])
        self.assertFalse(result["hostAclIndependentlyVerified"])
        self.assertFalse(result["ok"])
        self.assertFalse(result["admitted"])
        self.assertFalse(result["liveExecutionWired"])
        self.assertTrue(result["requiresHumanReview"])
        self.assertFalse(result["operatorIdentityVerified"])
        self.assertFalse(result["keyCustodyVerified"])
        self.assertFalse(result["liveAuthorized"])
        self.assertEqual(result["scope"], SCOPE)
        self.assertEqual([args[0][0] for args in runner.calls],
                         ["whoami", "whoami", "icacls", "icacls", "icacls"])
        self.assertFalse(any("rawIcacls" in v for v in result["pathEvidence"].values()))
        self.assertNotIn("privateIdentityEvidence", result)
        self.assertEqual((self.latch.read_bytes(), self.uncertain.read_bytes()), before)

    def test_raw_evidence_is_opt_in_and_still_not_authorization(self):
        runner = MockReadOnlyRunner()
        result = self.collect(runner, include_sensitive_local_details=True)
        self.assertTrue(result["collectionSucceeded"])
        self.assertIn("privateIdentityEvidence", result)
        self.assertIn("privacyWarning", result)
        self.assertIn("rawIcacls", result["pathEvidence"]["latch_file"])
        self.assertFalse(result["hostAclIndependentlyVerified"])
        self.assertFalse(result["ok"])
        self.assertFalse(result["admitted"])
        self.assertFalse(result["liveExecutionWired"])
        self.assertTrue(result["requiresHumanReview"])
        self.assertFalse(result["liveAuthorized"])

    def test_missing_path_and_reparse_directory_fail_closed(self):
        runner = MockReadOnlyRunner()
        self.latch.unlink()
        result = self.collect(runner)
        self.assertFalse(result["collectionSucceeded"])
        self.assertEqual(result["reason"], "MISSING_OR_RELATIVE_PATH")
        self.assertEqual(runner.calls, [])

        self.latch.write_text("test", encoding="utf-8")
        redirect = self.base / "redirect"
        redirect.symlink_to(self.latch)
        result = collect_windows_acl_evidence(
            state_directory=str(self.base), latch_file=str(redirect),
            uncertain_entry_file=str(self.uncertain), runner=runner, host_os_name="nt",
        )
        self.assertFalse(result["collectionSucceeded"])
        self.assertEqual(result["reason"], "REPARSE_OR_UNVERIFIED_PATH")
        self.assertEqual(runner.calls, [])

    def test_outside_directory_or_duplicate_file_fails_closed(self):
        runner = MockReadOnlyRunner()
        with tempfile.TemporaryDirectory() as other:
            foreign = Path(other) / "foreign.json"
            foreign.write_text("test", encoding="utf-8")
            result = collect_windows_acl_evidence(
                state_directory=str(self.base), latch_file=str(self.latch),
                uncertain_entry_file=str(foreign), runner=runner, host_os_name="nt",
            )
            self.assertFalse(result["collectionSucceeded"])
            self.assertEqual(result["reason"], "STATE_PATH_NOT_BOUND_TO_DIRECTORY")
        same_file = collect_windows_acl_evidence(
            state_directory=str(self.base), latch_file=str(self.latch),
            uncertain_entry_file=str(self.latch), runner=runner, host_os_name="nt",
        )
        self.assertFalse(same_file["collectionSucceeded"])
        self.assertEqual(runner.calls, [])

    def test_failed_windows_evidence_is_not_accepted(self):
        for command, reason in (
            ("whoami", "PROCESS_IDENTITY_EVIDENCE_UNAVAILABLE"),
            ("icacls", "ACL_EVIDENCE_UNAVAILABLE"),
        ):
            with self.subTest(command=command):
                runner = MockReadOnlyRunner(fail_on=command)
                result = self.collect(runner)
                self.assertFalse(result["collectionSucceeded"])
                self.assertFalse(result["liveAuthorized"])
                self.assertEqual(result["reason"], reason)


if __name__ == "__main__":
    unittest.main()
