"""G4 P0 read-only runtime process, port-owner & release attestation (#7, #91).

Strictly READ-ONLY / NO-ORDER / NO-SECRETS / NO-PROCESS-MUTATION:
- NEVER starts or stops any process.
- NEVER imports or initializes MetaTrader5, NEVER calls ``order_send``.
- NEVER modifies ARM, AUTO, BOT_MODE, DCA, ``.runtime``, secrets, or account config.
- NEVER emits raw local paths, usernames, SIDs, command lines, or secrets (SHA-256 redaction).
- NEVER trusts caller-supplied booleans (such as ``matchesExpectedRepoRoot=True``).
- Inspects Windows ports 3711, 5717, and optional 8765 read-only.
- Keeps ``gatewayProcessIdentified=False`` and ``activeRuntimeReleaseVerified=False`` unless
  independent process-to-release binding is actually proven (a read-only port/PID probe
  cannot prove in-memory loaded code matches disk or broker bridge binding).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import time
from typing import Any, Callable, Sequence

V6_PORT_ROLES: dict[int, str] = {
    3711: "AUX_OR_API_SERVICE",
    5717: "WEB_UI_CONTROL_SERVER",
    8765: "OPTIONAL_TRADE_GATEWAY_BRIDGE",
}
V6_MONITORED_PORTS: tuple[int, ...] = (3711, 5717, 8765)
ATTESTATION_SCOPE = "READONLY_PROCESS_PORT_RELEASE_ATTESTATION_NO_ORDER"
CORE_MODULE_PATHS: tuple[str, ...] = (
    "scripts/mt5-direct-probe.py",
    "scripts/xauusd-standalone-server.mjs",
    "scripts/v6_emergency_stop_gate.py",
)


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _is_valid_sha256(val: Any) -> bool:
    if not isinstance(val, str) or len(val) != 64:
        return False
    try:
        int(val, 16)
        return True
    except ValueError:
        return False


def _is_valid_git_sha40(val: Any) -> bool:
    if not isinstance(val, str) or len(val) != 40:
        return False
    try:
        int(val, 16)
        return True
    except ValueError:
        return False


def _sha256_file_lf_canonical(path: Path) -> tuple[str | None, bool]:
    """Return (canonical_lf_sha256, crlf_normalized_flag) without exposing path."""
    try:
        if not path.is_file():
            return None, False
        raw = path.read_bytes()
        has_crlf = b"\r\n" in raw
        normalized = raw.replace(b"\r\n", b"\n") if has_crlf else raw
        return _sha256_bytes(normalized), has_crlf
    except OSError:
        return None, False


def _run_cmd(args: list[str], *, cwd: Path | None = None, timeout: int = 5) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            args,
            cwd=str(cwd) if cwd is not None else None,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        return proc.returncode, (proc.stdout or "").strip()
    except Exception:
        return -1, ""


def inspect_working_tree_git_state(
    repo_root: Path,
    *,
    cmd_runner: Callable[[list[str], Path], tuple[int, str]] | None = None,
) -> dict[str, Any]:
    """Observe working-tree git HEAD & dirty state (observation only, never runtime proof)."""
    runner = cmd_runner or (lambda argv, cwd: _run_cmd(argv, cwd=cwd))
    rc_head, head_out = runner(["git", "rev-parse", "HEAD"], repo_root)
    rc_dirty, dirty_out = runner(["git", "status", "--porcelain"], repo_root)

    cand_head = head_out.strip().lower()
    head_sha = cand_head if (rc_head == 0 and _is_valid_git_sha40(cand_head)) else "UNVERIFIED"
    dirty_verified = rc_dirty == 0
    is_dirty = bool(dirty_out.strip()) if dirty_verified else True

    return {
        "workingTreeHeadObserved": head_sha,
        "workingTreeClean": bool(dirty_verified and not is_dirty),
        "gitStatusVerified": dirty_verified,
    }


def _inspect_redacted_module_digests_with_crlf(repo_root: Path) -> tuple[dict[str, str | None], list[str]]:
    digests: dict[str, str | None] = {}
    crlf_files: list[str] = []
    for rel in CORE_MODULE_PATHS:
        digest, had_crlf = _sha256_file_lf_canonical(repo_root / rel)
        digests[rel] = digest
        if had_crlf:
            crlf_files.append(rel)
    return digests, crlf_files


def inspect_redacted_module_digests(repo_root: Path) -> dict[str, str | None]:
    """Compute LF-canonical SHA-256 digests of core V6 files without exposing absolute paths."""
    digests, _ = _inspect_redacted_module_digests_with_crlf(repo_root)
    return digests


def verify_release_manifest_digests(
    observed_digests: dict[str, str | None],
    expected_release_manifest: dict[str, str] | None,
) -> dict[str, Any]:
    """Verify every core module digest against an explicit SHA-256 release manifest."""
    if not isinstance(expected_release_manifest, dict) or not expected_release_manifest:
        return {"matched": False, "reason": "RELEASE_MANIFEST_MISSING", "mismatchedModules": []}
    mismatches: list[str] = []
    for rel in CORE_MODULE_PATHS:
        expected = expected_release_manifest.get(rel)
        actual = observed_digests.get(rel)
        if (
            not _is_valid_sha256(expected)
            or not _is_valid_sha256(actual)
            or str(actual).lower() != str(expected).lower()
        ):
            mismatches.append(rel)
    if mismatches:
        return {
            "matched": False,
            "reason": "RELEASE_MANIFEST_DIGEST_MISMATCH",
            "mismatchedModules": mismatches,
        }
    return {"matched": True, "reason": "RELEASE_MANIFEST_MATCHED", "mismatchedModules": []}


def _normalize_listener_entries(raw_entry: Any) -> list[dict[str, Any]]:
    """Normalize single or multiple listeners on one port; strictly redact paths/owners/SIDs/cmdline."""
    if raw_entry is None:
        return []
    items = raw_entry if isinstance(raw_entry, list) else [raw_entry]
    listeners: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        pid = item.get("pid")
        if type(pid) is not int or pid <= 0:
            continue
        owner_raw = str(item.get("owner") or "").strip()
        sid_raw = str(item.get("ownerSid") or item.get("sid") or "").strip()
        cmd_raw = str(item.get("commandLine") or "").strip()
        exe_raw = str(item.get("executablePath") or "").strip()
        exe_sha = item.get("executableSha256")
        # Intentionally IGNORE caller-supplied trust flags such as matchesExpectedRepoRoot.
        listeners.append({
            "pid": pid,
            "ownerHash": _sha256_text(owner_raw) if owner_raw else None,
            "ownerSidHash": _sha256_text(sid_raw) if sid_raw else None,
            "cmdHash": _sha256_text(cmd_raw) if cmd_raw else None,
            "executablePathHash": _sha256_text(exe_raw) if exe_raw else None,
            "executableSha256": str(exe_sha).lower() if _is_valid_sha256(exe_sha) else None,
        })
    return listeners


def _empty_ports_map(ports: Sequence[int]) -> dict[str, dict[str, Any]]:
    return {
        str(p): {
            "role": V6_PORT_ROLES.get(int(p), "UNKNOWN"),
            "listening": False,
            "listenerCount": 0,
            "multipleListeners": False,
            "listeners": [],
        }
        for p in ports
    }


def inspect_port_owners(
    ports: tuple[int, ...] = V6_MONITORED_PORTS,
    *,
    port_inspector: Callable[[tuple[int, ...]], dict[Any, Any]] | None = None,
    powershell_runner: Callable[[list[str]], tuple[int, str]] | None = None,
    is_windows_override: bool | None = None,
) -> dict[str, Any]:
    """Inspect PIDs & redacted owner/executable hashes for ports 3711, 5717, and optional 8765."""
    empty_ports = _empty_ports_map(ports)

    if port_inspector is not None:
        try:
            raw_map = port_inspector(ports)
        except Exception:
            return {"status": "UNVERIFIED", "reason": "PORT_INSPECTOR_EXCEPTION", "ports": empty_ports}
        if not isinstance(raw_map, dict):
            return {"status": "UNVERIFIED", "reason": "PORT_INSPECTOR_INVALID_SHAPE", "ports": empty_ports}
        redacted: dict[str, dict[str, Any]] = {}
        for p in ports:
            raw_entry = raw_map.get(p) if p in raw_map else raw_map.get(str(p))
            listeners = _normalize_listener_entries(raw_entry)
            redacted[str(p)] = {
                "role": V6_PORT_ROLES.get(p, "UNKNOWN"),
                "listening": len(listeners) > 0,
                "listenerCount": len(listeners),
                "multipleListeners": len(listeners) > 1,
                "listeners": listeners,
            }
        return {"status": "OBSERVED", "reason": "PORT_OWNERS_OBSERVED", "ports": redacted}

    is_windows = (os.name == "nt") if is_windows_override is None else bool(is_windows_override)
    if not is_windows:
        return {
            "status": "UNVERIFIED",
            "reason": "NON_WINDOWS_HOST_PORT_ATTESTATION_UNVERIFIED",
            "ports": empty_ports,
        }

    ps_script = (
        "$ports = @(" + ",".join(str(int(p)) for p in ports) + "); "
        "$out = @{}; "
        "foreach ($p in $ports) { "
        "  $conns = @(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue); "
        "  $arr = @(); "
        "  foreach ($c in $conns) { "
        "    $proc = Get-CimInstance Win32_Process -Filter \"ProcessId=$($c.OwningProcess)\" -ErrorAction SilentlyContinue; "
        "    $owner = ''; $sid = ''; "
        "    try { $o = Invoke-CimMethod -InputObject $proc -MethodName GetOwner -ErrorAction SilentlyContinue; if ($o.User) { $owner = \"$($o.Domain)\\$($o.User)\" } } catch {}; "
        "    try { $s = Invoke-CimMethod -InputObject $proc -MethodName GetOwnerSid -ErrorAction SilentlyContinue; if ($s.Sid) { $sid = [string]$s.Sid } } catch {}; "
        "    $exe = [string]$proc.ExecutablePath; "
        "    $exeHash = ''; if ($exe -and (Test-Path $exe)) { try { $exeHash = (Get-FileHash -Algorithm SHA256 -Path $exe).Hash.ToLowerInvariant() } catch {} }; "
        "    $arr += @{ pid = [int]$c.OwningProcess; owner = $owner; ownerSid = $sid; commandLine = [string]$proc.CommandLine; executablePath = $exe; executableSha256 = $exeHash } "
        "  }; "
        "  $out[\"$p\"] = $arr "
        "}; "
        "$out | ConvertTo-Json -Depth 5 -Compress"
    )
    ps_argv = ["powershell", "-NoProfile", "-Command", ps_script]
    if powershell_runner is not None:
        try:
            rc, stdout = powershell_runner(ps_argv)
        except Exception:
            return {"status": "UNVERIFIED", "reason": "WINDOWS_PORT_QUERY_UNAVAILABLE", "ports": empty_ports}
    else:
        rc, stdout = _run_cmd(ps_argv, timeout=10)

    if rc != 0 or not str(stdout or "").strip():
        return {"status": "UNVERIFIED", "reason": "WINDOWS_PORT_QUERY_UNAVAILABLE", "ports": empty_ports}
    try:
        parsed = json.loads(stdout)
    except Exception:
        return {"status": "UNVERIFIED", "reason": "WINDOWS_PORT_QUERY_INVALID_JSON", "ports": empty_ports}
    if not isinstance(parsed, dict):
        return {"status": "UNVERIFIED", "reason": "WINDOWS_PORT_QUERY_INVALID_SHAPE", "ports": empty_ports}

    redacted_win: dict[str, dict[str, Any]] = {}
    for p in ports:
        listeners = _normalize_listener_entries(parsed.get(str(p)))
        redacted_win[str(p)] = {
            "role": V6_PORT_ROLES.get(p, "UNKNOWN"),
            "listening": len(listeners) > 0,
            "listenerCount": len(listeners),
            "multipleListeners": len(listeners) > 1,
            "listeners": listeners,
        }
    return {"status": "OBSERVED", "reason": "WINDOWS_PORT_OWNERS_OBSERVED", "ports": redacted_win}


def inspect_readonly_arm_and_sizing_source(repo_root: Path) -> dict[str, Any]:
    """Read-only static hint of sizing mode; effective runtime sizing stays UNVERIFIED."""
    probe_file = repo_root / "scripts" / "mt5-direct-probe.py"
    source_hint = "UNVERIFIED"
    if probe_file.is_file():
        try:
            text = probe_file.read_text(encoding="utf-8", errors="ignore")
            if '"sizingMode": "FIXED_LOT"' in text:
                source_hint = "FIXED_LOT"
        except OSError:
            source_hint = "UNVERIFIED"
    return {
        "sourceSizingModeHint": source_hint,
        "effectivePreSendSizingMode": "UNVERIFIED",
        "armStateMutated": False,
        "liveAuthorized": False,
    }


def _executable_matches(
    listeners: list[dict[str, Any]],
    expected_executable_sha256: str | None,
) -> tuple[bool, bool]:
    """Return (checked, matched) for a single listener against an expected executable SHA-256."""
    if expected_executable_sha256 is None:
        return False, False
    if not _is_valid_sha256(expected_executable_sha256) or len(listeners) != 1:
        return True, False
    observed = listeners[0].get("executableSha256")
    if not _is_valid_sha256(observed):
        return True, False
    return True, str(observed).lower() == expected_executable_sha256.lower()


def collect_runtime_process_attestation(
    *,
    repo_root: Path,
    expected_release_sha: str,
    expected_release_manifest: dict[str, str] | None = None,
    expected_executable_sha256: str | None = None,
    previous_gateway_pid: int | None = None,
    now_utc: int | None = None,
    cmd_runner: Callable[[list[str], Path], tuple[int, str]] | None = None,
    port_inspector: Callable[[tuple[int, ...]], dict[Any, Any]] | None = None,
    powershell_runner: Callable[[list[str]], tuple[int, str]] | None = None,
    is_windows_override: bool | None = None,
) -> dict[str, Any]:
    """Collect redacted read-only runtime process/port/release attestation (#7, #91).

    Fail-closed invariants:
    - Never claims ``gatewayProcessIdentified=True`` from port ownership alone.
    - Never claims ``activeRuntimeReleaseVerified=True`` without independent process-to-release proof.
    - Always keeps ``liveAuthorized=False``, ``secretsExposed=False``, ``orderSendCalled=False``.
    """
    ts = int(time.time() if now_utc is None else now_utc)
    expected_sha = str(expected_release_sha or "").strip().lower()
    git_state = inspect_working_tree_git_state(repo_root, cmd_runner=cmd_runner)
    digests, crlf_files = _inspect_redacted_module_digests_with_crlf(repo_root)
    manifest_check = verify_release_manifest_digests(digests, expected_release_manifest)
    port_state = inspect_port_owners(
        V6_MONITORED_PORTS,
        port_inspector=port_inspector,
        powershell_runner=powershell_runner,
        is_windows_override=is_windows_override,
    )
    arm_sizing = inspect_readonly_arm_and_sizing_source(repo_root)

    ports_map = port_state["ports"]
    p3711 = ports_map.get("3711", {})
    p5717 = ports_map.get("5717", {})
    p8765 = ports_map.get("8765", {})

    any_listener = any(entry.get("listening") for entry in ports_map.values())
    any_multiple_listeners = any(entry.get("multipleListeners") for entry in ports_map.values())
    port_owner_observed = bool(
        port_state["status"] == "OBSERVED"
        and any(
            entry.get("listening") and any(l.get("ownerHash") for l in entry.get("listeners", []))
            for entry in ports_map.values()
        )
    )

    # Evaluate primary observed candidate listener (8765 if present, else 3711/5717 for mismatch checks).
    gw_listeners = p8765.get("listeners", [])
    primary_listeners = (
        gw_listeners
        if len(gw_listeners) == 1
        else (p3711.get("listeners", []) if len(p3711.get("listeners", [])) == 1 else p5717.get("listeners", []))
    )
    exe_checked, exe_matched = _executable_matches(primary_listeners, expected_executable_sha256)
    exe_mismatch = bool(exe_checked and not exe_matched and len(primary_listeners) == 1)

    gw_pid = gw_listeners[0]["pid"] if len(gw_listeners) == 1 else None
    pid_changed = bool(
        isinstance(previous_gateway_pid, int)
        and not isinstance(previous_gateway_pid, bool)
        and previous_gateway_pid > 0
        and gw_pid is not None
        and gw_pid != previous_gateway_pid
    )

    # Read-only port/PID observation NEVER proves independent process-to-release binding.
    # Both flags remain strictly False until an independent host binding proof exists.
    gateway_process_identified = False
    active_runtime_release_verified = False

    blocking_reasons: list[str] = []
    if port_state["status"] != "OBSERVED":
        blocking_reasons.append(port_state["reason"])
    elif not any_listener:
        blocking_reasons.append("NO_LISTENERS_OBSERVED")
    if any_multiple_listeners:
        blocking_reasons.append("MULTIPLE_PORT_LISTENERS_AMBIGUOUS")
    if port_state["status"] == "OBSERVED" and any_listener and not p8765.get("listening"):
        blocking_reasons.append("OPTIONAL_BRIDGE_PORT_8765_ABSENT")
    if exe_mismatch:
        blocking_reasons.append("GATEWAY_EXECUTABLE_MISMATCH")
    if pid_changed:
        blocking_reasons.append("GATEWAY_PID_CHANGED_REQUIRES_REATTESTATION")
    if not git_state["workingTreeClean"]:
        blocking_reasons.append("WORKING_TREE_DIRTY")
    if not (_is_valid_git_sha40(expected_sha) and git_state["workingTreeHeadObserved"] == expected_sha):
        blocking_reasons.append("RELEASE_SHA_MISMATCH")
    if not manifest_check["matched"]:
        blocking_reasons.append(manifest_check["reason"])

    if not blocking_reasons:
        blocking_reasons.append("PROCESS_TO_RELEASE_BINDING_NOT_INDEPENDENTLY_PROVEN")

    reason = blocking_reasons[0]

    body = {
        "schemaVersion": 2,
        "scope": ATTESTATION_SCOPE,
        "generatedAtUtc": ts,
        "platform": platform.system(),
        "repoRootHash": _sha256_text(str(repo_root)),
        "expectedReleaseSha": expected_sha if _is_valid_git_sha40(expected_sha) else "UNVERIFIED",
        "workingTreeHeadObserved": git_state["workingTreeHeadObserved"],
        "workingTreeClean": git_state["workingTreeClean"],
        "gitStatusVerified": git_state["gitStatusVerified"],
        "moduleDigestsSha256": digests,
        "crlfNormalizedModules": crlf_files,
        "crlfEquivalenceApplied": len(crlf_files) > 0,
        "releaseManifestCheck": manifest_check,
        "portAttestation": port_state,
        "portOwnerObserved": port_owner_observed,
        "executableDigestChecked": exe_checked,
        "executableDigestMatched": exe_matched,
        "gatewayPidChanged": pid_changed,
        "gatewayProcessIdentified": gateway_process_identified,
        "activeRuntimeReleaseVerified": active_runtime_release_verified,
        "armAndSizingSource": arm_sizing,
        "blockingReasons": blocking_reasons,
        "status": "UNVERIFIED",
        "reason": reason,
        "processMutated": False,
        "orderSendCalled": False,
        "liveAuthorized": False,
        "secretsExposed": False,
    }
    canonical = json.dumps(body, sort_keys=True, ensure_ascii=True, separators=(",", ":"))
    body["reportSha256"] = _sha256_text(canonical)
    return body


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only V6 process/port/release attestation (NO-ORDER)")
    parser.add_argument("--repo-root", default=str(Path(__file__).resolve().parent.parent))
    parser.add_argument("--expected-release-sha", required=True)
    parser.add_argument("--expected-executable-sha256", default=None)
    args = parser.parse_args(argv)
    report = collect_runtime_process_attestation(
        repo_root=Path(args.repo_root),
        expected_release_sha=args.expected_release_sha,
        expected_executable_sha256=args.expected_executable_sha256,
    )
    print(json.dumps(report, indent=2, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
