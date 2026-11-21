"""Opt-in G4 Windows ACL evidence, never an authorization or broker probe.

Reads only local path metadata and invokes whoami / icacls with shell=False.
No secrets, file contents, MT5 import, order send, or ACL changes.
Raw principal names / SID output is private; never auto-upload.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
from typing import Callable

SCOPE = "READONLY_WINDOWS_ACL_EVIDENCE_NOT_RUNTIME_ATTESTATION"
REPARSE_POINT = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
LABELS = ("state_directory", "latch_file", "uncertain_entry_file")


def _block(reason: str) -> dict:
    return {
        "collectionSucceeded": False,
        "reason": reason,
        "hostAclIndependentlyVerified": False,
        "operatorIdentityVerified": False,
        "keyCustodyVerified": False,
        "liveAuthorized": False,
        "scope": SCOPE,
    }


def _has_reparse_ancestor(path: Path) -> bool:
    for item in (path, *path.parents):
        try:
            attrs = item.lstat()
            if item.is_symlink() or getattr(attrs, "st_file_attributes", 0) & REPARSE_POINT:
                return True
        except (OSError, ValueError):
            return True
    return False


def _read_command(runner: Callable, args: list[str]) -> str | None:
    try:
        result = runner(
            args, shell=False, check=False, capture_output=True, text=True, timeout=10
        )
        if (
            result.returncode != 0
            or not isinstance(result.stdout, str)
            or not result.stdout.strip()
            or len(result.stdout) > 32768
        ):
            return None
        return result.stdout.strip()
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def collect_windows_acl_evidence(
    *, state_directory: str, latch_file: str, uncertain_entry_file: str,
    runner: Callable = subprocess.run, host_os_name: str | None = None,
    include_sensitive_local_details: bool = False,
) -> dict:
    """Collect evidence; mocks are for offline tests, never proof of LIVE safety."""
    if (os.name if host_os_name is None else host_os_name) != "nt":
        return _block("NOT_WINDOWS_HOST")
    raw_paths = {
        "state_directory": state_directory,
        "latch_file": latch_file,
        "uncertain_entry_file": uncertain_entry_file,
    }
    checked: dict[str, Path] = {}
    for label in LABELS:
        raw = raw_paths[label]
        if not isinstance(raw, str) or not raw.strip() or "\x00" in raw:
            return _block("INVALID_PATH")
        p = Path(raw)
        if not p.is_absolute() or not p.exists():
            return _block("MISSING_OR_RELATIVE_PATH")
        if _has_reparse_ancestor(p):
            return _block("REPARSE_OR_UNVERIFIED_PATH")
        if (label == "state_directory" and not p.is_dir()) or (
            label != "state_directory" and not p.is_file()
        ):
            return _block("INVALID_STATE_PATH_KIND")
        checked[label] = p
    try:
        root = checked["state_directory"].resolve(strict=True)
        latch = checked["latch_file"].resolve(strict=True)
        uncertain = checked["uncertain_entry_file"].resolve(strict=True)
        if root not in latch.parents or root not in uncertain.parents or latch == uncertain:
            return _block("STATE_PATH_NOT_BOUND_TO_DIRECTORY")
    except (OSError, RuntimeError, ValueError):
        return _block("CANONICAL_PATH_UNVERIFIED")

    identities = {}
    for name, command in (
        ("user", ["whoami", "/user"]), ("groups", ["whoami", "/groups"])
    ):
        captured = _read_command(runner, command)
        if captured is None:
            return _block("PROCESS_IDENTITY_EVIDENCE_UNAVAILABLE")
        identities[name] = captured

    evidence = {}
    for label in LABELS:
        captured = _read_command(runner, ["icacls", str(checked[label])])
        if captured is None:
            return _block("ACL_EVIDENCE_UNAVAILABLE")
        evidence[label] = {
            "sha256": hashlib.sha256(captured.encode("utf-8")).hexdigest(),
            "rawDetailIncluded": include_sensitive_local_details,
        }
        if include_sensitive_local_details:
            evidence[label]["path"] = str(checked[label])
            evidence[label]["rawIcacls"] = captured

    response = {
        "collectionSucceeded": True,
        "reason": "LOCAL_EVIDENCE_CAPTURED_REQUIRES_HUMAN_REVIEW",
        "evidenceSource": "LOCAL_WINDOWS_WHOAMI_ICACLS_READONLY",
        "scope": SCOPE,
        "hostAclIndependentlyVerified": False,
        "operatorIdentityVerified": False,
        "keyCustodyVerified": False,
        "liveAuthorized": False,
        "permissionInterpretation": "UNVERIFIED",
        "principalEvidenceHashes": {
            label: hashlib.sha256(value.encode("utf-8")).hexdigest()
            for label, value in identities.items()
        },
        "pathEvidence": evidence,
    }
    if include_sensitive_local_details:
        response["privateIdentityEvidence"] = identities
        response["privacyWarning"] = "LOCAL_PRINCIPAL_AND_SID_DETAILS_DO_NOT_AUTO_UPLOAD"
    return response


def main() -> int:
    p = argparse.ArgumentParser(description="Read-only Windows ACL evidence (no MT5)")
    p.add_argument("--state-directory", required=True)
    p.add_argument("--latch-file", required=True)
    p.add_argument("--uncertain-entry-file", required=True)
    p.add_argument("--include-sensitive-local-details", action="store_true")
    args = p.parse_args()
    result = collect_windows_acl_evidence(
        state_directory=args.state_directory,
        latch_file=args.latch_file,
        uncertain_entry_file=args.uncertain_entry_file,
        include_sensitive_local_details=args.include_sensitive_local_details,
    )
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if result["collectionSucceeded"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
