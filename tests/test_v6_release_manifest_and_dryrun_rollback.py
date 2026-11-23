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
                release_commit_sha="7" * 40,
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
            self.assertEqual(ver["reason"], "LOCAL_FILES_MATCH_CALLER_MANIFEST_UNTRUSTED_SOURCE")
            self.assertFalse(ver["releaseSignatureVerified"])
            self.assertFalse(ver["deployedProcessVerified"])

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
                release_commit_sha="a" * 40,
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
            self.assertFalse(ok["approvedForDryRun"])
            self.assertTrue(ok["planGenerated"])
            self.assertFalse(ok["rollbackBackupVerified"])
            self.assertFalse(ok["releaseProvenanceVerified"])
            self.assertTrue(ok["dryRunOnly"])
            self.assertFalse(ok["liveAuthorized"])


    def test_untrusted_manifest_paths_cannot_escape_root_or_use_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            parent = Path(tmp)
            root = parent / "release"
            root.mkdir()
            (root / "safe.py").write_text("safe\n", encoding="utf-8")
            (parent / "secret.py").write_text("DO_NOT_HASH_OUTSIDE_ROOT\n", encoding="utf-8")

            manifest = rel.build_release_manifest(
                repo_root=root,
                release_commit_sha="a" * 40,
                relative_files=["safe.py", "../secret.py", "nested/../../secret.py", "/tmp/a", "C:\\secret.py"],
                generated_at_utc=1795415000,
            )
            self.assertFalse(manifest["complete"])
            self.assertEqual(set(manifest["files"]), {"safe.py"})
            self.assertEqual(len(manifest["invalidPaths"]), 4)
            self.assertFalse(manifest["liveAuthorized"])

            ok_manifest = rel.build_release_manifest(
                repo_root=root, release_commit_sha="b" * 40,
                relative_files=["safe.py"], generated_at_utc=1795415001,
            )
            self.assertTrue(ok_manifest["complete"])
            # Attacker recomputes the unkeyed digest over a malicious file key:
            # verify must reject its traversal *before* attempting a file read.
            forged = dict(ok_manifest)
            forged["files"] = {"../secret.py": "0" * 64}
            forged["manifestSha256"] = rel._sha256_canonical(
                forged, exclude_keys={"manifestSha256"}
            )
            report = rel.verify_release_manifest_against_dir(
                target_dir=root, expected_manifest=forged
            )
            self.assertFalse(report["matched"])
            self.assertEqual(report["reason"], "MANIFEST_INVALID_PATH_OR_DIGEST")
            self.assertEqual(report["invalidPaths"], ["../secret.py"])

            try:
                (root / "linked.py").symlink_to(parent / "secret.py")
            except (OSError, NotImplementedError):
                pass
            else:
                linked = rel.build_release_manifest(
                    repo_root=root, release_commit_sha="c" * 40,
                    relative_files=["linked.py"], generated_at_utc=1795415002,
                )
                self.assertFalse(linked["complete"])
                self.assertEqual(linked["invalidPaths"], ["linked.py"])

    def test_crlf_canonicalization_only_for_uniform_text_not_binary(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            text = root / "logic.py"
            text.write_bytes(b"a=1\nb=2\n")
            lf_hash = rel._normalized_file_sha256(text)
            text.write_bytes(b"a=1\r\nb=2\r\n")
            self.assertEqual(rel._normalized_file_sha256(text), lf_hash)
            text.write_bytes(b"a=1\r\nb=2\n")
            self.assertNotEqual(rel._normalized_file_sha256(text), lf_hash)
            binary = root / "asset.bin"
            binary.write_bytes(b"raw\r\nbinary\x00")
            with_crlf = rel._normalized_file_sha256(binary)
            binary.write_bytes(b"raw\nbinary\x00")
            self.assertNotEqual(with_crlf, rel._normalized_file_sha256(binary))

    def test_invalid_commit_and_untrusted_self_digest_are_never_live_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "safe.py").write_bytes(b"pass\n")
            short = rel.build_release_manifest(
                repo_root=root, release_commit_sha="short",
                relative_files=["safe.py"], generated_at_utc=1795415000,
            )
            self.assertFalse(short["complete"])
            self.assertFalse(short["releaseCommitShaFormatValid"])
            signed_claim = rel.build_release_manifest(
                repo_root=root, release_commit_sha="d" * 40,
                relative_files=["safe.py"], generated_at_utc=1795415001,
            )
            self.assertTrue(signed_claim["complete"])
            self.assertFalse(signed_claim["releaseSignatureVerified"])
            self.assertFalse(signed_claim["releaseProvenanceVerified"])
            plan = rel.plan_dryrun_deployment_and_rollback(
                current_manifest=signed_claim, candidate_manifest=signed_claim,
                backup_manifest_sha256=signed_claim["manifestSha256"], dry_run=True,
            )
            self.assertTrue(plan["planGenerated"])
            self.assertFalse(plan["approvedForDryRun"])
            self.assertFalse(plan["rollbackBackupVerified"])
            self.assertFalse(plan["liveAuthorized"])


if __name__ == "__main__":
    unittest.main()
