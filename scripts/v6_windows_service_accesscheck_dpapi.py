#!/usr/bin/env python3
"""Read-only, non-authorizing CURRENT-PROCESS Win32 ACL / DPAPI diagnostic.

Do not represent this as a Windows SERVICE-token attestation: current process
and current-user DPAPI can pass under an unrelated interactive user, and both
release SHA values are caller supplied. No WRITE, CLEAR, or LIVE authority.
"""

from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
import re
from pathlib import Path
import platform
import time
from typing import Any, Mapping, Sequence


SCHEMA_VERSION = 1
SCOPE = "READONLY_CURRENT_PROCESS_ACCESSCHECK_DPAPI_DIAGNOSTIC_NO_LIVE_ATTESTATION"

TOKEN_DUPLICATE = 0x0002
TOKEN_QUERY = 0x0008
SECURITY_IMPERSONATION = 2
OWNER_SECURITY_INFORMATION = 0x00000001
GROUP_SECURITY_INFORMATION = 0x00000002
DACL_SECURITY_INFORMATION = 0x00000004
FILE_GENERIC_READ = 0x00120089
FILE_GENERIC_WRITE = 0x00120116
FILE_GENERIC_EXECUTE = 0x001200A0
FILE_ALL_ACCESS = 0x001F01FF
FILE_READ_DATA = 0x00000001
FILE_WRITE_DATA = 0x00000002


class _GENERIC_MAPPING(ctypes.Structure):
    _fields_ = [
        ("GenericRead", wintypes.DWORD),
        ("GenericWrite", wintypes.DWORD),
        ("GenericExecute", wintypes.DWORD),
        ("GenericAll", wintypes.DWORD),
    ]


class _LUID(ctypes.Structure):
    _fields_ = [("LowPart", wintypes.DWORD), ("HighPart", wintypes.LONG)]


class _LUID_AND_ATTRIBUTES(ctypes.Structure):
    _fields_ = [("Luid", _LUID), ("Attributes", wintypes.DWORD)]


class _PRIVILEGE_SET(ctypes.Structure):
    _fields_ = [
        ("PrivilegeCount", wintypes.DWORD),
        ("Control", wintypes.DWORD),
        ("Privilege", _LUID_AND_ATTRIBUTES * 1),
    ]


class _DATA_BLOB(ctypes.Structure):
    _fields_ = [
        ("cbData", wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_byte)),
    ]


def _sha256_canonical(payload: Mapping[str, Any]) -> str:
    body = {k: v for k, v in payload.items() if k != "reportSha256"}
    encoded = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def evaluate_accesscheck_result(
    *,
    path_label: str,
    exists: bool,
    access_check_succeeded: bool,
    read_granted: bool,
    write_granted: bool,
    require_write: bool,
    broad_principal_screen_passed: bool = False,
) -> dict[str, Any]:
    """Evaluate Win32 AccessCheck effective-rights output for a single runtime path."""
    if not exists:
        return {
            "pathLabel": path_label,
            "exists": False,
            "accessCheckExecuted": False,
            "readGranted": False,
            "writeGranted": False,
            "verified": False,
            "status": "MISSING",
            "reason": "TARGET_PATH_NOT_FOUND",
        }

    if not access_check_succeeded:
        return {
            "pathLabel": path_label,
            "exists": True,
            "accessCheckExecuted": False,
            "readGranted": False,
            "writeGranted": False,
            "verified": False,
            "status": "UNVERIFIED",
            "reason": "WIN32_ACCESSCHECK_CALL_FAILED",
        }

    if not read_granted:
        return {
            "pathLabel": path_label,
            "exists": True,
            "accessCheckExecuted": True,
            "readGranted": False,
            "writeGranted": bool(write_granted),
            "verified": False,
            "status": "BLOCKED",
            "reason": "SERVICE_TOKEN_LACKS_EFFECTIVE_READ",
        }

    if require_write and not write_granted:
        return {
            "pathLabel": path_label,
            "exists": True,
            "accessCheckExecuted": True,
            "readGranted": True,
            "writeGranted": False,
            "verified": False,
            "status": "BLOCKED",
            "reason": "SERVICE_TOKEN_LACKS_EFFECTIVE_WRITE",
        }

    if not broad_principal_screen_passed:
        return {
            "pathLabel": path_label,
            "exists": True,
            "accessCheckExecuted": True,
            "readGranted": True,
            "writeGranted": bool(write_granted),
            "verified": False,
            "status": "PARTIAL_ACCESSCHECK_ONLY",
            "reason": "BROAD_PRINCIPAL_ACE_SCREEN_NOT_CONFIRMED",
        }

    return {
        "pathLabel": path_label,
        "exists": True,
        "accessCheckExecuted": True,
        "readGranted": True,
        "writeGranted": bool(write_granted),
        "currentProcessAccessCheckObserved": True,
        "verified": False,
        "status": "SCREENED_ONLY",
        "reason": "CURRENT_PROCESS_RIGHTS_SCREENED_NOT_SERVICE_TOKEN",
    }


