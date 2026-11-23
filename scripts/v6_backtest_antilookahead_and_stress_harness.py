#!/usr/bin/env python3
"""V6 Backtest Anti-Lookahead Verifier & Walk-Forward / Stress Harness (Stream E — Issue #52)."""

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
        uses_unclosed = bool(ev.get("usesUnclosedCandle", False))
        if type(decision_bar) is not int or type(max_read_bar) is not int or decision_bar < 0:
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
        if uses_unclosed:
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
        "reason": "NO_LOOKAHEAD_VERIFIED" if not violations else "LOOKAHEAD_VIOLATION_DETECTED",
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
    """Evaluate walk-forward & adverse stress scenarios with strict UNVERIFIED stop-out guard."""
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
        net_pnl = 0.0
        wins = 0
        total = 0
        for tr in trades:
            if not isinstance(tr, Mapping):
                continue
            pnl = tr.get("netPnlAfterCostsUsd")
            if isinstance(pnl, bool) or not isinstance(pnl, (int, float)) or not math.isfinite(float(pnl)):
                continue
            val = float(pnl)
            net_pnl += val
            total += 1
            if val > 0.0:
                wins += 1
        return {
            "tradeCount": total,
            "winRate": round((wins / total), 4) if total > 0 else 0.0,
            "netPnlAfterCostsUsd": round(net_pnl, 4),
        }

    required_scenarios = {
        "spread_widening",
        "volatility_spike",
        "low_liquidity_gap",
        "missing_data_feed",
    }
    missing_scenarios = sorted(required_scenarios - set(stress_scenarios.keys()))
    failed_scenarios = sorted(
        name
        for name, sc in stress_scenarios.items()
        if not isinstance(sc, Mapping) or sc.get("failClosedHandled") is not True
    )

    if missing_scenarios:
        status = "INCOMPLETE_STRESS_COVERAGE"
        reason = f"MISSING_STRESS_SCENARIOS:{','.join(missing_scenarios)}"
    elif failed_scenarios:
        status = "STRESS_FAILURE"
        reason = f"STRESS_SCENARIOS_FAILED:{','.join(failed_scenarios)}"
    elif not bool(broker_stopout_verified):
        status = "UNVERIFIED"
        reason = "BROKER_STOPOUT_RULES_UNVERIFIED"
    else:
        status = "OFFLINE_BACKTEST_AND_STRESS_VERIFIED"
        reason = "WALKFORWARD_AND_STRESS_PASSED_WITH_BROKER_STOPOUT_VERIFIED"

    report: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "status": status,
        "reason": reason,
        "brokerStopOutVerified": bool(broker_stopout_verified),
        "containsDemoOrSyntheticData": bool(contains_demo_or_synthetic_data),
        "inSampleSummary": _summarize(in_sample_trades),
        "outOfSampleSummary": _summarize(out_of_sample_trades),
        "missingStressScenarios": missing_scenarios,
        "failedStressScenarios": failed_scenarios,
        "liveAuthorized": False,
    }
    report["reportSha256"] = _report_sha256(report)
    return report
