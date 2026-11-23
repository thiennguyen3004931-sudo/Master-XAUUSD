#!/usr/bin/env python3
"""OFFLINE V6 API auth, safe-startup and readiness policy contracts (Streams B/F).

These functions are not wired into the production API or verified V6 process.
Caller-provided booleans and an owner-approval flag cannot attest host/broker
evidence or authorize LIVE. All emitted production gates remain blocked.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any, Mapping, Sequence


SCHEMA_VERSION = 1
MIN_TOKEN_LEN = 24


def _report_sha256(payload: Mapping[str, Any]) -> str:
    body = {k: v for k, v in payload.items() if k != "reportSha256"}
    encoded = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def evaluate_api_request_auth(
    *,
    provided_token: str | None,
    expected_token_sha256: str,
    origin: str | None,
    allowed_origins: Sequence[str],
    allow_localhost_bypass_flag: bool = False,
    allow_lan_bypass_flag: bool = False,
) -> dict[str, Any]:
    """Fail-closed API control authentication check (B3). Never echoes raw tokens."""
    if allow_localhost_bypass_flag or allow_lan_bypass_flag:
        return {
            "authorized": False,
            "reason": "INSECURE_LOCALHOST_OR_LAN_BYPASS_FORBIDDEN",
            "liveAuthorized": False,
        }

    if "*" in [str(o).strip() for o in allowed_origins]:
        return {
            "authorized": False,
            "reason": "WILDCARD_CORS_ORIGIN_FORBIDDEN",
            "liveAuthorized": False,
        }

    norm_origin = str(origin or "").strip()
    if norm_origin and norm_origin not in {str(o).strip() for o in allowed_origins}:
        return {
            "authorized": False,
            "reason": "CORS_ORIGIN_NOT_ALLOWLISTED",
            "liveAuthorized": False,
        }

    expected = str(expected_token_sha256 or "").strip().lower()
    if len(expected) != 64:
        return {
            "authorized": False,
            "reason": "EXPECTED_TOKEN_DIGEST_UNCONFIGURED",
            "liveAuthorized": False,
        }

    raw_tok = str(provided_token or "")
    if len(raw_tok) < MIN_TOKEN_LEN:
        return {
            "authorized": False,
            "reason": "MISSING_OR_SHORT_CONTROL_TOKEN",
            "liveAuthorized": False,
        }

    actual_digest = hashlib.sha256(raw_tok.encode("utf-8")).hexdigest()
    if not hmac.compare_digest(actual_digest, expected):
        return {
            "authorized": False,
            "reason": "INVALID_CONTROL_TOKEN",
            "liveAuthorized": False,
        }

    return {
        "authorized": True,
        "reason": "CONTROL_TOKEN_AND_CORS_VERIFIED",
        "liveAuthorized": False,
    }


def build_safe_startup_state(
    persisted_state: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """Build fail-closed startup state (B4): always DISARMED, never restores LIVE/AUTO/DCA."""
    ignored_flags: list[str] = []
    if isinstance(persisted_state, Mapping):
        for flag in ("liveArmed", "autoEnabled", "dcaEnabled", "liveAuthorized"):
            if persisted_state.get(flag) is True:
                ignored_flags.append(flag)
        state_corrupt = False
    else:
        state_corrupt = True

    return {
        "schemaVersion": SCHEMA_VERSION,
        "botMode": "DISARMED",
        "liveArmed": False,
        "autoEnabled": False,
        "dcaEnabled": False,
        "liveAuthorized": False,
        "failClosedActive": True,
        "persistedStateMissingOrCorrupt": state_corrupt,
        "suppressedPersistedFlags": sorted(ignored_flags),
        "reason": "SAFE_STARTUP_DISARMED_FAIL_CLOSED",
        "runtimeStartupIntegrated": False,
    }


def evaluate_final_production_acceptance(
    *,
    ci_all_required_green: bool,
    branch_protection_enforced: bool,
    emergency_stop_and_clear_verified: bool,
    cross_process_stop_send_verified: bool,
    broker_ack_reconciliation_verified: bool,
    windows_runtime_process_verified: bool,
    windows_acl_dpapi_service_verified: bool,
    api_auth_hardened_verified: bool,
    mt5_readonly_contract_verified: bool,
    autolot_and_daily_loss_verified: bool,
    trading_sl_be_trailing_verified: bool,
    release_manifest_and_rollback_verified: bool,
    owner_explicit_live_approval: bool = False,
) -> dict[str, Any]:
    """Report untrusted checklist claims; never self-authorize LIVE in offline evaluator."""
    # This function receives untrusted booleans, not provenance-bound
    # attestations. A caller can set every flag to True, including the owner
    # approval claim, so NONE can independently certify actual LIVE readiness.
    claimed_code_ready = bool(
        ci_all_required_green
        and branch_protection_enforced
        and emergency_stop_and_clear_verified
        and cross_process_stop_send_verified
        and broker_ack_reconciliation_verified
        and release_manifest_and_rollback_verified
    )
    claimed_host_verified = bool(
        windows_runtime_process_verified
        and windows_acl_dpapi_service_verified
        and api_auth_hardened_verified
    )
    claimed_broker_verified = bool(mt5_readonly_contract_verified)
    claimed_risk_verified = bool(
        autolot_and_daily_loss_verified and trading_sl_be_trailing_verified
    )
    all_claims_true = bool(
        claimed_code_ready
        and claimed_host_verified
        and claimed_broker_verified
        and claimed_risk_verified
    )
    # Source-only advisory; it cannot promote a runtime authorization gate.
    code_ready = host_verified = broker_verified = risk_verified = False
    live_authorized = False
    classification = "LIVE_BLOCKED"

    checks = {
        "ci_all_required_green": bool(ci_all_required_green),
        "branch_protection_enforced": bool(branch_protection_enforced),
        "emergency_stop_and_clear_verified": bool(emergency_stop_and_clear_verified),
        "cross_process_stop_send_verified": bool(cross_process_stop_send_verified),
        "broker_ack_reconciliation_verified": bool(broker_ack_reconciliation_verified),
        "windows_runtime_process_verified": bool(windows_runtime_process_verified),
        "windows_acl_dpapi_service_verified": bool(windows_acl_dpapi_service_verified),
        "api_auth_hardened_verified": bool(api_auth_hardened_verified),
        "mt5_readonly_contract_verified": bool(mt5_readonly_contract_verified),
        "autolot_and_daily_loss_verified": bool(autolot_and_daily_loss_verified),
        "trading_sl_be_trailing_verified": bool(trading_sl_be_trailing_verified),
        "release_manifest_and_rollback_verified": bool(release_manifest_and_rollback_verified),
    }
    unverified_items = sorted([k for k, v in checks.items() if not v] + ["independent_provenance_bound_evidence"])


    report: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "CODE_READY": code_ready,
        "HOST_VERIFIED": host_verified,
        "BROKER_VERIFIED": broker_verified,
        "RISK_VERIFIED": risk_verified,
        "LIVE_AUTHORIZED": live_authorized,
        "classification": classification,
        "reason": "CALLER_BOOLEAN_CLAIMS_NOT_VERIFIED_HOST_BROKER_EVIDENCE",
        "runtimeIntegrationVerified": False,
        "claimedPreLiveChecklistComplete": all_claims_true,
        "claimedOwnerApproval": bool(owner_explicit_live_approval),
        "claimOnlyStages": {
            "CODE_READY": claimed_code_ready,
            "HOST_VERIFIED": claimed_host_verified,
            "BROKER_VERIFIED": claimed_broker_verified,
            "RISK_VERIFIED": claimed_risk_verified,
        },
        "unverifiedItems": unverified_items,
        "checks": checks,
    }
    report["reportSha256"] = _report_sha256(report)
    return report