def classify_service_token_attestation(
    *,
    platform_name: str,
    target_results: Sequence[Mapping[str, Any]],
    dpapi_roundtrip_ok: bool,
    declared_release_sha: str | None,
    observed_release_sha: str | None,
) -> dict[str, Any]:
    """Classify diagnostic claims; NEVER convert caller data into service proof.

    Callers can manufacture target_results, the two SHA strings, and the DPAPI
    Boolean. Even a real successful probe would be for THIS process token
    (possibly an interactive account), not independently identified service.
    """
    if str(platform_name).strip().lower() != "windows":
        return {
            "serviceTokenAccessCheckVerified": False,
            "currentProcessAccessCheckObserved": False,
            "dpapiServiceIdentityVerified": False,
            "dpapiCurrentUserRoundTripObserved": False,
            "releaseShaMatched": False,
            "releaseShaTextMatched": False,
            "status": "UNSUPPORTED_PLATFORM",
            "reason": "WINDOWS_HOST_REQUIRED",
            "liveAuthorized": False,
        }

    diagnostic_claims_pass = bool(target_results) and all(
        isinstance(item, Mapping)
        and item.get("accessCheckExecuted") is True
        and item.get("readGranted") is True
        and item.get("writeGranted") is True
        for item in target_results
    )
    declared = str(declared_release_sha or "").strip().lower()
    observed = str(observed_release_sha or "").strip().lower()
    release_text_matched = (
        re.fullmatch(r"[0-9a-f]{40}", declared) is not None
        and declared == observed
    )
    # Text equality does not prove that the observed code is the running PID's
    # binary or that any signed source / deployment record is trustworthy.
    return {
        "serviceTokenAccessCheckVerified": False,
        "currentProcessAccessCheckObserved": diagnostic_claims_pass,
        "dpapiServiceIdentityVerified": False,
        "dpapiCurrentUserRoundTripObserved": dpapi_roundtrip_ok is True,
        "releaseShaMatched": False,
        "releaseShaTextMatched": release_text_matched,
        "status": "BLOCKED",
        "reason": (
            "WINDOWS_SERVICE_PROCESS_TOKEN_AND_DEPLOYED_RELEASE_NOT_ATTESTED"
            if diagnostic_claims_pass else
            "CURRENT_PROCESS_ACCESSCHECK_NOT_PROVEN"
        ),
        "liveAuthorized": False,
    }

