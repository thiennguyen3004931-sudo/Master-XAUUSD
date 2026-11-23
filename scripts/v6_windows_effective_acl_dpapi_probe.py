#!/usr/bin/env python3
"""Read-only Windows SID-based Effective ACL & DPAPI readiness probe for V6 G1/G4 (#7)."""

from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import time
from typing import Any, Iterable, Mapping, Sequence


SCHEMA_VERSION = 1
SCOPE = "READONLY_WINDOWS_SID_EFFECTIVE_ACL_AND_DPAPI_PROBE_NO_SECRET_NO_ORDER"

BROAD_UNTRUSTED_SIDS: dict[str, str] = {
    "S-1-1-0": "Everyone",
    "S-1-5-7": "AnonymousLogon",
    "S-1-5-11": "AuthenticatedUsers",
    "S-1-5-32-545": "BUILTIN_Users",
    "S-1-5-32-546": "BUILTIN_Guests",
    "S-1-5-32-547": "BUILTIN_PowerUsers",
}

TRUSTED_SYSTEM_SIDS: set[str] = {
    "S-1-5-18",
    "S-1-5-32-544",
}

WRITE_RISK_RIGHT_FLAGS: tuple[tuple[str, int], ...] = (
    ("WriteData", 0x00000002),
    ("AppendData", 0x00000004),
    ("WriteExtendedAttributes", 0x00000010),
    ("DeleteSubdirectoriesAndFiles", 0x00000040),
    ("WriteAttributes", 0x00000100),
    ("Delete", 0x00010000),
    ("ChangePermissions", 0x00040000),
    ("TakeOwnership", 0x00080000),
    ("GenericAll", 0x10000000),
    ("GenericWrite", 0x40000000),
)

WRITE_RISK_RIGHT_NAMES: set[str] = {
    "write",
    "writedata",
    "createfiles",
    "appenddata",
    "createdirectories",
    "writeextendedattributes",
    "writeattributes",
    "delete",
    "deletesubdirectoriesandfiles",
    "changepermissions",
    "takeownership",
    "modify",
    "fullcontrol",
    "genericwrite",
    "genericall",
}


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _canonical_report_sha256(payload: Mapping[str, Any]) -> str:
    body = {k: v for k, v in payload.items() if k != "reportSha256"}
    encoded = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return _sha256_text(encoded)


def _normalize_sid(raw: Any) -> str:
    if not isinstance(raw, str):
        return ""
    return raw.strip().upper()


def _has_write_risk(rights_mask: Any, rights_text: Any = "") -> bool:
    if isinstance(rights_mask, int) and not isinstance(rights_mask, bool):
        unsigned_mask = rights_mask & 0xFFFFFFFF
        for _name, bit in WRITE_RISK_RIGHT_FLAGS:
            if (unsigned_mask & bit) != 0:
                return True
    if isinstance(rights_text, str) and rights_text.strip():
        tokens = [
            tok.strip().lower().replace("_", "").replace(" ", "")
            for tok in rights_text.split(",")
            if tok.strip()
        ]
        for tok in tokens:
            if tok in WRITE_RISK_RIGHT_NAMES:
                return True
    return False


