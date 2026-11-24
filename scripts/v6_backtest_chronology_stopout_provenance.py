#!/usr/bin/env python3
"""V6 Backtest Tick/Quote Chronology, Broker Stop-Out & OOS Split Provenance Verifier (Stream E — #52)."""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any, Mapping, Sequence


SCHEMA_VERSION = 1
SCOPE = "OFFLINE_BACKTEST_CHRONOLOGY_STOPOUT_AND_OOS_PROVENANCE_NO_ORDER"
VALID_MARGIN_MODES = {"HEDGING", "NETTING"}
HEX_CHARS = set("0123456789abcdef")


def _is_finite_pos(val: Any) -> bool:
    return not isinstance(val, bool) and isinstance(val, (int, float)) and math.isfinite(float(val)) and float(val) > 0.0


def _is_finite_nonneg(val: Any) -> bool:
    return not isinstance(val, bool) and isinstance(val, (int, float)) and math.isfinite(float(val)) and float(val) >= 0.0


def _is_sha256_hex(val: Any) -> bool:
    if not isinstance(val, str):
        return False
    s = val.strip().lower()
    return len(s) == 64 and all(ch in HEX_CHARS for ch in s)


def _sha256_canonical(payload: Mapping[str, Any]) -> str:
    body = {k: v for k, v in payload.items() if k != "reportSha256"}
    encoded = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def verify_tick_quote_chronology(
    quotes: Sequence[Mapping[str, Any]],
    *,
    max_gap_seconds: int = 3600,
) -> dict[str, Any]:
    """Verify monotonic tick/quote chronology, bid/ask validity, and gap boundaries."""
    if not isinstance(quotes, Sequence) or isinstance(quotes, (str, bytes)) or len(quotes) == 0:
        return {
            "passed": False,
            "checkedCount": 0,
            "gapCount": 0,
            "violations": [{"index": 0, "reason": "EMPTY_OR_INVALID_QUOTE_STREAM"}],
            "reason": "QUOTE_STREAM_EMPTY_FAIL_CLOSED",
        }

    violations: list[dict[str, Any]] = []
    gap_count = 0
    prev_ts: int | None = None

    for idx, q in enumerate(quotes):
        if not isinstance(q, Mapping):
            violations.append({"index": idx, "reason": "QUOTE_NOT_MAPPING"})
            continue
        ts = q.get("timestampUtc")
        bid = q.get("bid")
        ask = q.get("ask")
        if type(ts) is not int or ts <= 0:
            violations.append({"index": idx, "reason": "INVALID_TIMESTAMP"})
            continue
        if not _is_finite_pos(bid) or not _is_finite_pos(ask) or float(ask) < float(bid):
            violations.append({"index": idx, "reason": "INVALID_BID_ASK"})
            continue
        if prev_ts is not None:
            if ts < prev_ts:
                violations.append(
                    {
                        "index": idx,
                        "reason": "NON_MONOTONIC_TIMESTAMP",
                        "prevTimestampUtc": prev_ts,
                        "timestampUtc": ts,
                    }
                )
            elif (ts - prev_ts) > int(max_gap_seconds):
                gap_count += 1
        prev_ts = ts

    passed = len(violations) == 0
    return {
        "passed": passed,
        "checkedCount": len(quotes),
        "gapCount": gap_count,
        "violations": violations,
        "reason": "TICK_CHRONOLOGY_VERIFIED" if passed else "TICK_CHRONOLOGY_VIOLATION",
    }


