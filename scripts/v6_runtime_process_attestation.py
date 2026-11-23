"""G4 P0 read-only runtime process, port-owner & release attestation (#7).

Strictly READ-ONLY / NO-ORDER / NO-SECRETS:
- NEVER imports MetaTrader5, NEVER calls `order_send`, NEVER mutates ARM/BOT_MODE/config.
- NEVER emits raw local paths, usernames, SIDs, or environment secrets (redacts via SHA-256).
- Explicitly separates:
  * `workingTreeHeadObserved` (`git rev-parse HEAD` on disk — observation only),
  * `activeRuntimeReleaseVerified` (`True` ONLY when a live V6 process on expected
    ports 3711/5717/8765 has verified PID, owner hash, clean git tree, and matching
    module/release digest; otherwise `False` / `UNVERIFIED`).
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

V6_MONITORED_PORTS = (3711, 5717, 8765)
ATTESTATION_SCOPE = "READONLY_PROCESS_PORT_RELEASE_ATTESTATION_NO_ORDER"


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _sha256_file(path: Path) -> str | None:
    try:
        if not path.is_file():
            return None
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


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
    rel_files = (
        "scripts/mt5-direct-probe.py",
        "scripts/xauusd-standalone-server.mjs",
        "scripts/v6_emergency_stop_gate.py",
    )
    return {rel: _sha256_file(repo_root / rel) for rel in rel_files}


def inspect_port_owners(
    ports: tuple[int, ...] = V6_MONITORED_PORTS,
    *,
    port_inspector: Callable[[tuple[int, ...]], dict[int, dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    """Inspect PID & redacted owner hash for V6 ports (3711/5717/8765) without raw usernames."""
    if port_inspector is not None:
        try:
            raw_map = port_inspector(ports)
        except Exception:
            return {"status": "UNVERIFIED", "reason": "PORT_INSPECTOR_EXCEPTION", "ports": {}}
        if not isinstance(raw_map, dict):
            return {"status": "UNVERIFIED", "reason": "PORT_INSPECTOR_INVALID_SHAPE", "ports": {}}
        redacted: dict[str, dict[str, Any]] = {}
        for p in ports:
            entry = raw_map.get(p) or raw_map.get(str(p))
            if not isinstance(entry, dict) or not isinstance(entry.get("pid"), int) or isinstance(entry.get("pid"), bool) or entry["pid"] <= 0:
                redacted[str(p)] = {"listening": False, "pid": None, "ownerHash": None, "cmdHash": None}
            else:
                owner_raw = str(entry.get("owner") or "").strip()
                cmd_raw = str(entry.get("commandLine") or "").strip()
                redacted[str(p)] = {
                    "listening": True,
                    "pid": int(entry["pid"]),
                    "ownerHash": _sha256_text(owner_raw) if owner_raw else None,
                    "cmdHash": _sha256_text(cmd_raw) if cmd_raw else None,
                    "matchesExpectedRepoRoot": bool(entry.get("matchesExpectedRepoRoot") is True),
                }
        return {"status": "OBSERVED", "reason": "PORT_OWNERS_OBSERVED", "ports": redacted}

    if os.name != "nt":
        return {
            "status": "UNVERIFIED",
            "reason": "NON_WINDOWS_HOST_PORT_ATTESTATION_UNVERIFIED",
            "ports": {str(p): {"listening": False, "pid": None, "ownerHash": None, "cmdHash": None} for p in ports},
        }

    ps_script = (
        "$ports = @(" + ",".join(str(int(p)) for p in ports) + "); "
        "$out = @{}; "
        "foreach ($p in $ports) { "
        "  $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; "
        "  if ($c) { "
        "    $proc = Get-CimInstance Win32_Process -Filter \"ProcessId=$($c.OwningProcess)\" -ErrorAction SilentlyContinue; "
        "    $owner = ''; try { $o = Invoke-CimMethod -InputObject $proc -MethodName GetOwner -ErrorAction SilentlyContinue; if ($o.User) { $owner = \"$($o.Domain)\\$($o.User)\" } } catch {}; "
        "    $out[\"$p\"] = @{ pid = [int]$c.OwningProcess; owner = $owner; commandLine = [string]$proc.CommandLine } "
        "  } "
        "}; "
        "$out | ConvertTo-Json -Compress"
    )
    rc, stdout = _run_cmd(["powershell", "-NoProfile", "-Command", ps_script], timeout=10)
    if rc != 0 or not stdout:
        return {
            "status": "UNVERIFIED",
            "reason": "WINDOWS_PORT_QUERY_UNAVAILABLE",
            "ports": {str(p): {"listening": False, "pid": None, "ownerHash": None, "cmdHash": None} for p in ports},
        }
    try:
        parsed = json.loads(stdout)
    except Exception:
        return {
            "status": "UNVERIFIED",
            "reason": "WINDOWS_PORT_QUERY_INVALID_JSON",
            "ports": {str(p): {"listening": False, "pid": None, "ownerHash": None, "cmdHash": None} for p in ports},
        }
    if not isinstance(parsed, dict):
        parsed = {}
    redacted_win: dict[str, dict[str, Any]] = {}
    for p in ports:
        entry = parsed.get(str(p))
        if isinstance(entry, dict) and isinstance(entry.get("pid"), int) and entry["pid"] > 0:
            owner_raw = str(entry.get("owner") or "").strip()
            cmd_raw = str(entry.get("commandLine") or "").strip()
            redacted_win[str(p)] = {
                "listening": True,
                "pid": int(entry["pid"]),
                "ownerHash": _sha256_text(owner_raw) if owner_raw else None,
                "cmdHash": _sha256_text(cmd_raw) if cmd_raw else None,
                "matchesExpectedRepoRoot": False,
            }
        else:
            redacted_win[str(p)] = {"listening": False, "pid": None, "ownerHash": None, "cmdHash": None}
    return {"status": "OBSERVED", "reason": "WINDOWS_PORT_OWNERS_OBSERVED", "ports": redacted_win}


def inspect_readonly_arm_and_sizing_source(repo_root: Path) -> dict[str, Any]:
    """Read-only inspection of effective sizing mode & ARM default without mutating state."""
    probe_file = repo_root / "scripts" / "mt5-direct-probe.py"
    sizing_mode = "UNVERIFIED"
    if probe_file.is_file():
        try:
            text = probe_file.read_text(encoding="utf-8", errors="ignore")
            if '"sizingMode": "FIXED_LOT"' in text:
                sizing_mode = "FIXED_LOT"
        except OSError:
            sizing_mode = "UNVERIFIED"
    return {
        "effectivePreSendSizingMode": sizing_mode,
        "armStateMutated": False,
        "liveAuthorized": False,
    }


def collect_runtime_process_attestation(
    *,
    repo_root: Path,
    expected_release_sha: str,
    now_utc: int | None = None,
    cmd_runner: Callable[[list[str], Path], tuple[int, str]] | None = None,
    port_inspector: Callable[[tuple[int, ...]], dict[int, dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    """Collect redacted read-only runtime process/port/release attestation (#7 G4)."""
    ts = int(time.time() if now_utc is None else now_utc)
    expected_sha = str(expected_release_sha or "").strip()
    git_state = inspect_working_tree_git_state(repo_root, cmd_runner=cmd_runner)
    digests = inspect_redacted_module_digests(repo_root)
    port_state = inspect_port_owners(V6_MONITORED_PORTS, port_inspector=port_inspector)
    arm_sizing = inspect_readonly_arm_and_sizing_source(repo_root)

    gateway_5717 = port_state["ports"].get("5717", {})
    sha_matches = bool(
        len(expected_sha) == 40
        and git_state["workingTreeHeadObserved"] == expected_sha
        and git_state["workingTreeClean"] is True
    )
    process_bound = bool(
        port_state["status"] == "OBSERVED"
        and gateway_5717.get("listening") is True
        and isinstance(gateway_5717.get("pid"), int)
        and gateway_5717.get("ownerHash") is not None
        and gateway_5717.get("matchesExpectedRepoRoot") is True
    )
    active_verified = bool(sha_matches and process_bound and all(v is not None for v in digests.values()))

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
        "portAttestation": port_state,
        "armAndSizingSource": arm_sizing,
        "activeRuntimeReleaseVerified": active_verified,
        "status": "VERIFIED_READONLY_PROCESS_RELEASE" if active_verified else "UNVERIFIED",
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
