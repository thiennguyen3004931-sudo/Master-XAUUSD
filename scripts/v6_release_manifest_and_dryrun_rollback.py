#!/usr/bin/env python3
"""V6 Release Manifest Checksum, Dry-Run Deployment & Rollback Verifier (Streams B & F)."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any, Mapping, Sequence


SCHEMA_VERSION = 1


def _sha256_canonical(payload: Mapping[str, Any], *, exclude_keys: set[str] | None = None) -> str:
    skip = exclude_keys or set()
    body = {k: v for k, v in payload.items() if k not in skip}
    encoded = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


_TEXT_EXTENSIONS = {".py", ".mjs", ".js", ".ts", ".tsx", ".json", ".md", ".html", ".txt", ".yaml", ".yml"}


def _safe_relative_file(root: Path, rel: Any) -> tuple[str | None, Path | None]:
    """Restrict untrusted manifest paths to ordinary files inside root.

    Reject all symlink components, absolute/drive/UNC paths, empty/dot/dotdot
    segments and NUL. This is a local read-only scanner, NOT a filesystem
    race-free deployment or a Windows service ACL attestation.
    """
    if not isinstance(rel, str) or not rel or "\x00" in rel:
        return None, None
    clean = rel.replace("\\", "/")
    if clean.startswith("/") or ":" in clean or "//" in clean:
        return None, None
    parts = clean.split("/")
    if any(part in ("", ".", "..") for part in parts):
        return None, None
    base = root.resolve()
    candidate = base
    for part in parts:
        candidate = candidate / part
        if candidate.is_symlink():
            return None, None
    try:
        candidate.resolve(strict=False).relative_to(base)
    except (ValueError, RuntimeError, OSError):
        return None, None
    return clean, candidate


def _normalized_file_sha256(path: Path) -> str:
    """Normalize only uniform CRLF UTF-8 text of known text extensions."""
    raw = path.read_bytes()
    if path.suffix.lower() in _TEXT_EXTENSIONS and b"\x00" not in raw:
        try:
            raw.decode("utf-8")
            without_pairs = raw.replace(b"\r\n", b"")
            if b"\r\n" in raw and b"\n" not in without_pairs and b"\r" not in without_pairs:
                raw = raw.replace(b"\r\n", b"\n")
        except UnicodeDecodeError:
            pass
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
    invalid_files: list[str] = []
    for rel in relative_files:
        clean_rel, full = _safe_relative_file(repo_root, rel)
        if clean_rel is None or full is None or clean_rel in files_map:
            invalid_files.append(str(rel)[:160])
            continue
        if not full.exists() or not full.is_file():
            missing_files.append(clean_rel)
            continue
        files_map[clean_rel] = _normalized_file_sha256(full)
    files_map = dict(sorted(files_map.items()))
    release_sha = str(release_commit_sha or "").strip().lower()
    release_sha_format_valid = re.fullmatch(r"[0-9a-f]{40}", release_sha) is not None

    manifest: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "releaseCommitSha": release_sha,
        "releaseCommitShaFormatValid": release_sha_format_valid,
        "releaseProvenanceVerified": False,
        "releaseSignatureVerified": False,
        "deployedProcessVerified": False,
        "generatedAtUtc": int(generated_at_utc),
        "files": files_map,
        "missingFiles": sorted(missing_files),
        "invalidPaths": sorted(invalid_files),
        "complete": not missing_files and not invalid_files and bool(files_map) and release_sha_format_valid,
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
    invalid: list[str] = []
    for rel, exp_hash in expected_files.items():
        clean, full = _safe_relative_file(target_dir, rel)
        if (
            clean is None or full is None
            or not isinstance(exp_hash, str)
            or re.fullmatch(r"[0-9a-f]{64}", exp_hash) is None
        ):
            invalid.append(str(rel)[:160])
            continue
        if not full.exists() or not full.is_file():
            missing.append(clean)
            continue
        if _normalized_file_sha256(full) != exp_hash:
            mismatched.append(clean)

    matched = not mismatched and not missing and not invalid and expected_manifest.get("complete") is True
    return {
        "matched": matched,
        "reason": (
            "LOCAL_FILES_MATCH_CALLER_MANIFEST_UNTRUSTED_SOURCE" if matched
            else "MANIFEST_INVALID_PATH_OR_DIGEST" if invalid
            else "RELEASE_MANIFEST_DRIFT_OR_INCOMPLETE"
        ),
        "mismatchedFiles": sorted(mismatched),
        "missingFiles": sorted(missing),
        "invalidPaths": sorted(invalid),
        "checkedCount": len(expected_files),
        "releaseSignatureVerified": False,
        "releaseProvenanceVerified": False,
        "deployedProcessVerified": False,
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

    if (
        current_manifest.get("complete") is not True
        or candidate_manifest.get("complete") is not True
        or current_manifest.get("invalidPaths")
        or candidate_manifest.get("invalidPaths")
    ):
        return {
            "approvedForDryRun": False,
            "dryRunOnly": True,
            "reason": "INCOMPLETE_RELEASE_MANIFEST",
            "liveAuthorized": False,
        }

    cur_sha = str(current_manifest.get("manifestSha256") or "").strip().lower()
    cand_sha = str(candidate_manifest.get("manifestSha256") or "").strip().lower()
    bkp_sha = str(backup_manifest_sha256 or "").strip().lower()

    if (
        not re.fullmatch(r"[0-9a-f]{64}", cur_sha)
        or not re.fullmatch(r"[0-9a-f]{64}", cand_sha)
        or cur_sha != _sha256_canonical(current_manifest, exclude_keys={"manifestSha256"})
        or cand_sha != _sha256_canonical(candidate_manifest, exclude_keys={"manifestSha256"})
        or cur_sha != bkp_sha
    ):
        return {
            "approvedForDryRun": False,
            "dryRunOnly": True,
            "reason": "ROLLBACK_BACKUP_DIGEST_MISMATCH",
            "liveAuthorized": False,
        }

    plan: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "dryRunOnly": True,
        "approvedForDryRun": False,
        "planGenerated": True,
        "releaseProvenanceVerified": False,
        "releaseSignatureVerified": False,
        "rollbackBackupVerified": False,
        "hostAclDpapiVerified": False,
        "deployedProcessVerified": False,
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
        "reason": "DRYRUN_PLAN_ONLY_RELEASE_AND_BACKUP_PROVENANCE_UNVERIFIED",
        "liveAuthorized": False,
    }
    plan["planSha256"] = _sha256_canonical(plan, exclude_keys={"planSha256"})
    return plan