def verify_oos_split_provenance(
    *,
    train_start_utc: int,
    train_end_utc: int,
    oos_start_utc: int,
    oos_end_utc: int,
    dataset_sha256: str,
    embargo_seconds: int = 0,
) -> dict[str, Any]:
    """Verify strict non-overlapping Out-Of-Sample split and SHA-256 dataset provenance."""
    reasons: list[str] = []
    if not all(type(x) is int and x > 0 for x in (train_start_utc, train_end_utc, oos_start_utc, oos_end_utc)):
        reasons.append("INVALID_SPLIT_TIMESTAMPS")
    elif train_start_utc >= train_end_utc or oos_start_utc >= oos_end_utc:
        reasons.append("INVALID_SPLIT_INTERVAL_ORDER")
    else:
        if type(embargo_seconds) is not int or embargo_seconds < 0:
            reasons.append("INVALID_EMBARGO_SECONDS")
        elif oos_start_utc < (train_end_utc + embargo_seconds):
            reasons.append("OOS_OVERLAPS_TRAIN_OR_VIOLATES_EMBARGO")

    if not _is_sha256_hex(dataset_sha256):
        reasons.append("DATASET_SHA256_MISSING_OR_INVALID")

    passed = len(reasons) == 0
    return {
        "passed": passed,
        "trainWindowUtc": [train_start_utc, train_end_utc],
        "oosWindowUtc": [oos_start_utc, oos_end_utc],
        "embargoSeconds": embargo_seconds,
        "datasetSha256": str(dataset_sha256 or "").strip().lower(),
        "reasons": reasons,
        "reason": "OOS_SPLIT_PROVENANCE_VERIFIED" if passed else ";".join(reasons),
    }


def evaluate_backtest_provenance_and_stopout(
    *,
    chronology_result: Mapping[str, Any],
    oos_result: Mapping[str, Any],
    broker_stopout_spec: Mapping[str, Any] | None,
    broker_spec_evidence_sha256: str | None = None,
) -> dict[str, Any]:
    """Combine chronology, OOS split, and broker margin stop-out provenance fail-closed."""
    chrono_ok = isinstance(chronology_result, Mapping) and chronology_result.get("passed") is True
    oos_ok = isinstance(oos_result, Mapping) and oos_result.get("passed") is True

    stopout_missing: list[str] = []
    if not isinstance(broker_stopout_spec, Mapping):
        stopout_missing.append("BROKER_STOPOUT_SPEC_MISSING")
    else:
        margin_mode = str(broker_stopout_spec.get("marginMode") or "").strip().upper()
        so_mode = broker_stopout_spec.get("marginSoMode")
        so_call = broker_stopout_spec.get("marginSoCall")
        so_so = broker_stopout_spec.get("marginSoSo")
        cs = broker_stopout_spec.get("contractSize")
        if margin_mode not in VALID_MARGIN_MODES:
            stopout_missing.append("MARGIN_MODE_INVALID")
        if type(so_mode) is not int or so_mode not in (0, 1):
            stopout_missing.append("MARGIN_SO_MODE_UNVERIFIED")
        if not _is_finite_pos(so_call) or not _is_finite_nonneg(so_so) or float(so_so) > float(so_call):
            stopout_missing.append("MARGIN_CALL_OR_STOPOUT_LEVEL_INVALID")
        if not _is_finite_pos(cs):
            stopout_missing.append("CONTRACT_SIZE_INVALID")

    if not _is_sha256_hex(broker_spec_evidence_sha256):
        stopout_missing.append("BROKER_SPEC_EVIDENCE_SHA256_UNVERIFIED")

    broker_stopout_verified = len(stopout_missing) == 0

    if not chrono_ok:
        status = "FAILED_CHRONOLOGY"
        reason = "TICK_QUOTE_CHRONOLOGY_FAILED"
    elif not oos_ok:
        status = "FAILED_OOS_PROVENANCE"
        reason = "OOS_SPLIT_PROVENANCE_FAILED"
    elif not broker_stopout_verified:
        status = "UNVERIFIED"
        reason = f"BROKER_STOPOUT_UNVERIFIED:{','.join(sorted(stopout_missing))}"
    else:
        status = "OFFLINE_BACKTEST_PROVENANCE_VERIFIED"
        reason = "CHRONOLOGY_OOS_AND_BROKER_STOPOUT_VERIFIED_OFFLINE"

    report: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "scope": SCOPE,
        "chronologyPassed": chrono_ok,
        "oosProvenancePassed": oos_ok,
        "brokerStopOutVerified": broker_stopout_verified,
        "missingStopOutEvidence": sorted(stopout_missing),
        "status": status,
        "reason": reason,
        "liveAuthorized": False,
    }
    report["reportSha256"] = _sha256_canonical(report)
    return report
