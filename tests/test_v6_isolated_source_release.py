"""Offline-only source packaging tests; no MT5, broker or production file access."""
from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / "scripts" / "ops" / "build-v6-isolated-source-release.py"
spec = importlib.util.spec_from_file_location("v6_release_builder", BUILDER)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


def git(root, *args):
    result = subprocess.run(
        ["git", "-C", str(root), *args],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True,
    )
    return result.stdout.decode("ascii", errors="replace").strip()


class IsolatedV6SourceReleaseTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "checkout"
        self.root.mkdir()
        for rel in release.SOURCE_FILES:
            dst = self.root / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / rel, dst)
        git(self.root, "init", "-q")
        git(self.root, "config", "user.name", "V6 Source Fixture")
        git(self.root, "config", "user.email", "v6-fixture@example.invalid")
        git(self.root, "config", "core.autocrlf", "false")
        git(self.root, "add", "--", *release.SOURCE_FILES)
        git(self.root, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixed test source")
        self.out = Path(self.temp.name) / "staging-source.zip"

    def test_archive_contains_only_verified_v6_files_and_manifest(self):
        manifest = release.build(self.root, self.out)
        self.assertFalse(manifest["real_trading_authorized"])
        self.assertFalse(manifest["mt5_connected"])
        self.assertFalse(manifest["live_readiness_verified"])
        self.assertFalse(manifest["installed"])
        self.assertEqual(manifest["commit"], git(self.root, "rev-parse", "HEAD"))
        with ZipFile(self.out, "r") as z:
            self.assertEqual(set(z.namelist()), set(release.SOURCE_FILES) | {release.MANIFEST})
            embedded = json.loads(z.read(release.MANIFEST))
            self.assertEqual(embedded, manifest)
            for rel in release.SOURCE_FILES:
                self.assertEqual(
                    hashlib.sha256(z.read(rel)).hexdigest(), manifest["files_sha256"][rel]
                )
                self.assertEqual(z.read(rel), (self.root / rel).read_bytes())
            self.assertFalse(any(
                ".runtime" in name or ".env" in name or
                "packages/" in name or name.endswith(".sqlite3") for name in z.namelist()
            ))

    def test_reproducible_zip_for_same_commit(self):
        release.build(self.root, self.out)
        second = self.out.with_name("another.zip")
        release.build(self.root, second)
        self.assertEqual(self.out.read_bytes(), second.read_bytes())

    def test_windows_crlf_checkout_uses_exact_git_blob_bytes(self):
        git(self.root, "config", "core.autocrlf", "true")
        file = self.root / "docs" / "V6-ISOLATED-SOURCE-RELEASE.md"
        data = file.read_bytes()
        self.assertIn(b"\n", data)
        file.write_bytes(data.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n"))
        expected = subprocess.check_output(
            ["git", "-C", str(self.root), "show", "HEAD:docs/V6-ISOLATED-SOURCE-RELEASE.md"]
        )
        release.build(self.root, self.out)
        with ZipFile(self.out, "r") as archive:
            self.assertEqual(archive.read("docs/V6-ISOLATED-SOURCE-RELEASE.md"), expected)

    def test_dirty_source_is_rejected(self):
        file = self.root / "scripts" / "mt5-direct-probe.py"
        file.write_bytes(file.read_bytes() + b"\n# not committed\n")
        with self.assertRaises(release.SourceReleaseRejected):
            release.build(self.root, self.out)
        self.assertFalse(self.out.exists())

    def test_missing_allowlisted_source_is_rejected(self):
        (self.root / "apps/web/public/standalone-ui.html").unlink()
        with self.assertRaises(release.SourceReleaseRejected):
            release.build(self.root, self.out)

    def test_staged_source_edit_is_rejected_against_head(self):
        file = self.root / "scripts" / "mt5-direct-probe.py"
        file.write_bytes(file.read_bytes() + b"\n# staged, not reviewed at HEAD\n")
        git(self.root, "add", "--", "scripts/mt5-direct-probe.py")
        with self.assertRaises(release.SourceReleaseRejected):
            release.build(self.root, self.out)
        self.assertFalse(self.out.exists())

    def test_lifting_real_guard_in_committed_source_is_rejected(self):
        file = self.root / "scripts" / "mt5-direct-probe.py"
        source = file.read_text(encoding="utf-8")
        self.assertIn("live_permission = False", source)
        file.write_text(source.replace("live_permission = False", "live_permission = True"), encoding="utf-8")
        git(self.root, "add", "--", "scripts/mt5-direct-probe.py")
        git(self.root, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "unsafe source")
        with self.assertRaises(release.SourceReleaseRejected):
            release.build(self.root, self.out)

    def test_existing_archive_cannot_be_overwritten(self):
        self.out.write_bytes(b"existing operator artifact")
        with self.assertRaises(release.SourceReleaseRejected):
            release.build(self.root, self.out)
        self.assertEqual(self.out.read_bytes(), b"existing operator artifact")


if __name__ == "__main__":
    unittest.main()