def _win32_access_check_path(target: Path, desired_access: int) -> tuple[bool, bool]:
    """Read-only AccessCheck on a duplicated *current process* token.

    Explicit Win32 signatures are essential on 64-bit Windows; ctypes'
    default 32-bit return type can truncate kernel handles and pointers.
    """
    if platform.system() != "Windows" or not target.exists():
        return (False, False)
    try:
        advapi32 = ctypes.windll.advapi32
        kernel32 = ctypes.windll.kernel32
        ptr = ctypes.POINTER
        advapi32.GetFileSecurityW.argtypes = [
            wintypes.LPCWSTR, wintypes.DWORD, ctypes.c_void_p,
            wintypes.DWORD, ptr(wintypes.DWORD),
        ]
        advapi32.GetFileSecurityW.restype = wintypes.BOOL
        kernel32.GetCurrentProcess.argtypes = []
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        advapi32.OpenProcessToken.argtypes = [
            wintypes.HANDLE, wintypes.DWORD, ptr(wintypes.HANDLE),
        ]
        advapi32.OpenProcessToken.restype = wintypes.BOOL
        advapi32.DuplicateToken.argtypes = [
            wintypes.HANDLE, ctypes.c_int, ptr(wintypes.HANDLE),
        ]
        advapi32.DuplicateToken.restype = wintypes.BOOL
        advapi32.AccessCheck.argtypes = [
            ctypes.c_void_p, wintypes.HANDLE, wintypes.DWORD,
            ptr(_GENERIC_MAPPING), ptr(_PRIVILEGE_SET),
            ptr(wintypes.DWORD), ptr(wintypes.DWORD), ptr(wintypes.BOOL),
        ]
        advapi32.AccessCheck.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL

        sec_info = OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION
        needed = wintypes.DWORD(0)
        advapi32.GetFileSecurityW(str(target), sec_info, None, 0, ctypes.byref(needed))
        if needed.value == 0:
            return (False, False)

        sd_buf = ctypes.create_string_buffer(needed.value)
        if not advapi32.GetFileSecurityW(str(target), sec_info, sd_buf, needed.value, ctypes.byref(needed)):
            return (False, False)

        h_token = wintypes.HANDLE()
        if not advapi32.OpenProcessToken(
            kernel32.GetCurrentProcess(),
            TOKEN_QUERY | TOKEN_DUPLICATE,
            ctypes.byref(h_token),
        ):
            return (False, False)

        h_imp = wintypes.HANDLE()
        try:
            if not advapi32.DuplicateToken(h_token, SECURITY_IMPERSONATION, ctypes.byref(h_imp)):
                return (False, False)
            try:
                mapping = _GENERIC_MAPPING(
                    FILE_GENERIC_READ,
                    FILE_GENERIC_WRITE,
                    FILE_GENERIC_EXECUTE,
                    FILE_ALL_ACCESS,
                )
                priv_set = _PRIVILEGE_SET()
                priv_len = wintypes.DWORD(ctypes.sizeof(priv_set))
                granted = wintypes.DWORD(0)
                access_status = wintypes.BOOL(0)
                ok = advapi32.AccessCheck(
                    sd_buf,
                    h_imp,
                    wintypes.DWORD(desired_access),
                    ctypes.byref(mapping),
                    ctypes.byref(priv_set),
                    ctypes.byref(priv_len),
                    ctypes.byref(granted),
                    ctypes.byref(access_status),
                )
                if not ok:
                    return (False, False)
                return (True, bool(access_status.value))
            finally:
                kernel32.CloseHandle(h_imp)
        finally:
            kernel32.CloseHandle(h_token)
    except Exception:
        return (False, False)


def _win32_dpapi_sentinel_roundtrip() -> bool:
    if platform.system() != "Windows":
        return False
    try:
        crypt32 = ctypes.windll.crypt32
        kernel32 = ctypes.windll.kernel32
        blob_ptr = ctypes.POINTER(_DATA_BLOB)
        crypt32.CryptProtectData.argtypes = [
            blob_ptr, wintypes.LPCWSTR, blob_ptr,
            ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, blob_ptr,
        ]
        crypt32.CryptProtectData.restype = wintypes.BOOL
        crypt32.CryptUnprotectData.argtypes = [
            blob_ptr, ctypes.c_void_p, blob_ptr,
            ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, blob_ptr,
        ]
        crypt32.CryptUnprotectData.restype = wintypes.BOOL
        kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        kernel32.LocalFree.restype = ctypes.c_void_p
        sentinel = b"v6-current-process-dpapi-sentinel"
        in_buf = ctypes.create_string_buffer(sentinel, len(sentinel))
        in_blob = _DATA_BLOB(len(sentinel), ctypes.cast(in_buf, ctypes.POINTER(ctypes.c_byte)))
        out_blob = _DATA_BLOB()
        if not crypt32.CryptProtectData(ctypes.byref(in_blob), None, None, None, None, 0x01, ctypes.byref(out_blob)):
            return False
        try:
            dec_blob = _DATA_BLOB()
            if not crypt32.CryptUnprotectData(ctypes.byref(out_blob), None, None, None, None, 0x01, ctypes.byref(dec_blob)):
                return False
            try:
                return ctypes.string_at(dec_blob.pbData, dec_blob.cbData) == sentinel
            finally:
                kernel32.LocalFree(ctypes.cast(dec_blob.pbData, ctypes.c_void_p))
        finally:
            kernel32.LocalFree(ctypes.cast(out_blob.pbData, ctypes.c_void_p))
    except Exception:
        return False


