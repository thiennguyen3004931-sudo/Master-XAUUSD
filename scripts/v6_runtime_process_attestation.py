"""G4 P0 read-only runtime process, port-owner & release attestation (#7).

Strictly READ-ONLY / NO-ORDER / NO-SECRETS:
- NEVER imports MetaTrader5, NEVER calls `order_send`, NEVER mutates ARM/BOT_MODE/config.
- NEVER emits raw local paths, usernames, SIDs, or environment secrets (redacts via SHA-256).
- NEVER trusts caller-supplied booleans (such as `matchesExpectedRepoRoot=True`).
- Explicitly separates:
  * `workingTreeHeadObserved` (`git rev-parse HEAD` on disk — observation only),
  * `releaseManifestCheck` (local Git commit blob SHA-256 comparison; not host proof),
  * `portOwnerObserved` (read-only listener PID/owner hashes observed on 3711/5717/8765),
  * `gatewayProcessIdentified` (requires non-conflicting single listener with verified
    executable/script digest & endpoint role, NOT web-only 5717 without trade bridge 8765),
  * `activeRuntimeReleaseVerified` (always `False` / `UNVERIFIED` unless full independent
    host PID -> executable -> release manifest binding is verified without drift).
- Separates static `sourceSizingModeHint` from `effectivePreSendSizingMode` (kept
  `UNVERIFIED` without verified runtime config/path).
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
from typing import Any, Callable

V6_PORT_ROLES = {
    3711: "AUX_OR_LEGACY_SERVICE",
    5717: "WEB_UI_CONTROL_SERVER",
    8765: "TRADE_GATEWAY_BRIDGE",
}
V6_MONITORED_PORTS = tuple(V6_PORT_ROLES.keys())
ATTESTATION_SCOPE = "READONLY_PROCESS_PORT_RELEASE_ATTESTATION_NO_ORDER"
CORE_MODULE_PATHS = (
    "scripts/mt5-direct-probe.py",
    "scripts/xauusd-standalone-server.mjs",
    "scripts/v6_emergency_stop_gate.py",
)


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _sha256_file(path: Path) -> str | None:
    try:
        if not path.is_file():
            return None
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


def _is_valid_sha256(val: Any) -> bool:
    if not isinstance(val, str) or len(val) != 64:
        return False
    try:
        int(val, 16)
        return True
    except ValueError:
        return False


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
    """Observe working-tree git HEAD & dirty state (never treated as active process proof)."""
    runner = cmd_runner or (lambda argv, cwd: _run_cmd(argv, cwd=cwd))
    rc_head, head_out = runner(["git", "rev-parse", "HEAD"], repo_root)
    rc_dirty, dirty_out = runner(["git", "status", "--porcelain"], repo_root)

    head_sha = head_out.strip() if (rc_head == 0 and len(head_out.strip()) == 40) else "UNVERIFIED"
    dirty_verified = rc_dirty == 0
    is_dirty = bool(dirty_out.strip()) if dirty_verified else True

    return {
        "workingTreeHeadObserved": head_sha,
        "workingTreeClean": bool(dirty_verified and not is_dirty),
        "gitStatusVerified": dirty_verified,
    }


def inspect_redacted_module_digests(repo_root: Path) -> dict[str, str | None]:
    """Compute SHA-256 digests of core V6 runtime files without exposing absolute paths."""
    return {rel: _sha256_file(repo_root / rel) for rel in CORE_MODULE_PATHS}


def verify_release_manifest_digests(
    observed_digests: dict[str, str | None],
    expected_release_manifest: dict[str, str] | None,
) -> dict[str, Any]:
    """Verify every core module digest against an explicit SHA-256 release manifest."""
    if not isinstance(expected_release_manifest, dict) or not expected_release_manifest:
        return {"matched": False, "reason": "RELEASE_MANIFEST_MISSING"}
    mismatches: list[str] = []
    for rel in CORE_MODULE_PATHS:
        expected = expected_release_manifest.get(rel)
        actual = observed_digests.get(rel)
        if not _is_valid_sha256(expected) or not _is_valid_sha256(actual) or actual != expected:
            mismatches.append(rel)
    if mismatches:
        return {"matched": False, "reason": "RELEASE_MANIFEST_DIGEST_MISMATCH", "mismatchedModules": mismatches}
    return {"matched": True, "reason": "RELEASE_MANIFEST_MATCHED", "mismatchedModules": []}


def derive_local_git_commit_manifest(
    repo_root: Path, expected_release_sha: str
) -> tuple[dict[str, str] | None, str]:
    """Hash core module blobs from a local immutable Git commit object.

    This proves only that disk files match the locally available Git object.
    It does NOT authenticate the origin of the Git repository, the owner of a
    running process, the active release, or permission to trade.
    """
    sha = str(expected_release_sha or "").strip()
    if len(sha) != 40:
        return None, "INVALID_RELEASE_SHA"
    try:
        int(sha, 16)
    except ValueError:
        return None, "INVALID_RELEASE_SHA"

    try:
        commit = subprocess.run(
            ["git", "cat-file", "-t", sha], cwd=str(repo_root),
            capture_output=True, check=False, timeout=5,
        )
        if commit.returncode != 0 or commit.stdout.strip() != b"commit":
            return None, "LOCAL_GIT_COMMIT_OBJECT_UNAVAILABLE"

        manifest: dict[str, str] = {}
        for rel in CORE_MODULE_PATHS:
            blob = subprocess.run(
                ["git", "show", f"{sha}:{rel}"], cwd=str(repo_root),
                capture_output=True, check=False, timeout=5,
            )
            if blob.returncode != 0:
                return None, "LOCAL_GIT_MODULE_OBJECT_UNAVAILABLE"
            manifest[rel] = hashlib.sha256(blob.stdout).hexdigest()
        return manifest, "LOCAL_GIT_COMMIT_BLOBS_HASHED"
    except (OSError, subprocess.TimeoutExpired):
        return None, "LOCAL_GIT_OBJECT_READ_FAILED"


def _normalize_listener_entries(raw_entry: Any) -> list[dict[str, Any]]:
    """Normalize single or multiple listeners on one port; redact raw paths/owners."""
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
        cmd_raw = str(item.get("commandLine") or "").strip()
        exe_raw = str(item.get("executablePath") or "").strip()
        exe_sha = item.get("executableSha256")
        listeners.append({
            "pid": pid,
            "ownerHash": _sha256_text(owner_raw) if owner_raw else None,
            "cmdHash": _sha256_text(cmd_raw) if cmd_raw else None,
            "executablePathHash": _sha256_text(exe_raw) if exe_raw else None,
            "executableSha256": exe_sha if _is_valid_sha256(exe_sha) else None,
        })
    return listeners


def inspect_port_owners(
    ports: tuple[int, ...] = V6_MONITORED_PORTS,
    *,
    port_inspector: Callable[[tuple[int, ...]], dict[Any, Any]] | None = None,
) -> dict[str, Any]:
    """Inspect PIDs & redacted owner/executable hashes for ports 3711/5717/8765."""
    empty_ports = {
        str(p): {
            "role": V6_PORT_ROLES.get(p, "UNKNOWN"),
            "listening": False,
            "listenerCount": 0,
            "multipleListeners": False,
            "listeners": [],
        }
        for p in ports
    }

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

    if os.name != "nt":
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
        "    $owner = ''; try { $o = Invoke-CimMethod -InputObject $proc -MethodName GetOwner -ErrorAction SilentlyContinue; if ($o.User) { $owner = \"$($o.Domain)\\$($o.User)\" } } catch {}; "
        "    $exe = [string]$proc.ExecutablePath; "
        "    $exeHash = ''; if ($exe -and (Test-Path $exe)) { try { $exeHash = (Get-FileHash -Algorithm SHA256 -Path $exe).Hash.ToLowerInvariant() } catch {} }; "
        "    $arr += @{ pid = [int]$c.OwningProcess; owner = $owner; commandLine = [string]$proc.CommandLine; executablePath = $exe; executableSha256 = $exeHash } "
        "  }; "
        "  $out[\"$p\"] = $arr "
        "}; "
        "$out | ConvertTo-Json -Depth 5 -Compress"
    )
    rc, stdout = _run_cmd(["powershell", "-NoProfile", "-Command", ps_script], timeout=10)
    if rc != 0 or not stdout:
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


def collect_runtime_process_attestation(
    *,
    repo_root: Path,
    expected_release_sha: str,
    expected_release_manifest: dict[str, str] | None = None,
    previous_gateway_pid: int | None = None,
    now_utc: int | None = None,
    cmd_runner: Callable[[list[str], Path], tuple[int, str]] | None = None,
    port_inspector: Callable[[tuple[int, ...]], dict[Any, Any]] | None = None,
) -> dict[str, Any]:
    """Collect redacted read-only runtime process/port/release attestation (#7 G4)."""
    ts = int(time.time() if now_utc is None else now_utc)
    expected_sha = str(expected_release_sha or "").strip()
    git_state = inspect_working_tree_git_state(repo_root, cmd_runner=cmd_runner)
    digests = inspect_redacted_module_digests(repo_root)
    if expected_release_manifest is None:
        # Git commit blobs are a local, source-only reference, not a signed
        # external release attestation or proof of code loaded by a process.
        manifest, manifest_reason = derive_local_git_commit_manifest(repo_root, expected_sha)
        manifest_provenance = (
            "LOCAL_GIT_COMMIT_OBJECT_UNTRUSTED" if manifest is not None else "UNAVAILABLE"
        )
    else:
        manifest = expected_release_manifest
        manifest_reason = "CALLER_SUPPLIED_MANIFEST_NOT_INDEPENDENT"
        manifest_provenance = "CALLER_SUPPLIED_UNTRUSTED"
    manifest_check = verify_release_manifest_digests(digests, manifest)
    port_state = inspect_port_owners(V6_MONITORED_PORTS, port_inspector=port_inspector)
    arm_sizing = inspect_readonly_arm_and_sizing_source(repo_root)

    p5717 = port_state["ports"].get("5717", {})
    p8765 = port_state["ports"].get("8765", {})

    port_owner_observed = bool(
        port_state["status"] == "OBSERVED"
        and any(
            entry.get("listening") and any(l.get("ownerHash") for l in entry.get("listeners", []))
            for entry in port_state["ports"].values()
        )
    )

    gw_listeners = p8765.get("listeners", [])
    gw_single = len(gw_listeners) == 1
    gw_pid = gw_listeners[0]["pid"] if gw_single else None
    pid_changed = bool(
        isinstance(previous_gateway_pid, int)
        and not isinstance(previous_gateway_pid, bool)
        and previous_gateway_pid > 0
        and gw_pid is not None
        and gw_pid != previous_gateway_pid
    )
    gateway_process_identified = bool(
        port_state["status"] == "OBSERVED"
        and gw_single
        and not p8765.get("multipleListeners")
        and gw_listeners[0].get("ownerHash") is not None
        and gw_listeners[0].get("executableSha256") is not None
        and not pid_changed
    )

    active_runtime_release_verified = False

    if not manifest_check["matched"]:
        reason = manifest_check["reason"]
    elif not (len(expected_sha) == 40 and git_state["workingTreeHeadObserved"] == expected_sha and git_state["workingTreeClean"]):
        reason = "WORKING_TREE_SHA_OR_CLEANLINESS_UNVERIFIED"
    elif p8765.get("multipleListeners") or p5717.get("multipleListeners"):
        reason = "MULTIPLE_PORT_LISTENERS_AMBIGUOUS"
    elif not p8765.get("listening"):
        reason = "TRADE_GATEWAY_PORT_8765_ABSENT_WEB_ONLY_INSUFFICIENT"
    elif pid_changed:
        reason = "GATEWAY_PID_CHANGED_REQUIRES_REATTESTATION"
    elif not gateway_process_identified:
        reason = "GATEWAY_PROCESS_EXECUTABLE_OR_OWNER_UNVERIFIED"
    else:
        reason = "READONLY_OBSERVATION_REQUIRES_INDEPENDENT_HOST_RUNTIME_ATTESTATION"

    body = {
        "schemaVersion": 1,
        "scope": ATTESTATION_SCOPE,
        "generatedAtUtc": ts,
        "platform": platform.system(),
        "repoRootHash": _sha256_text(str(repo_root)),
        "expectedReleaseSha": expected_sha or "UNVERIFIED",
        "workingTreeHeadObserved": git_state["workingTreeHeadObserved"],
        "workingTreeClean": git_state["workingTreeClean"],
        "moduleDigestsSha256": digests,
        "releaseManifestCheck": manifest_check,
        "manifestProvenance": manifest_provenance,
        "manifestDerivationReason": manifest_reason,
        "portAttestation": port_state,
        "portOwnerObserved": port_owner_observed,
        "gatewayProcessIdentified": gateway_process_identified,
        "gatewayPidChanged": pid_changed,
        "armAndSizingSource": arm_sizing,
        "activeRuntimeReleaseVerified": active_runtime_release_verified,
        "status": "UNVERIFIED",
        "reason": reason,
        "liveAuthorized": False,
        "secretsExposed": False,
    }
    canonical = json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    body["reportSha256"] = _sha256_text(canonical)
    return body


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only V6 process/port/release attestation (NO-ORDER)")
    parser.add_argument("--repo-root", default=str(Path(__file__).resolve().parent.parent))
    parser.add_argument("--expected-release-sha", required=True)
    args = parser.parse_args()
    report = collect_runtime_process_attestation(
        repo_root=Path(args.repo_root),
        expected_release_sha=args.expected_release_sha,
    )
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
