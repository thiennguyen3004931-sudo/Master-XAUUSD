"""Genuine read-only host ACL, reparse/symlink & key-provenance collector for V6 G4 (#7).

Strictly READ-ONLY / NO-TRADE:
- NEVER imports MetaTrader5, NEVER calls `order_send`, NEVER mutates ARM/config.
- NEVER reads, logs, or uploads secret values (only inspects filesystem ACLs,
  reparse/symlink chains, process identity, DPAPI/custody metadata, and lock
  readiness).
- NEVER treats caller-supplied booleans as host ACL proof.
- On non-Windows hosts (e.g. Linux CI), `windowsHostAclVerified` is always
  `False` (`NON_WINDOWS_HOST_CANNOT_CERTIFY_WINDOWS_ACL`).
"""
from __future__ import annotations

import getpass
import hashlib
import json
import os
from pathlib import Path
import platform
import stat
import subprocess
import time

REPARSE_POINT_ATTR = 0x0400
BROAD_PRINCIPALS = (
    "everyone",
    "builtin\\users",
    "nt authority\\authenticated users",
    "authenticated users",
)
WRITE_RIGHT_TOKENS = ("(f)", "(m)", "(w)", "(wdac)", "(wo)", "(wa)", "(d)", "(dc)")


def detect_symlink_or_reparse_chain(target: Path) -> dict:
    """Inspect target and every parent component for symlinks or Windows reparse points."""
    raw_path = Path(target)
    findings: list[dict] = []
    probe_paths = [raw_path, *raw_path.parents]
    for component in probe_paths:
        try:
            st = os.lstat(component)
            is_link = stat.S_ISLNK(st.st_mode)
            file_attrs = getattr(st, "st_file_attributes", 0)
            is_reparse = bool(file_attrs & REPARSE_POINT_ATTR)
            if is_link or is_reparse:
                findings.append({
                    "path": str(component),
                    "isSymlink": is_link,
                    "isReparsePoint": is_reparse,
                })
        except FileNotFoundError:
            continue
        except OSError as exc:
            findings.append({
                "path": str(component),
                "statError": type(exc).__name__,
            })

    try:
        canonical = str(raw_path.resolve(strict=False))
    except OSError:
        canonical = os.path.abspath(str(raw_path))

    return {
        "inputPath": str(raw_path),
        "canonicalPath": canonical,
        "reparseOrSymlinkDetected": len(findings) > 0,
        "findings": findings,
    }


def parse_icacls_output(stdout_text: str) -> dict:
    """Parse `icacls` output for broad write/full-control grants without invoking a shell."""
    lines = [line.strip() for line in (stdout_text or "").splitlines() if line.strip()]
    aces: list[str] = []
    broad_write_grants: list[str] = []
    for line in lines:
        lower = line.casefold()
        if lower.startswith("successfully processed") or ":" not in line:
            continue
        aces.append(line)
        # Strip leading path if present on the first ACE line
        ace_part = line.split(" ", 1)[1] if (len(aces) == 1 and ":\\" in line) else line
        ace_lower = ace_part.casefold()
        if any(p in ace_lower for p in BROAD_PRINCIPALS) and any(tok in ace_lower for tok in WRITE_RIGHT_TOKENS):
            broad_write_grants.append(ace_part.strip())

    return {
        "aceCount": len(aces),
        "broadWriteGrants": broad_write_grants,
        # Text scanning cannot establish Windows *effective* access. Deny
        # any authority-sounding conclusion even when no broad ACE is found.
        "noBroadWriteAceFoundByTextScan": len(aces) > 0 and len(broad_write_grants) == 0,
        "nonAdminWriteDenied": False,
    }


