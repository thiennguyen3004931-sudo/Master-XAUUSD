#!/usr/bin/env python3
"""Create a minimal, reproducible source-only V6 archive; NEVER deploy or start MT5.

Only allowlisted Git-tracked files at the exact HEAD are included. No .runtime,
.env, legacy Phase7C code, dependencies, broker credentials or LIVE arm state.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = "V6-ISOLATED-RELEASE-MANIFEST.json"
ARCHIVE_NAME = "v6-isolated-source-only.zip"

SOURCE_FILES = (
    "apps/web/public/standalone-ui.html",
    "docs/V6-ISOLATED-SOURCE-RELEASE.md",
    "scripts/mt5-direct-probe.py",
    "scripts/v6-api-input-guards.mjs",
    "scripts/v6_daily_loss_guard.py",
    "scripts/xauusd-standalone-server.mjs",
    "scripts/xauusd_v6_trade_rules.py",
    "scripts/ops/check-v6-isolated-stage-readonly.ps1",
)


class SourceReleaseRejected(Exception):
    pass


def _git(root: Path, *args: str) -> bytes:
    p = subprocess.run(
        ["git", "-C", str(root), *args],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    if p.returncode:
        # Do not print Git's full error message, which may include local paths.
        raise SourceReleaseRejected("cannot verify source provenance from Git")
    return p.stdout


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _source_bytes(root: Path, commit: str) -> dict[str, bytes]:
    content: dict[str, bytes] = {}
    for rel in SOURCE_FILES:
        if not re.fullmatch(r"[a-zA-Z0-9_./-]+", rel) or ".." in Path(rel).parts:
            raise SourceReleaseRejected("unsafe archive allowlist")
        p = root.joinpath(*rel.split("/"))
        if p.is_symlink() or not p.is_file() or not _is_relative_to(p.resolve(), root):
            raise SourceReleaseRejected("an allowlisted source file is absent or not regular")
        # GitHub-hosted Windows can check out LF Git blobs as CRLF working files.
        # Let Git apply its own text filters to detect edits, then package only
        # the canonical bytes from HEAD. This is both platform-independent and
        # immune to any untracked working-tree content entering the ZIP.
        # Compare content against HEAD (including staged edits). A status-only
        # check can transiently report M after a CRLF/stat-cache refresh even
        # when Git's normalized content is identical to the trusted blob.
        if _git(root, "diff", "--name-only", "HEAD", "--", rel).strip():
            raise SourceReleaseRejected("allowlisted source has uncommitted changes")
        trusted = _git(root, "show", f"{commit}:{rel}")
        content[rel] = trusted
    return content


def build(root: Path, output: Path) -> dict:
    root = root.resolve()
    output = output if output.is_absolute() else root / output
    output = output.resolve()

    if output.exists():
        raise SourceReleaseRejected("output archive already exists; refusing to overwrite")
    if not _is_relative_to(root / "scripts", root):
        raise SourceReleaseRejected("invalid project root")
    if any(_is_relative_to(output, root / part) for part in
           (".runtime", "packages", ".git", "apps", "docs", "scripts")):
        raise SourceReleaseRejected("output must not touch runtime or source directories")

    sha = _git(root, "rev-parse", "HEAD").decode("ascii").strip()
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise SourceReleaseRejected("invalid Git HEAD")
    files = _source_bytes(root, sha)
    server = files["scripts/xauusd-standalone-server.mjs"].decode("utf8")
    broker = files["scripts/mt5-direct-probe.py"].decode("utf8")
    if not all([
        'apiServer.listen(API_PORT, "127.0.0.1"' in server,
        'webServer.listen(WEB_PORT, "127.0.0.1"' in server,
        "V6_REMOTE_TUNNEL_DISABLED" in server,
        "liveAuthorized: false" in server,
        "live_permission = False" in broker,
        "verify_daily_new_order_budget(mt5, account, existing_positions, new_risk)" in broker,
        "require_account_binding=(action in mutation_actions)" in broker,
        "def _read_stdin_payload():" in broker,
        "def connect_mt5(" in broker,
        "writeBridgeEnvAndArmFiles" not in server,
        "cloudflared" not in server,
    ]):
        raise SourceReleaseRejected("mandatory V6 source safety boundary missing")
    if re.search(r"^\s*(?:\w+\s*=\s*)?mt5\.login\s*\(", broker, re.MULTILINE):
        raise SourceReleaseRejected("MT5 implicit login present")

    checksums = {rel: hashlib.sha256(data).hexdigest() for rel, data in files.items()}
    manifest = {
        "schema": "xauusd-v6-isolated-source-v1",
        "repository": "thiennguyen3004931-sudo/Master-XAUUSD",
        "commit": sha,
        "kind": "source-only; not installed or deployed",
        "installed": False,
        "mt5_connected": False,
        "real_trading_authorized": False,
        "live_readiness_verified": False,
        "may_start_broker_or_terminal": False,
        "files_sha256": checksums,
        "expected_runtime": "independent Windows directory; no legacy Phase7C overlay",
    }
    payload = (json.dumps(manifest, sort_keys=True, indent=2, ensure_ascii=False) + "\n").encode("utf8")
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        with ZipFile(output, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
            for rel, data in sorted(files.items()):
                entry = ZipInfo(rel, date_time=(2026, 1, 1, 0, 0, 0))
                entry.compress_type = ZIP_DEFLATED
                entry.external_attr = 0o100644 << 16
                archive.writestr(entry, data)
            entry = ZipInfo(MANIFEST, date_time=(2026, 1, 1, 0, 0, 0))
            entry.compress_type = ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, payload)
    except Exception:
        output.unlink(missing_ok=True)
        raise
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT, help="trusted Git checkout")
    parser.add_argument("--output", type=Path, default=Path("artifacts") / ARCHIVE_NAME)
    args = parser.parse_args()
    try:
        manifest = build(args.root, args.output)
    except SourceReleaseRejected as exc:
        # Rejection messages are fixed, non-sensitive status text (no paths/tokens).
        print("V6_ISOLATED_SOURCE_RELEASE=BLOCKED " + str(exc), file=sys.stderr)
        return 2
    except (OSError, UnicodeError):
        print("V6_ISOLATED_SOURCE_RELEASE=BLOCKED IO_ERROR", file=sys.stderr)
        return 2
    print("V6_ISOLATED_SOURCE_RELEASE=BUILT_SOURCE_ONLY")
    print("V6_ISOLATED_SOURCE_COMMIT=" + manifest["commit"])
    print("V6_LIVE_APPROVAL=NO")
    print("V6_DEPLOYED=NO")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