def evaluate_sid_acl_rules(
    *,
    path_label: str,
    exists: bool,
    owner_sid: str,
    current_user_sid: str,
    rules: Sequence[Mapping[str, Any]],
    reparse_detected: bool = False,
    trusted_extra_sids: Iterable[str] = (),
    forbid_any_broad_allow: bool = False,
) -> dict[str, Any]:
    """Evaluate Windows SID-resolved ACL rules fail-closed without leaking raw usernames."""
    norm_owner = _normalize_sid(owner_sid)
    norm_user = _normalize_sid(current_user_sid)
    allowed_sids = set(TRUSTED_SYSTEM_SIDS)
    if norm_user:
        allowed_sids.add(norm_user)
    for sid in trusted_extra_sids:
        norm = _normalize_sid(sid)
        if norm:
            allowed_sids.add(norm)

    if not exists:
        return {
            "pathLabel": path_label,
            "exists": False,
            "reparseDetected": bool(reparse_detected),
            "ownerMatchesOperatorOrSystem": False,
            "broadWriteGrants": [],
            "unexpectedWriteSids": [],
            "status": "MISSING",
            "reason": "TARGET_PATH_NOT_FOUND",
            "verified": False,
        }

    if reparse_detected:
        return {
            "pathLabel": path_label,
            "exists": True,
            "reparseDetected": True,
            "ownerMatchesOperatorOrSystem": norm_owner in allowed_sids if norm_owner else False,
            "broadWriteGrants": [],
            "unexpectedWriteSids": [],
            "status": "UNSAFE",
            "reason": "REPARSE_POINT_OR_SYMLINK_DETECTED",
            "verified": False,
        }

    if not norm_owner or not norm_user:
        return {
            "pathLabel": path_label,
            "exists": True,
            "reparseDetected": False,
            "ownerMatchesOperatorOrSystem": False,
            "broadWriteGrants": [],
            "unexpectedWriteSids": [],
            "status": "UNVERIFIED",
            "reason": "MISSING_OWNER_OR_OPERATOR_SID",
            "verified": False,
        }

    if not isinstance(rules, Sequence) or len(rules) == 0:
        return {
            "pathLabel": path_label,
            "exists": True,
            "reparseDetected": False,
            "ownerMatchesOperatorOrSystem": norm_owner in allowed_sids,
            "broadWriteGrants": [],
            "unexpectedWriteSids": [],
            "status": "UNVERIFIED",
            "reason": "EMPTY_ACL_RULESET",
            "verified": False,
        }

    owner_ok = norm_owner in allowed_sids
    broad_write_grants: list[str] = []
    unexpected_write_sids: list[str] = []
    denied_sids_for_write: set[str] = set()

    for rule in rules:
        if not isinstance(rule, Mapping):
            continue
        control_type = str(rule.get("accessControlType", "")).strip().lower()
        sid = _normalize_sid(rule.get("sid", ""))
        if control_type == "deny" and sid and _has_write_risk(
            rule.get("rightsMask"), rule.get("rightsText", "")
        ):
            denied_sids_for_write.add(sid)

    for rule in rules:
        if not isinstance(rule, Mapping):
            continue
        control_type = str(rule.get("accessControlType", "")).strip().lower()
        if control_type != "allow":
            continue
        sid = _normalize_sid(rule.get("sid", ""))
        if not sid:
            unexpected_write_sids.append("UNRESOLVED_EMPTY_SID")
            continue
        write_risk = _has_write_risk(rule.get("rightsMask"), rule.get("rightsText", ""))
        if not write_risk and not (forbid_any_broad_allow and sid in BROAD_UNTRUSTED_SIDS):
            continue
        if sid in BROAD_UNTRUSTED_SIDS:
            label = f"{sid}:{BROAD_UNTRUSTED_SIDS[sid]}"
            if label not in broad_write_grants:
                broad_write_grants.append(label)
        elif sid not in allowed_sids:
            sid_hash = f"sid_sha256:{_sha256_text(sid)[:16]}"
            if sid_hash not in unexpected_write_sids:
                unexpected_write_sids.append(sid_hash)

    if not owner_ok:
        status = "UNSAFE"
        reason = "UNTRUSTED_OWNER_SID"
        verified = False
    elif broad_write_grants:
        status = "UNSAFE"
        reason = "BROAD_PRINCIPAL_WRITE_GRANT_DETECTED"
        verified = False
    elif unexpected_write_sids:
        status = "UNSAFE"
        reason = "UNEXPECTED_PRINCIPAL_WRITE_GRANT_DETECTED"
        verified = False
    elif norm_user in denied_sids_for_write:
        status = "UNSAFE"
        reason = "OPERATOR_WRITE_EXPLICITLY_DENIED"
        verified = False
    else:
        status = "VERIFIED"
        reason = "SID_EFFECTIVE_ACL_STRICT_OPERATOR_ONLY"
        verified = True

    return {
        "pathLabel": path_label,
        "exists": True,
        "reparseDetected": False,
        "ownerMatchesOperatorOrSystem": owner_ok,
        "broadWriteGrants": sorted(broad_write_grants),
        "unexpectedWriteSids": sorted(unexpected_write_sids),
        "ruleCount": len(rules),
        "status": status,
        "reason": reason,
        "verified": verified,
    }


