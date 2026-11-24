#!/usr/bin/env python3
"""V6 One-Shot Read-Only Pre-LIVE Evidence Bundle Collector (Issue #7 / #76 / #52 / #91)."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import platform
import time
from typing import Any, Mapping, Sequence


SCHEMA_VERSION = 1
SCOPE = "READONLY_PRELIVE_EVIDENCE_BUNDLE_NO_ORDER_NO_MUTATION"


def _sha256_canonical(payload: Mapping[str, Any], *, exclude: set[str] | None = None) -> str:
    skip = exclude or set()
    body = {k: v for k, v in payload.items() if k not in skip}
    encoded = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def assemble_prelive_evidence_bundle(
    *,
    release_commit_sha: str,
    platform_name: str,
    generated_at_utc: int,
    process_entrypoint_report: Mapping[str, Any] | None,
    effective_acl_dpapi_report: Mapping[str, Any] | None,
    mt5_readonly_ledger_report: Mapping[str, Any] | None,
    ci_required_all_green_sha: str | None = None,
) -> dict[str, Any]:
    """Assemble a fail-closed read-only Pre-LIVE evidence bundle from probe outputs."""
    norm_sha = str(release_commit_sha or "").strip().lower()
    is_windows = str(platform_name or "").strip().lower() == "windows"

    proc_verified = bool(
        is_windows
        and isinstance(process_entrypoint_report, Mapping)
        and process_entrypoint_report.get("activeRuntimeReleaseVerified") is True
        and process_entrypoint_report.get("liveAuthorized") is False
    )
    acl_dpapi_verified = bool(
        is_windows
        and isinstance(effective_acl_dpapi_report, Mapping)
        and effective_acl_dpapi_report.get("effectiveAclVerified") is True
        and effective_acl_dpapi_report.get("dpapiReady") is True
        and effective_acl_dpapi_report.get("liveAuthorized") is False
    )
    broker_verified = bool(
        is_windows
        and isinstance(mt5_readonly_ledger_report, Mapping)
        and mt5_readonly_ledger_report.get("brokerProvenanceVerified") is True
        and mt5_readonly_ledger_report.get("orderSendCalled") is False
        and mt5_readonly_ledger_report.get("liveAuthorized") is False
    )
    ci_verified = bool(
        ci_required_all_green_sha
        and norm_sha
        and str(ci_required_all_green_sha).strip().lower() == norm_sha
    )

    blocking: list[str] = []
    if not is_windows:
        blocking.append("WINDOWS_HOST_REQUIRED")
    if not ci_verified:
        blocking.append("CI_EXACT_HEAD_UNVERIFIED")
    if not proc_verified:
        blocking.append("RUNNING_V6_PROCESS_RELEASE_UNVERIFIED")
    if not acl_dpapi_verified:
        blocking.append("WINDOWS_EFFECTIVE_ACL_OR_DPAPI_UNVERIFIED")
    if not broker_verified:
        blocking.append("MT5_READONLY_BROKER_LEDGER_UNVERIFIED")

    summary_verdicts = {
        "ci_exact_head": "PASS" if ci_verified else "UNVERIFIED",
        "running_v6_process": "PASS" if proc_verified else "UNVERIFIED",
        "windows_acl_dpapi": "PASS" if acl_dpapi_verified else "UNVERIFIED",
        "mt5_readonly_broker_ledger": "PASS" if broker_verified else "UNVERIFIED",
    }

    evidence_hashes = {
        "processEntrypointSha256": (
            process_entrypoint_report.get("reportSha256")
            if isinstance(process_entrypoint_report, Mapping)
            else None
        ),
        "effectiveAclDpapiSha256": (
            effective_acl_dpapi_report.get("reportSha256")
            if isinstance(effective_acl_dpapi_report, Mapping)
            else None
        ),
        "mt5ReadonlyLedgerSha256": (
            mt5_readonly_ledger_report.get("reportSha256")
            if isinstance(mt5_readonly_ledger_report, Mapping)
            else None
        ),
    }

    ready_for_approval = len(blocking) == 0
    bundle: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "scope": SCOPE,
        "generatedAtUtc": int(generated_at_utc),
        "platform": str(platform_name or ""),
        "releaseCommitSha": norm_sha,
        "verdicts": summary_verdicts,
        "evidenceHashes": evidence_hashes,
        "blockingReasons": sorted(blocking),
        "classification": "READY_FOR_OWNER_LIVE_APPROVAL" if ready_for_approval else "LIVE_BLOCKED",
        "orderSendCalled": False,
        "liveAuthorized": False,
        "secretsExposed": False,
    }
    bundle["bundleSha256"] = _sha256_canonical(bundle, exclude={"bundleSha256"})
    return bundle


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Read-only Pre-LIVE evidence bundle collector for Master-XAUUSD V6."
    )
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--runtime-dir", type=Path, default=None)
    parser.add_argument("--release-commit-sha", type=str, default="")
    parser.add_argument("--symbol", type=str, default="XAUUSD.G")
    parser.add_argument("--allow-live-mt5-init", action="store_true", default=False)
    args = parser.parse_args(argv)

    proc_rep = acl_rep = mt5_rep = None
    try:
        from scripts import v6_windows_effective_acl_dpapi_probe as acl_probe  # type: ignore

        acl_rep = acl_probe.build_probe_report(args.repo_root, runtime_dir=args.runtime_dir)
    except Exception:
        acl_rep = None

    try:
        from scripts import v6_mt5_readonly_broker_ledger_probe as mt5_probe  # type: ignore

        mt5_rep = mt5_probe.collect_live_mt5_readonly_ledger(
            args.symbol, allow_live_mt5_init=bool(args.allow_live_mt5_init)
        )
    except Exception:
        mt5_rep = None

    bundle = assemble_prelive_evidence_bundle(
        release_commit_sha=args.release_commit_sha,
        platform_name=platform.system(),
        generated_at_utc=int(time.time()),
        process_entrypoint_report=proc_rep,
        effective_acl_dpapi_report=acl_rep,
        mt5_readonly_ledger_report=mt5_rep,
        ci_required_all_green_sha=None,
    )
    print(json.dumps(bundle, indent=2, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
