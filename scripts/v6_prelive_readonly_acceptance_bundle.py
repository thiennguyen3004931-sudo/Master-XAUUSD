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


SCHEMA_VERSION = 2
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

    # This assembler consumes caller-supplied JSON, not authenticated receipts.
    # A content digest identifies the input; it does not establish who produced it.
    reports = {
        "processEntrypointSha256": process_entrypoint_report,
        "effectiveAclDpapiSha256": effective_acl_dpapi_report,
        "mt5ReadonlyLedgerSha256": mt5_readonly_ledger_report,
    }
    evidence_hashes = {
        key: _sha256_canonical(report, exclude={"reportSha256"})
        if isinstance(report, Mapping) else None
        for key, report in reports.items()
    }
    blocking = ["CI_EXACT_HEAD_UNVERIFIED", "RUNNING_V6_PROCESS_RELEASE_UNVERIFIED",
                "WINDOWS_EFFECTIVE_ACL_OR_DPAPI_UNVERIFIED", "MT5_READONLY_BROKER_LEDGER_UNVERIFIED"]
    if not is_windows:
        blocking.append("WINDOWS_HOST_REQUIRED")
    if len(norm_sha) != 40 or any(c not in "0123456789abcdef" for c in norm_sha):
        blocking.append("FULL_RELEASE_SHA_REQUIRED")
    summary_verdicts = dict.fromkeys(
        ("ci_exact_head", "running_v6_process", "windows_acl_dpapi", "mt5_readonly_broker_ledger"),
        "UNVERIFIED",
    )
    bundle: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "scope": SCOPE,
        "generatedAtUtc": int(generated_at_utc),
        "platform": str(platform_name or ""),
        "releaseCommitSha": norm_sha,
        "verdicts": summary_verdicts,
        "evidenceHashes": evidence_hashes,
        "blockingReasons": sorted(blocking),
        "classification": "LIVE_BLOCKED",
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
        from scripts import v6_runtime_process_attestation as process_probe  # type: ignore

        proc_rep = process_probe.collect_runtime_process_attestation(
            repo_root=args.repo_root,
            expected_release_sha=args.release_commit_sha,
        )
    except Exception:
        # A missing or failing read-only process probe remains explicit in the
        # bundle; never replace it with a caller-supplied PASS claim.
        proc_rep = None
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
