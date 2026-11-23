"""G4 P0 read-only V6 node/python process entrypoint & port-override inspector (#7).

Strictly READ-ONLY / NO-ORDER / NO-SECRETS:
- NEVER imports MetaTrader5, NEVER calls `order_send`, NEVER mutates ARM/BOT_MODE/config.
- NEVER emits raw local paths, usernames, SIDs, or environment secrets (redacts via SHA-256).
- Supports custom `API_PORT` / `WEB_PORT` overrides (defaults 3711 / 5717); port 8765 is
  explicitly optional and NEVER required.
- Identifies candidate `node` / `python` V6 script entrypoints (`xauusd-standalone-server.mjs`,
  `mt5-direct-probe.py`) and correlates PID/ownerHash with effective API/Web port listeners.
- Always keeps `activeRuntimeReleaseVerified=False`, `liveAuthorized=False`, and
  `status="UNVERIFIED"` because read-only host observation is not cryptographic live approval.
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

DEFAULT_API_PORT = 3711
DEFAULT_WEB_PORT = 5717
V6_SCRIPT_ENTRYPOINTS = (
    "xauusd-standalone-server.mjs",
    "mt5-direct-probe.py",
)
INSPECTOR_SCOPE = "READONLY_NODE_PYTHON_ENTRYPOINT_AND_PORT_OVERRIDE_NO_ORDER"


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _is_valid_port(val: Any) -> bool:
    return type(val) is int and 1 <= val <= 65535


def _is_valid_sha256(val: Any) -> bool:
    if not isinstance(val, str) or len(val) != 64:
        return False
    try:
        int(val, 16)
        return True
    except ValueError:
        return False


def resolve_effective_v6_ports(
    *,
    api_port_override: int | None = None,
    web_port_override: int | None = None,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Resolve effective API/Web ports from explicit overrides or API_PORT/WEB_PORT env."""
    env_map = os.environ if env is None else env

    def _parse_port(override: int | None, env_key: str, default_val: int) -> tuple[int | None, str]:
        if override is not None:
            return (override, "CLI_OVERRIDE") if _is_valid_port(override) else (None, "INVALID_CLI_OVERRIDE")
        raw = str(env_map.get(env_key, "")).strip()
        if not raw:
            return default_val, "DEFAULT"
        try:
            parsed = int(raw)
        except ValueError:
            return None, f"INVALID_ENV_{env_key}"
        return (parsed, f"ENV_{env_key}") if _is_valid_port(parsed) else (None, f"OUT_OF_RANGE_{env_key}")

    api_p, api_src = _parse_port(api_port_override, "API_PORT", DEFAULT_API_PORT)
    web_p, web_src = _parse_port(web_port_override, "WEB_PORT", DEFAULT_WEB_PORT)
    return {
        "apiPort": api_p,
        "apiPortSource": api_src,
        "webPort": web_p,
        "webPortSource": web_src,
        "port8765Required": False,
        "valid": api_p is not None and web_p is not None,
    }


def _detect_script_entrypoint(command_line: str) -> str | None:
    lower = (command_line or "").casefold()
    for name in V6_SCRIPT_ENTRYPOINTS:
        if name.casefold() in lower:
            return name
    return None


def _run_powershell_json(ps_script: str, timeout: int = 10) -> Any | None:
    try:
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps_script],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        if proc.returncode != 0 or not (proc.stdout or "").strip():
            return None
        return json.loads(proc.stdout.strip())
    except Exception:
        return None


