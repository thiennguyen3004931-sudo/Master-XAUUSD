#!/usr/bin/env python3
"""V6 Release Manifest Checksum, Dry-Run Deployment & Rollback Verifier (Streams B & F)."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Mapping, Sequence


SCHEMA_VERSION = 1


def _sha256_canonical(payload: Mapping[str, Any], *, exclude_keys: set[str] | None = None) -> str:
    skip = exclude_keys or set()
    body = {k: v for k, v in payload.items() if k not in skip}
    encoded = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _normalized_file_sha256(path: Path) -> str:
    raw = path.read_bytes().replace(b"\r\n", b"\n")
    return hashlib.sha256(raw).hexdigest()


def build_release_manifest(
    *,
    repo_root: Path,
    release_commit_sha: str,
    relative_files: Sequence[str],
    generated_at_utc: int,
) -> dict[str, Any]:
    """Build deterministic release manifest with normalized-LF SHA-256 digests."""
    files_map: dict[str, str] = {}
    missing_files: list[str] = []
    for rel in sorted(set(relative_files)):
        clean_rel = str(rel).replace("\\", "/").lstrip("/")
        full = repo_root / clean_rel
        if not full.exists() or not full.is_file():
            missing_files.append(clean_rel)
            continue
        files_map[clean_rel] = _normalized_file_sha256(full)

    manifest: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "releaseCommitSha": str(release_commit_sha or "").strip().lower(),
        "generatedAtUtc": int(generated_at_utc),
        "files": files_map,
        "missingFiles": missing_files,
        "complete": len(missing_files) == 0 and len(files_map) > 0,
        "liveAuthorized": False,
    }
    manifest["manifestSha256"] = _sha256_canonical(manifest, exclude_keys={"manifestSha256"})
    return manifest


def verify_release_manifest_against_dir(
    *,
    target_dir: Path,
    expected_manifest: Mapping[str, Any],
) -> dict[str, Any]:
    """Verify every file in a target installation directory matches expected release manifest."""
    expected_files = expected_manifest.get("files")
    if not isinstance(expected_files, Mapping) or not expected_files:
        return {
            "matched": False,
            "reason": "EXPECTED_MANIFEST_FILES_EMPTY",
            "mismatchedFiles": [],
            "missingFiles": [],
            "liveAuthorized": False,
        }

    expected_digest = _sha256_canonical(expected_manifest, exclude_keys={"manifestSha256"})
    if expected_manifest.get("manifestSha256") != expected_digest:
        return {
            "matched": False,
            "reason": "MANIFEST_SELF_DIGEST_TAMPERED",
            "mismatchedFiles": [],
            "missingFiles": [],
            "liveAuthorized": False,
        }

    mismatched: list[str] = []
    missing: list[str] = []
    for rel, exp_hash in sorted(expected_files.items()):
        full = target_dir / rel
        if not full.exists() or not full.is_file():
            missing.append(rel)
            continue
        if _normalized_file_sha256(full) != exp_hash:
            mismatched.append(rel)

    matched = not mismatched and not missing
    return {
        "matched": matched,
        "reason": "RELEASE_MANIFEST_EXACT_MATCH" if matched else "RELEASE_MANIFEST_DRIFT_DETECTED",
        "mismatchedFiles": mismatched,
        "missingFiles": missing,
        "checkedCount": len(expected_files),
        "liveAuthorized": False,
    }


def plan_dryrun_deployment_and_rollback(
    *,
    current_manifest: Mapping[str, Any],
    candidate_manifest: Mapping[str, Any],
    backup_manifest_sha256: str,
    dry_run: bool = True,
) -> dict[str, Any]:
    """Produce a fail-closed dry-run deployment & rollback plan without mutating LIVE hosts."""
    if not dry_run:
        return {
            "approvedForDryRun": False,
            "dryRunOnly": True,
            "reason": "NON_DRYRUN_MUTATION_BLOCKED_IN_VERIFIER",
            "liveAuthorized": False,
        }

    if current_manifest.get("complete") is not True or candidate_manifest.get("complete") is not True:
        return {
            "approvedForDryRun": False,
            "dryRunOnly": True,
            "reason": "INCOMPLETE_RELEASE_MANIFEST",
            "liveAuthorized": False,
        }

    cur_sha = str(current_manifest.get("manifestSha256") or "").strip().lower()
    cand_sha = str(candidate_manifest.get("manifestSha256") or "").strip().lower()
    bkp_sha = str(backup_manifest_sha256 or "").strip().lower()

    if not cur_sha or cur_sha != bkp_sha:
        return {
            "approvedForDryRun": False,
            "dryRunOnly": True,
            "reason": "ROLLBACK_BACKUP_DIGEST_MISMATCH",
            "liveAuthorized": False,
        }

    plan: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "dryRunOnly": True,
        "approvedForDryRun": True,
        "fromReleaseCommitSha": current_manifest.get("releaseCommitSha"),
        "toReleaseCommitSha": candidate_manifest.get("releaseCommitSha"),
        "rollbackBackupManifestSha256": bkp_sha,
        "candidateManifestSha256": cand_sha,
        "steps": [
            "1_VERIFY_BACKUP_MANIFEST_AND_RUNTIME_STOP_DISARMED",
            "2_STAGE_CANDIDATE_FILES_AND_VERIFY_CHECKSUMS",
            "3_RUN_READONLY_ACL_DPAPI_AND_MT5_PROBES",
            "4_ROLLBACK_TO_BACKUP_ON_ANY_DRIFT_OR_HEALTH_FAILURE",
        ],
        "reason": "DRYRUN_DEPLOYMENT_AND_ROLLBACK_PLAN_VERIFIED",
        "liveAuthorized": False,
    }
    plan["planSha256"] = _sha256_canonical(plan, exclude_keys={"planSha256"})
    return plan
