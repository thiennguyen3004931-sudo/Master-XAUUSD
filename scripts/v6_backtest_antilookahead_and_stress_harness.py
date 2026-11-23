#!/usr/bin/env python3
"""Offline candidate-check harness (Issue #52), not broker/causality attestation.

    Inputs are caller-supplied event metadata, trade rows and scenario verdicts.
    This module cannot prove actual replay order, broker stop-out policy or
    walk-forward split provenance. It never certifies LIVE/backtest validity.
"""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any, Mapping, Sequence


SCHEMA_VERSION = 1


def _report_sha256(payload: Mapping[str, Any]) -> str:
    body = {k: v for k, v in payload.items() if k != "reportSha256"}
    encoded = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def verify_no_lookahead(
    signal_events: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """Verify every backtest signal only reads closed bars at or before its decision index."""
    violations: list[dict[str, Any]] = []
    for idx, ev in enumerate(signal_events):
        if not isinstance(ev, Mapping):
            violations.append({"eventIndex": idx, "reason": "EVENT_NOT_MAPPING"})
            continue
        decision_bar = ev.get("decisionBarIndex")
        max_read_bar = ev.get("maxReadBarIndex")
        uses_unclosed = ev.get("usesUnclosedCandle")
        if (
            type(decision_bar) is not int
            or type(max_read_bar) is not int
            or decision_bar < 0
            or max_read_bar < 0
            or type(uses_unclosed) is not bool
        ):
            violations.append({"eventIndex": idx, "reason": "INVALID_BAR_INDEX"})
            continue
        if max_read_bar > decision_bar:
            violations.append(
                {
                    "eventIndex": idx,
                    "reason": "FUTURE_BAR_LOOKAHEAD_DETECTED",
                    "decisionBarIndex": decision_bar,
                    "maxReadBarIndex": max_read_bar,
                }
            )
        if uses_unclosed is True:
            violations.append(
                {
                    "eventIndex": idx,
                    "reason": "UNCLOSED_CANDLE_LOOKAHEAD_DETECTED",
                    "decisionBarIndex": decision_bar,
                }
            )
    return {
        "passed": len(violations) == 0,
        "checkedCount": len(signal_events),
        "violations": violations,
        "reason": "CLAIMED_BAR_INDEX_CONTRACT_SCREENED" if not violations else "LOOKAHEAD_VIOLATION_DETECTED",
        "causalReplayProvenanceVerified": False,
    }


def evaluate_stress_and_walkforward_report(
    *,
    in_sample_trades: Sequence[Mapping[str, Any]],
    out_of_sample_trades: Sequence[Mapping[str, Any]],
    stress_scenarios: Mapping[str, Mapping[str, Any]],
    broker_stopout_verified: bool,
    contains_demo_or_synthetic_data: bool = True,
    target_live_stats_ledger: bool = False,
) -> dict[str, Any]:
    """Screen caller-provided stress claims without certifying broker fidelity.

    Neither a caller 'broker_stopout_verified' Boolean nor 'failClosedHandled'
    Boolean constitutes broker proof or an actual executed stress scenario.
    No real backtest or live statistics ledger is written here.
    """
    if target_live_stats_ledger and contains_demo_or_synthetic_data:
        report = {
            "schemaVersion": SCHEMA_VERSION,
            "status": "REJECTED",
            "reason": "DEMO_OR_SYNTHETIC_CONTAMINATION_FORBIDDEN_IN_LIVE_STATS",
            "brokerStopOutVerified": False,
            "liveAuthorized": False,
        }
        report["reportSha256"] = _report_sha256(report)
        return report

    def _summarize(trades: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
        # Invalid trade rows must not be silently discarded: doing so can
        # inflate the reported win rate or suppress losses.
        net_pnl = 0.0
        wins = 0
        total = 0
        invalid_indices: list[int] = []
        for i, tr in enumerate(trades):
            if not isinstance(tr, Mapping):
                invalid_indices.append(i)
                continue
            pnl = tr.get("netPnlAfterCostsUsd")
            if isinstance(pnl, bool) or not isinstance(pnl, (int, float)) or not math.isfinite(float(pnl)):
                invalid_indices.append(i)
                continue
            val = float(pnl)
            net_pnl += val
            total += 1
            if val > 0.0:
                wins += 1
        complete = len(invalid_indices) == 0
        return {
            "tradeCount": total,
            "inputCount": len(trades),
            "complete": complete,
            "invalidIndices": invalid_indices,
            "winRate": round((wins / total), 4) if complete and total > 0 else None,
            "netPnlAfterCostsUsd": round(net_pnl, 4) if complete else None,
        }

    required_scenarios = {
        "spread_widening",
        "volatility_spike",
        "low_liquidity_gap",
        "missing_data_feed",
    }
    in_summary = _summarize(in_sample_trades)
    out_summary = _summarize(out_of_sample_trades)
    missing_scenarios = sorted(required_scenarios - set(stress_scenarios.keys()))
    failed_scenarios = sorted(
        name
        for name, sc in stress_scenarios.items()
        if not isinstance(sc, Mapping) or sc.get("failClosedHandled") is not True
    )

    if not in_summary["complete"] or not out_summary["complete"]:
        status = "REJECTED"
        reason = "INVALID_TRADE_ROWS_MUST_NOT_BE_SILENTLY_SKIPPED"
    elif missing_scenarios:
        status = "INCOMPLETE_STRESS_COVERAGE"
        reason = f"MISSING_STRESS_SCENARIOS:{','.join(missing_scenarios)}"
    elif failed_scenarios:
        status = "STRESS_FAILURE"
        reason = f"STRESS_SCENARIOS_FAILED:{','.join(failed_scenarios)}"
    else:
        status = "UNVERIFIED"
        reason = "CALLER_CLAIMS_NOT_CAUSAL_BROKER_STOPOUT_EVIDENCE" if broker_stopout_verified is True else "BROKER_STOPOUT_RULES_UNVERIFIED"

    report: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "status": status,
        "reason": reason,
        "brokerStopOutVerified": False,
        "brokerStopOutClaimedByCaller": broker_stopout_verified is True,
        "causalReplayProvenanceVerified": False,
        "walkForwardSplitVerified": False,
        "stressScenariosExecutedAndVerified": False,
        "containsDemoOrSyntheticData": bool(contains_demo_or_synthetic_data),
        "inSampleSummary": in_summary,
        "outOfSampleSummary": out_summary,
        "missingStressScenarios": missing_scenarios,
        "failedStressScenarios": failed_scenarios,
        "liveAuthorized": False,
    }
    report["reportSha256"] = _report_sha256(report)
    return report
