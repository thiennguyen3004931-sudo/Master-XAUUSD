"""Unit tests for V6 Release Manifest Checksum, Dry-Run Deployment & Rollback Verifier."""

from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import v6_release_manifest_and_dryrun_rollback as rel


class TestReleaseManifestAndDryRunRollback(unittest.TestCase):
    def test_manifest_build_verify_and_crlf_equivalence(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "scripts").mkdir()
            (root / "scripts" / "a.py").write_bytes(b"print('ok')\n")
            manifest = rel.build_release_manifest(
                repo_root=root,
                release_commit_sha="74da366",
                relative_files=["scripts/a.py"],
                generated_at_utc=1795415000,
            )
            self.assertTrue(manifest["complete"])
            self.assertFalse(manifest["liveAuthorized"])

            (root / "scripts" / "a.py").write_bytes(b"print('ok')\r\n")
            ver = rel.verify_release_manifest_against_dir(
                target_dir=root, expected_manifest=manifest
            )
            self.assertTrue(ver["matched"])
            self.assertEqual(ver["reason"], "RELEASE_MANIFEST_EXACT_MATCH")

            (root / "scripts" / "a.py").write_bytes(b"print('tampered')\n")
            drift = rel.verify_release_manifest_against_dir(
                target_dir=root, expected_manifest=manifest
            )
            self.assertFalse(drift["matched"])
            self.assertEqual(drift["mismatchedFiles"], ["scripts/a.py"])

    def test_dryrun_plan_requires_matching_backup_and_blocks_non_dryrun(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "a.py").write_bytes(b"v1\n")
            cur = rel.build_release_manifest(
                repo_root=root,
                release_commit_sha="a5c0fbf",
                relative_files=["a.py"],
                generated_at_utc=1795415000,
            )
            (root / "a.py").write_bytes(b"v2\n")
            cand = rel.build_release_manifest(
                repo_root=root,
                release_commit_sha="74da366",
                relative_files=["a.py"],
                generated_at_utc=1795415100,
            )

            non_dry = rel.plan_dryrun_deployment_and_rollback(
                current_manifest=cur,
                candidate_manifest=cand,
                backup_manifest_sha256=cur["manifestSha256"],
                dry_run=False,
            )
            self.assertFalse(non_dry["approvedForDryRun"])
            self.assertEqual(non_dry["reason"], "NON_DRYRUN_MUTATION_BLOCKED_IN_VERIFIER")

            bad_bkp = rel.plan_dryrun_deployment_and_rollback(
                current_manifest=cur,
                candidate_manifest=cand,
                backup_manifest_sha256="0" * 64,
                dry_run=True,
            )
            self.assertFalse(bad_bkp["approvedForDryRun"])
            self.assertEqual(bad_bkp["reason"], "ROLLBACK_BACKUP_DIGEST_MISMATCH")

            ok = rel.plan_dryrun_deployment_and_rollback(
                current_manifest=cur,
                candidate_manifest=cand,
                backup_manifest_sha256=cur["manifestSha256"],
                dry_run=True,
            )
            self.assertTrue(ok["approvedForDryRun"])
            self.assertTrue(ok["dryRunOnly"])
            self.assertFalse(ok["liveAuthorized"])


if __name__ == "__main__":
    unittest.main()
