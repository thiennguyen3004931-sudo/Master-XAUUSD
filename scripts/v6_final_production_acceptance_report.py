#!/usr/bin/env python3
"""V6 Final Production Acceptance Report Generator (Pre-LIVE Evidence Matrix — Issue #7/#91)."""

from __future__ import annotations

import hashlib
import json
from typing import Any, Mapping


SCHEMA_VERSION = 1
ALLOWED_VERDICTS = {"PASS", "FAIL", "UNVERIFIED"}

REQUIRED_CRITERIA: tuple[tuple[str, str], ...] = (
    ("emergency_stop_and_clear", "CODE"),
    ("cross_process_stop_send_race", "CODE"),
    ("broker_ack_and_duplicate_guard", "CODE"),
    ("ci_exact_head_and_branch_protection", "CODE"),
    ("release_manifest_and_rollback", "CODE"),
    ("windows_running_v6_process_attestation", "HOST"),
    ("windows_service_acl_dpapi_identity", "HOST"),
    ("api_auth_and_token_hardening", "HOST"),
    ("mt5_readonly_account_and_contract", "BROKER"),
    ("autolot_and_daily_loss_hard_stop", "RISK"),
    ("entry_sl_tp_be_trailing_verified", "RISK"),
    ("backtest_antilookahead_and_stopout", "RISK"),
)


def _sha256_canonical(payload: Mapping[str, Any]) -> str:
    body = {k: v for k, v in payload.items() if k != "reportSha256"}
    encoded = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def build_final_production_acceptance_report(
    *,
    release_commit_sha: str,
    evidence_map: Mapping[str, Mapping[str, Any]],
    owner_explicit_live_approval: bool = False,
) -> dict[str, Any]:
    """Build tamper-evident Final Production Acceptance report with PASS/FAIL/UNVERIFIED rows."""
    rows: list[dict[str, Any]] = []
    domain_passed = {"CODE": True, "HOST": True, "BROKER": True, "RISK": True}

    for criterion_id, domain in REQUIRED_CRITERIA:
        entry = evidence_map.get(criterion_id)
        if not isinstance(entry, Mapping):
            verdict = "UNVERIFIED"
            evidence_ref = "MISSING_EVIDENCE"
        else:
            raw_v = str(entry.get("verdict") or "").strip().upper()
            verdict = raw_v if raw_v in ALLOWED_VERDICTS else "UNVERIFIED"
            evidence_ref = str(entry.get("evidenceRef") or "").strip() or "NO_REFERENCE"
            if verdict == "PASS" and evidence_ref == "NO_REFERENCE":
                verdict = "UNVERIFIED"

        if verdict != "PASS":
            domain_passed[domain] = False

        rows.append(
            {
                "criterion": criterion_id,
                "domain": domain,
                "verdict": verdict,
                "evidenceRef": evidence_ref,
            }
        )

    code_ready = domain_passed["CODE"]
    host_verified = domain_passed["HOST"]
    broker_verified = domain_passed["BROKER"]
    risk_verified = domain_passed["RISK"]
    all_prelive_pass = code_ready and host_verified and broker_verified and risk_verified
    live_authorized = bool(all_prelive_pass and owner_explicit_live_approval is True)

    if live_authorized:
        classification = "LIVE_AUTHORIZED_BY_OWNER"
    elif all_prelive_pass:
        classification = "READY_FOR_OWNER_LIVE_APPROVAL"
    else:
        classification = "LIVE_BLOCKED"

    blocking = [r["criterion"] for r in rows if r["verdict"] != "PASS"]
    report: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "releaseCommitSha": str(release_commit_sha or "").strip().lower(),
        "CODE_READY": code_ready,
        "HOST_VERIFIED": host_verified,
        "BROKER_VERIFIED": broker_verified,
        "RISK_VERIFIED": risk_verified,
        "LIVE_AUTHORIZED": live_authorized,
        "classification": classification,
        "passCount": sum(1 for r in rows if r["verdict"] == "PASS"),
        "failCount": sum(1 for r in rows if r["verdict"] == "FAIL"),
        "unverifiedCount": sum(1 for r in rows if r["verdict"] == "UNVERIFIED"),
        "blockingCriteria": blocking,
        "criteria": rows,
    }
    report["reportSha256"] = _sha256_canonical(report)
    return report