def _collect_windows_sid_acl(target: Path, path_label: str) -> dict[str, Any]:
    """Collect SID-resolved ACL metadata via PowerShell Get-Acl (read-only)."""
    if not target.exists():
        return {
            "exists": False,
            "reparseDetected": False,
            "ownerSid": "",
            "currentUserSid": "",
            "rules": [],
            "error": None,
        }

    ps_script = (
        "$ErrorActionPreference = 'Stop'; "
        "$p = $env:V6_ACL_PROBE_TARGET; "
        "$item = Get-Item -LiteralPath $p -Force; "
        "$reparse = [bool](($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0); "
        "$acl = Get-Acl -LiteralPath $p; "
        "$ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; "
        "$curSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; "
        "$rules = @(); "
        "foreach ($r in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) { "
        "  $rules += [PSCustomObject]@{ "
        "    sid = $r.IdentityReference.Value; "
        "    accessControlType = $r.AccessControlType.ToString(); "
        "    rightsMask = [int]$r.FileSystemRights; "
        "    rightsText = $r.FileSystemRights.ToString(); "
        "    isInherited = [bool]$r.IsInherited "
        "  } "
        "}; "
        "[PSCustomObject]@{ "
        "  exists = $true; "
        "  reparseDetected = $reparse; "
        "  ownerSid = $ownerSid; "
        "  currentUserSid = $curSid; "
        "  rules = $rules "
        "} | ConvertTo-Json -Depth 5 -Compress"
    )
    env = dict(os.environ)
    env["V6_ACL_PROBE_TARGET"] = str(target)
    try:
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_script],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
            env=env,
        )
    except Exception as exc:
        return {
            "exists": True,
            "reparseDetected": False,
            "ownerSid": "",
            "currentUserSid": "",
            "rules": [],
            "error": f"POWERSHELL_INVOKE_FAILED:{type(exc).__name__}",
        }

    if proc.returncode != 0 or not proc.stdout.strip():
        return {
            "exists": True,
            "reparseDetected": False,
            "ownerSid": "",
            "currentUserSid": "",
            "rules": [],
            "error": f"POWERSHELL_EXIT_{proc.returncode}",
        }

    try:
        parsed = json.loads(proc.stdout.strip())
    except json.JSONDecodeError:
        return {
            "exists": True,
            "reparseDetected": False,
            "ownerSid": "",
            "currentUserSid": "",
            "rules": [],
            "error": "POWERSHELL_INVALID_JSON",
        }

    raw_rules = parsed.get("rules", [])
    if isinstance(raw_rules, dict):
        raw_rules = [raw_rules]
    return {
        "exists": bool(parsed.get("exists", True)),
        "reparseDetected": bool(parsed.get("reparseDetected", False)),
        "ownerSid": str(parsed.get("ownerSid", "") or ""),
        "currentUserSid": str(parsed.get("currentUserSid", "") or ""),
        "rules": raw_rules if isinstance(raw_rules, list) else [],
        "error": None,
    }


class _DATA_BLOB(ctypes.Structure):
    _fields_ = [
        ("cbData", wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_byte)),
    ]


def check_windows_dpapi_current_user_readiness() -> dict[str, Any]:
    """Run an in-memory DPAPI CurrentUser sentinel round-trip without touching secrets or disk."""
    if platform.system() != "Windows":
        return {
            "supported": False,
            "roundTripPassed": False,
            "scope": "CURRENT_USER",
            "reason": "NON_WINDOWS_PLATFORM",
        }

    try:
        crypt32 = ctypes.windll.crypt32
        kernel32 = ctypes.windll.kernel32
        sentinel = b"v6-dpapi-readonly-sentinel-no-secret"
        entropy_bytes = b"master-xauusd-v6-dpapi-probe-v1"

        in_buf = ctypes.create_string_buffer(sentinel, len(sentinel))
        in_blob = _DATA_BLOB(len(sentinel), ctypes.cast(in_buf, ctypes.POINTER(ctypes.c_byte)))

        ent_buf = ctypes.create_string_buffer(entropy_bytes, len(entropy_bytes))
        ent_blob = _DATA_BLOB(
            len(entropy_bytes), ctypes.cast(ent_buf, ctypes.POINTER(ctypes.c_byte))
        )

        out_blob = _DATA_BLOB()
        if not crypt32.CryptProtectData(
            ctypes.byref(in_blob),
            None,
            ctypes.byref(ent_blob),
            None,
            None,
            0x01,
            ctypes.byref(out_blob),
        ):
            return {
                "supported": True,
                "roundTripPassed": False,
                "scope": "CURRENT_USER",
                "reason": "CRYPT_PROTECT_DATA_FAILED",
            }

        try:
            decrypted_blob = _DATA_BLOB()
            if not crypt32.CryptUnprotectData(
                ctypes.byref(out_blob),
                None,
                ctypes.byref(ent_blob),
                None,
                None,
                0x01,
                ctypes.byref(decrypted_blob),
            ):
                return {
                    "supported": True,
                    "roundTripPassed": False,
                    "scope": "CURRENT_USER",
                    "reason": "CRYPT_UNPROTECT_DATA_FAILED",
                }
            try:
                recovered = ctypes.string_at(decrypted_blob.pbData, decrypted_blob.cbData)
            finally:
                kernel32.LocalFree(decrypted_blob.pbData)
        finally:
            kernel32.LocalFree(out_blob.pbData)

        matched = recovered == sentinel
        return {
            "supported": True,
            "roundTripPassed": matched,
            "scope": "CURRENT_USER",
            "reason": "DPAPI_CURRENT_USER_ROUNDTRIP_OK" if matched else "DPAPI_ROUNDTRIP_MISMATCH",
        }
    except Exception as exc:
        return {
            "supported": False,
            "roundTripPassed": False,
            "scope": "CURRENT_USER",
            "reason": f"DPAPI_PROBE_EXCEPTION:{type(exc).__name__}",
        }