def inspect_v6_node_python_processes(
    *,
    process_lister: Callable[[], list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    """Inspect running node/python processes matching V6 entrypoints (fully redacted)."""
    if process_lister is not None:
        try:
            raw_procs = process_lister()
        except Exception:
            return {"status": "UNVERIFIED", "reason": "PROCESS_LISTER_EXCEPTION", "matches": []}
        if not isinstance(raw_procs, list):
            return {"status": "UNVERIFIED", "reason": "PROCESS_LISTER_INVALID_SHAPE", "matches": []}
    elif os.name != "nt":
        return {"status": "UNVERIFIED", "reason": "NON_WINDOWS_HOST_PROCESS_LIST_UNVERIFIED", "matches": []}
    else:
        ps = (
            "$procs = @(Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='python.exe' OR Name='pythonw.exe'\" -ErrorAction SilentlyContinue); "
            "$arr = @(); "
            "foreach ($p in $procs) { "
            "  $owner = ''; try { $o = Invoke-CimMethod -InputObject $p -MethodName GetOwner -ErrorAction SilentlyContinue; if ($o.User) { $owner = \"$($o.Domain)\\$($o.User)\" } } catch {}; "
            "  $exe = [string]$p.ExecutablePath; "
            "  $exeHash = ''; if ($exe -and (Test-Path $exe)) { try { $exeHash = (Get-FileHash -Algorithm SHA256 -Path $exe).Hash.ToLowerInvariant() } catch {} }; "
            "  $arr += @{ pid = [int]$p.ProcessId; name = [string]$p.Name; owner = $owner; commandLine = [string]$p.CommandLine; executablePath = $exe; executableSha256 = $exeHash } "
            "}; "
            "$arr | ConvertTo-Json -Depth 4 -Compress"
        )
        parsed = _run_powershell_json(ps)
        if parsed is None:
            return {"status": "UNVERIFIED", "reason": "WINDOWS_PROCESS_QUERY_UNAVAILABLE", "matches": []}
        raw_procs = parsed if isinstance(parsed, list) else ([parsed] if isinstance(parsed, dict) else [])

    matches: list[dict[str, Any]] = []
    for item in raw_procs:
        if not isinstance(item, dict):
            continue
        pid = item.get("pid")
        if type(pid) is not int or pid <= 0:
            continue
        cmd = str(item.get("commandLine") or "")
        entry = _detect_script_entrypoint(cmd)
        if entry is None:
            continue
        owner_raw = str(item.get("owner") or "").strip()
        exe_raw = str(item.get("executablePath") or "").strip()
        exe_sha = item.get("executableSha256")
        matches.append({
            "pid": pid,
            "runtimeName": str(item.get("name") or "").strip().lower() or "unknown",
            "scriptEntrypoint": entry,
            "ownerHash": _sha256_text(owner_raw) if owner_raw else None,
            "cmdHash": _sha256_text(cmd.strip()) if cmd.strip() else None,
            "executablePathHash": _sha256_text(exe_raw) if exe_raw else None,
            "executableSha256": exe_sha if _is_valid_sha256(exe_sha) else None,
        })

    return {
        "status": "OBSERVED",
        "reason": "V6_PROCESS_ENTRYPOINTS_OBSERVED",
        "matches": matches,
    }


def collect_v6_entrypoint_and_port_override_report(
    *,
    api_port_override: int | None = None,
    web_port_override: int | None = None,
    env: dict[str, str] | None = None,
    process_lister: Callable[[], list[dict[str, Any]]] | None = None,
    port_pid_map: dict[int, list[int]] | None = None,
    now_utc: int | None = None,
) -> dict[str, Any]:
    """Correlate redacted node/python V6 entrypoints with effective API/Web ports."""
    ts = int(time.time() if now_utc is None else now_utc)
    ports = resolve_effective_v6_ports(
        api_port_override=api_port_override,
        web_port_override=web_port_override,
        env=env,
    )
    proc_obs = inspect_v6_node_python_processes(process_lister=process_lister)

    node_entries = [m for m in proc_obs["matches"] if m["scriptEntrypoint"] == "xauusd-standalone-server.mjs"]
    py_entries = [m for m in proc_obs["matches"] if m["scriptEntrypoint"] == "mt5-direct-probe.py"]

    api_pids = list(port_pid_map.get(ports["apiPort"], [])) if (isinstance(port_pid_map, dict) and ports["valid"]) else []
    web_pids = list(port_pid_map.get(ports["webPort"], [])) if (isinstance(port_pid_map, dict) and ports["valid"]) else []

    standalone_pid_correlates_ports = bool(
        ports["valid"]
        and len(node_entries) == 1
        and len(api_pids) == 1
        and len(web_pids) == 1
        and node_entries[0]["pid"] == api_pids[0] == web_pids[0]
        and node_entries[0].get("ownerHash") is not None
        and node_entries[0].get("executableSha256") is not None
    )

    if not ports["valid"]:
        reason = "INVALID_API_OR_WEB_PORT_OVERRIDE"
    elif proc_obs["status"] != "OBSERVED":
        reason = proc_obs["reason"]
    elif len(node_entries) == 0:
        reason = "V6_STANDALONE_NODE_PROCESS_NOT_OBSERVED"
    elif len(node_entries) > 1:
        reason = "MULTIPLE_V6_STANDALONE_NODE_PROCESSES_AMBIGUOUS"
    elif not standalone_pid_correlates_ports:
        reason = "V6_NODE_ENTRYPOINT_PORT_CORRELATION_UNVERIFIED"
    else:
        reason = "READONLY_ENTRYPOINT_AND_PORT_CORRELATED_REQUIRES_HOST_ATTESTATION"

    body = {
        "schemaVersion": 1,
        "scope": INSPECTOR_SCOPE,
        "generatedAtUtc": ts,
        "platform": platform.system(),
        "effectivePorts": ports,
        "processObservation": proc_obs,
        "nodeStandaloneCount": len(node_entries),
        "pythonProbeCount": len(py_entries),
        "standalonePidCorrelatesEffectivePorts": standalone_pid_correlates_ports,
        "activeRuntimeReleaseVerified": False,
        "status": "UNVERIFIED",
        "reason": reason,
        "liveAuthorized": False,
        "secretsExposed": False,
    }
    canonical = json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    body["reportSha256"] = _sha256_text(canonical)
    return body


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only V6 node/python entrypoint & port-override inspector")
    parser.add_argument("--api-port", type=int, default=None)
    parser.add_argument("--web-port", type=int, default=None)
    args = parser.parse_args()
    report = collect_v6_entrypoint_and_port_override_report(
        api_port_override=args.api_port,
        web_port_override=args.web_port,
    )
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