def inspect_path_acl(
    target: Path,
    *,
    icacls_runner=None,
    os_name_override: str | None = None,
) -> dict:
    """Inspect real filesystem ACLs on Windows (`icacls`) or POSIX mode bits."""
    chain = detect_symlink_or_reparse_chain(target)
    canonical = Path(chain["canonicalPath"])
    exists = canonical.exists()
    if not exists:
        return {
            **chain,
            "exists": False,
            "windowsHostAclVerified": False,
            "reason": "TARGET_PATH_MISSING",
        }

    if chain["reparseOrSymlinkDetected"]:
        return {
            **chain,
            "exists": True,
            "windowsHostAclVerified": False,
            "reason": "SYMLINK_OR_REPARSE_DETECTED",
        }

    effective_os = os.name if os_name_override is None else os_name_override
    if effective_os == "nt":
        runner = icacls_runner or (lambda p: subprocess.run(
            ["icacls", str(p)], capture_output=True, text=True, timeout=5, check=False
        ))
        try:
            proc = runner(canonical)
            if proc.returncode != 0:
                return {
                    **chain,
                    "exists": True,
                    "windowsHostAclVerified": False,
                    "reason": f"ICACLS_FAILED_RC_{proc.returncode}",
                }
            parsed = parse_icacls_output(proc.stdout)
            no_broad_ace_observed = parsed["noBroadWriteAceFoundByTextScan"]
            return {
                **chain,
                "exists": True,
                "platform": "Windows",
                "icacls": parsed,
                "aclTextNoBroadWriteAceObserved": no_broad_ace_observed,
                "windowsHostAclVerified": False,
                "reason": "WINDOWS_ICACLS_TEXT_REQUIRES_EFFECTIVE_ACCESS_REVIEW"
                    if no_broad_ace_observed else "BROAD_WRITE_ACE_DETECTED",
            }
        except Exception as exc:
            return {
                **chain,
                "exists": True,
                "platform": "Windows",
                "windowsHostAclVerified": False,
                "reason": f"ICACLS_ERROR_{type(exc).__name__}",
            }

    st = os.lstat(canonical)
    mode = stat.S_IMODE(st.st_mode)
    group_writable = bool(mode & stat.S_IWGRP)
    world_writable = bool(mode & stat.S_IWOTH)
    world_readable = bool(mode & stat.S_IROTH)
    return {
        **chain,
        "exists": True,
        "platform": platform.system(),
        "posixModeOctal": oct(mode),
        "uid": st.st_uid,
        "gid": st.st_gid,
        "groupWritable": group_writable,
        "worldWritable": world_writable,
        "worldReadable": world_readable,
        "windowsHostAclVerified": False,
        "reason": "NON_WINDOWS_HOST_CANNOT_CERTIFY_WINDOWS_ACL",
    }


def collect_process_identity() -> dict:
    """Collect current process user/PID without reading environment secrets."""
    try:
        user = getpass.getuser()
    except Exception:
        user = "UNKNOWN"
    return {
        "pid": os.getpid(),
        "user": user,
        "osName": os.name,
        "system": platform.system(),
        "release": platform.release(),
    }


def inspect_key_custody_metadata(
    *,
    dpapi_blob_path: Path | None = None,
    control_token_env_name: str = "ZIQ_V6_CONTROL_TOKEN",
    icacls_runner=None,
    os_name_override: str | None = None,
) -> dict:
    """Inspect key-custody state WITHOUT ever reading or returning secret values."""
    # Membership tests whether a token is configured without retrieving its value.
    env_present = control_token_env_name in os.environ
    dpapi_info: dict = {"configured": dpapi_blob_path is not None}
    if dpapi_blob_path is not None:
        dpapi_acl = inspect_path_acl(
            Path(dpapi_blob_path),
            icacls_runner=icacls_runner,
            os_name_override=os_name_override,
        )
        dpapi_info.update({
            "exists": dpapi_acl["exists"],
            "reparseOrSymlinkDetected": dpapi_acl["reparseOrSymlinkDetected"],
            "windowsHostAclVerified": dpapi_acl["windowsHostAclVerified"],
        })
    return {
        "secretValuesExposed": False,
        "controlTokenEnvPresent": env_present,
        "dpapiBlob": dpapi_info,
    }


def collect_readonly_host_provenance_report(
    *,
    runtime_dir: Path,
    latch_file: Path,
    dpapi_blob_path: Path | None = None,
    repo_head_sha: str = "UNVERIFIED",
    now_utc: float | None = None,
    icacls_runner=None,
    os_name_override: str | None = None,
) -> dict:
    """Generate a complete read-only JSON provenance artifact with SHA-256 digest."""
    ts = int(time.time() if now_utc is None else now_utc)
    runtime_acl = inspect_path_acl(
        Path(runtime_dir),
        icacls_runner=icacls_runner,
        os_name_override=os_name_override,
    )
    latch_acl = inspect_path_acl(
        Path(latch_file),
        icacls_runner=icacls_runner,
        os_name_override=os_name_override,
    )
    lock_file = Path(f"{Path(latch_file)}.lock")
    custody = inspect_key_custody_metadata(
        dpapi_blob_path=dpapi_blob_path,
        icacls_runner=icacls_runner,
        os_name_override=os_name_override,
    )
    process_id = collect_process_identity()

    body = {
        "schemaVersion": 1,
        "probeScope": "READONLY_HOST_PROVENANCE_NO_TRADE_NO_SECRETS",
        "generatedAtUtc": ts,
        "repoHeadSha": str(repo_head_sha or "UNVERIFIED"),
        "processIdentity": process_id,
        "runtimeDirAcl": runtime_acl,
        "latchFileAcl": latch_acl,
        "lockPathMetadata": {
            "lockFilePath": str(lock_file),
            "lockFileExists": lock_file.exists(),
        },
        "keyCustodyMetadata": custody,
        "overallWindowsHostAclVerified": False,
        "aclTextNoBroadWriteAceObserved": bool(
            runtime_acl.get("aclTextNoBroadWriteAceObserved") is True
            and latch_acl.get("aclTextNoBroadWriteAceObserved") is True
        ),
        "operatorIdentityVerified": False,
        "keyCustodyVerified": False,
        "liveAuthorized": False,
    }
    canonical_json = json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    body["reportSha256"] = hashlib.sha256(canonical_json.encode("utf-8")).hexdigest()
    return body