def classify_effective_acl_and_dpapi(
    *,
    platform_name: str,
    target_results: Sequence[Mapping[str, Any]],
    dpapi_status: Mapping[str, Any],
    dpapi_key_blob_present: bool,
    dpapi_key_blob_acl: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Classify overall Windows effective ACL & DPAPI readiness fail-closed."""
    is_windows = str(platform_name).strip().lower() == "windows"
    if not is_windows:
        return {
            "effectiveAclVerified": False,
            "dpapiReady": False,
            "dpapiKeyBlobVerified": False,
            "status": "UNSUPPORTED_PLATFORM",
            "reason": "WINDOWS_HOST_REQUIRED_FOR_EFFECTIVE_ACL_AND_DPAPI",
            "liveAuthorized": False,
        }

    all_targets_verified = bool(target_results) and all(
        bool(item.get("verified")) for item in target_results
    )
    dpapi_ready = bool(dpapi_status.get("supported")) and bool(
        dpapi_status.get("roundTripPassed")
    )
    blob_acl_verified = bool(
        dpapi_key_blob_present
        and isinstance(dpapi_key_blob_acl, Mapping)
        and dpapi_key_blob_acl.get("verified") is True
    )

    if not all_targets_verified:
        failing_reasons = [
            f"{item.get('pathLabel', 'unknown')}:{item.get('reason', 'UNVERIFIED')}"
            for item in target_results
            if not item.get("verified")
        ]
        return {
            "effectiveAclVerified": False,
            "dpapiReady": dpapi_ready,
            "dpapiKeyBlobVerified": blob_acl_verified,
            "status": "BLOCKED",
            "reason": ";".join(failing_reasons) if failing_reasons else "ACL_TARGETS_UNVERIFIED",
            "liveAuthorized": False,
        }

    if not dpapi_ready:
        return {
            "effectiveAclVerified": True,
            "dpapiReady": False,
            "dpapiKeyBlobVerified": blob_acl_verified,
            "status": "BLOCKED",
            "reason": str(dpapi_status.get("reason") or "DPAPI_NOT_READY"),
            "liveAuthorized": False,
        }

    if not dpapi_key_blob_present:
        return {
            "effectiveAclVerified": True,
            "dpapiReady": True,
            "dpapiKeyBlobVerified": False,
            "status": "PARTIAL_HOST_READY_KEY_BLOB_MISSING",
            "reason": "DPAPI_OPERATOR_KEY_BLOB_NOT_PROVISIONED",
            "liveAuthorized": False,
        }

    if not blob_acl_verified:
        return {
            "effectiveAclVerified": True,
            "dpapiReady": True,
            "dpapiKeyBlobVerified": False,
            "status": "BLOCKED",
            "reason": str(
                (dpapi_key_blob_acl or {}).get("reason") or "DPAPI_KEY_BLOB_ACL_UNVERIFIED"
            ),
            "liveAuthorized": False,
        }

    return {
        "effectiveAclVerified": True,
        "dpapiReady": True,
        "dpapiKeyBlobVerified": True,
        "status": "HOST_ACL_AND_DPAPI_VERIFIED",
        "reason": "WINDOWS_SID_ACL_AND_DPAPI_CURRENT_USER_VERIFIED",
        "liveAuthorized": False,
    }


def build_probe_report(
    repo_root: Path,
    *,
    runtime_dir: Path | None = None,
    dpapi_key_blob_path: Path | None = None,
    now_utc: int | None = None,
) -> dict[str, Any]:
    """Run read-only Windows SID ACL & DPAPI probe and return hashed report."""
    ts = int(time.time()) if now_utc is None else int(now_utc)
    plat = platform.system()
    rt_dir = runtime_dir if runtime_dir is not None else (repo_root / ".runtime")
    key_blob = (
        dpapi_key_blob_path
        if dpapi_key_blob_path is not None
        else (rt_dir / "v6-operator-control-token.dpapi")
    )

    targets = [
        ("runtime_dir", rt_dir),
        ("latch_file", rt_dir / "v6-emergency-stop-latch.json"),
        ("uncertain_entry_file", rt_dir / "v6-uncertain-entry.json"),
    ]

    target_results: list[dict[str, Any]] = []
    operator_sid_hash: str | None = None

    if plat == "Windows":
        for label, path in targets:
            raw = _collect_windows_sid_acl(path, label)
            if raw.get("currentUserSid") and operator_sid_hash is None:
                operator_sid_hash = _sha256_text(_normalize_sid(raw["currentUserSid"]))
            if raw.get("error"):
                target_results.append(
                    {
                        "pathLabel": label,
                        "exists": raw.get("exists", False),
                        "reparseDetected": False,
                        "ownerMatchesOperatorOrSystem": False,
                        "broadWriteGrants": [],
                        "unexpectedWriteSids": [],
                        "status": "UNVERIFIED",
                        "reason": str(raw["error"]),
                        "verified": False,
                    }
                )
            else:
                target_results.append(
                    evaluate_sid_acl_rules(
                        path_label=label,
                        exists=bool(raw["exists"]),
                        owner_sid=str(raw["ownerSid"]),
                        current_user_sid=str(raw["currentUserSid"]),
                        rules=raw["rules"],
                        reparse_detected=bool(raw["reparseDetected"]),
                    )
                )

        dpapi_status = check_windows_dpapi_current_user_readiness()
        blob_present = key_blob.exists() and key_blob.is_file()
        blob_acl: dict[str, Any] | None = None
        if blob_present:
            raw_blob = _collect_windows_sid_acl(key_blob, "dpapi_operator_key_blob")
            if raw_blob.get("error"):
                blob_acl = {
                    "pathLabel": "dpapi_operator_key_blob",
                    "exists": True,
                    "verified": False,
                    "status": "UNVERIFIED",
                    "reason": str(raw_blob["error"]),
                }
            else:
                blob_acl = evaluate_sid_acl_rules(
                    path_label="dpapi_operator_key_blob",
                    exists=True,
                    owner_sid=str(raw_blob["ownerSid"]),
                    current_user_sid=str(raw_blob["currentUserSid"]),
                    rules=raw_blob["rules"],
                    reparse_detected=bool(raw_blob["reparseDetected"]),
                    forbid_any_broad_allow=True,
                )
    else:
        for label, path in targets:
            target_results.append(
                {
                    "pathLabel": label,
                    "exists": path.exists(),
                    "reparseDetected": False,
                    "ownerMatchesOperatorOrSystem": False,
                    "broadWriteGrants": [],
                    "unexpectedWriteSids": [],
                    "status": "UNSUPPORTED_PLATFORM",
                    "reason": "NON_WINDOWS_PLATFORM",
                    "verified": False,
                }
            )
        dpapi_status = check_windows_dpapi_current_user_readiness()
        blob_present = key_blob.exists() and key_blob.is_file()
        blob_acl = None

    classification = classify_effective_acl_and_dpapi(
        platform_name=plat,
        target_results=target_results,
        dpapi_status=dpapi_status,
        dpapi_key_blob_present=blob_present,
        dpapi_key_blob_acl=blob_acl,
    )

    report: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "scope": SCOPE,
        "generatedAtUtc": ts,
        "platform": plat,
        "operatorSidSha256": operator_sid_hash,
        "targets": target_results,
        "dpapi": dpapi_status,
        "dpapiKeyBlob": {
            "present": blob_present,
            "acl": blob_acl,
        },
        "effectiveAclVerified": classification["effectiveAclVerified"],
        "dpapiReady": classification["dpapiReady"],
        "dpapiKeyBlobVerified": classification["dpapiKeyBlobVerified"],
        "status": classification["status"],
        "reason": classification["reason"],
        "liveAuthorized": False,
        "secretsExposed": False,
    }
    report["reportSha256"] = _canonical_report_sha256(report)
    return report


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Read-only Windows SID-based Effective ACL & DPAPI probe for Master-XAUUSD V6."
    )
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parent.parent,
        help="Repository root directory (defaults to parent of scripts/).",
    )
    parser.add_argument(
        "--runtime-dir",
        type=Path,
        default=None,
        help="Optional explicit .runtime directory path.",
    )
    parser.add_argument(
        "--dpapi-key-blob",
        type=Path,
        default=None,
        help="Optional explicit path to DPAPI-sealed operator control token file.",
    )
    args = parser.parse_args(argv)
    report = build_probe_report(
        args.repo_root,
        runtime_dir=args.runtime_dir,
        dpapi_key_blob_path=args.dpapi_key_blob,
    )
    print(json.dumps(report, indent=2, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