def build_service_token_report(
    *,
    runtime_dir: Path,
    declared_release_sha: str | None = None,
    observed_release_sha: str | None = None,
    now_utc: int | None = None,
) -> dict[str, Any]:
    """Collect read-only current-process diagnostics, NEVER service proof."""
    plat = platform.system()
    ts = int(time.time()) if now_utc is None else int(now_utc)
    targets = [
        ("runtime_dir", runtime_dir, True),
        ("latch_file", runtime_dir / "v6-emergency-stop-latch.json", True),
        ("uncertain_entry_file", runtime_dir / "v6-uncertain-entry.json", True),
    ]
    results: list[dict[str, Any]] = []
    for label, path, req_write in targets:
        if plat == "Windows" and path.exists():
            ok_r, granted_r = _win32_access_check_path(path, FILE_READ_DATA)
            ok_w, granted_w = _win32_access_check_path(path, FILE_WRITE_DATA)
            results.append(
                evaluate_accesscheck_result(
                    path_label=label,
                    exists=True,
                    access_check_succeeded=(ok_r and ok_w),
                    read_granted=granted_r,
                    write_granted=granted_w,
                    require_write=req_write,
                    broad_principal_screen_passed=False,
                )
            )
        else:
            results.append(
                evaluate_accesscheck_result(
                    path_label=label,
                    exists=path.exists(),
                    access_check_succeeded=False,
                    read_granted=False,
                    write_granted=False,
                    require_write=req_write,
                    broad_principal_screen_passed=False,
                )
            )

    dpapi_ok = _win32_dpapi_sentinel_roundtrip()
    cls = classify_service_token_attestation(
        platform_name=plat,
        target_results=results,
        dpapi_roundtrip_ok=dpapi_ok,
        declared_release_sha=declared_release_sha,
        observed_release_sha=observed_release_sha,
    )
    report: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "scope": SCOPE,
        "diagnosticOnly": True,
        "serviceIdentityNotAttested": True,
        "generatedAtUtc": ts,
        "platform": plat,
        "targets": results,
        "dpapiServiceIdentityRoundTrip": False,
        "dpapiCurrentUserRoundTripObserved": dpapi_ok,
        "currentProcessAccessCheckObserved": cls["currentProcessAccessCheckObserved"],
        "serviceProcessIdentityVerified": False,
        "serviceTokenSidVerified": False,
        "releaseShaTextMatched": cls["releaseShaTextMatched"],
        "deployedProcessReleaseVerified": False,
        "serviceTokenAccessCheckVerified": cls["serviceTokenAccessCheckVerified"],
        "dpapiServiceIdentityVerified": cls["dpapiServiceIdentityVerified"],
        "releaseShaMatched": False,
        "status": cls["status"],
        "reason": cls["reason"],
        "liveAuthorized": False,
        "secretsExposed": False,
    }
    report["reportSha256"] = _sha256_canonical(report)
    return report


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Diagnostic current-process Windows ACL/DPAPI probe; NOT service identity or LIVE attestation."
    )
    parser.add_argument("--runtime-dir", type=Path, required=True)
    parser.add_argument("--declared-release-sha", type=str, default=None)
    parser.add_argument("--observed-release-sha", type=str, default=None)
    args = parser.parse_args(argv)
    rep = build_service_token_report(
        runtime_dir=args.runtime_dir,
        declared_release_sha=args.declared_release_sha,
        observed_release_sha=args.observed_release_sha,
    )
    print(json.dumps(rep, indent=2, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
