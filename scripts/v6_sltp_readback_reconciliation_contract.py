#!/usr/bin/env python3
"""OFFLINE comparison of caller-supplied SLTP state; not broker evidence.

A matching dict, timestamp or closing_deal_observed bool does not authenticate
MT5, bind the service process, reconcile an ACK, or permit retry/new orders.
"""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any, Mapping


SCHEMA_VERSION = 1
SCOPE = "OFFLINE_CALLER_SLTP_FIELDS_COMPARISON_UNVERIFIED_NO_ORDER"
EPS = 1e-4


def _is_pos(val: Any) -> bool:
    return not isinstance(val, bool) and isinstance(val, (int, float)) and math.isfinite(float(val)) and float(val) > 0.0


def _sha256_canonical(payload: Mapping[str, Any]) -> str:
    body = {k: v for k, v in payload.items() if k != "reportSha256"}
    encoded = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def reconcile_sltp_broker_readback(
    *,
    expected_state: Mapping[str, Any],
    broker_readback: Mapping[str, Any],
    now_utc: int,
    max_snapshot_age_seconds: int = 10,
    closing_deal_observed: bool = False,
) -> dict[str, Any]:
    """Compare inert caller-supplied fields, always fail closed for broker authority."""
    ticket = expected_state.get("ticket")
    bot_magic = expected_state.get("magic")
    expected_login = expected_state.get("accountLogin")
    expected_server = expected_state.get("server")
    symbol = str(expected_state.get("symbol") or "").strip().upper()
    direction = str(expected_state.get("direction") or "").strip().upper()
    prev_sl = expected_state.get("previousSl")
    target_sl = expected_state.get("expectedTargetSl")
    expected_tp = expected_state.get("expectedTp")
    prev_vol = expected_state.get("previousVolume")

    def _out(
        *,
        status: str,
        reason: str,
        reconciled: bool,
        retry_required: bool,
        escalation_required: bool,
        block_new_orders: bool,
        observed_sl: Any = None,
        observed_tp: Any = None,
        observed_vol: Any = None,
    ) -> dict[str, Any]:
        rep: dict[str, Any] = {
            "schemaVersion": SCHEMA_VERSION,
            "scope": SCOPE,
            "ticket": ticket,
            "symbol": symbol,
            "direction": direction,
            "status": status,
            "reason": reason,
            "candidateFieldsMatch": reconciled,
            "reconciled": False,
            "retryRequired": False,
            "reconciliationRequired": True,
            "brokerReadbackProvenanceVerified": False,
            "closingDealProvenanceVerified": False,
            "brokerAcknowledgementVerified": False,
            "escalationRequired": escalation_required,
            "blockNewOrders": True,
            "observedSl": observed_sl,
            "observedTp": observed_tp,
            "observedVolume": observed_vol,
            "positionAutoClosed": False,
            "newOrderSubmitted": False,
            "liveAuthorized": False,
        }
        rep["reportSha256"] = _sha256_canonical(rep)
        return rep

    if (
        type(ticket) is not int
        or ticket <= 0
        or type(bot_magic) is not int
        or type(expected_login) is not int
        or expected_login <= 0
        or not isinstance(expected_server, str)
        or not expected_server.strip()
        or not symbol
        or direction not in {"BUY", "SELL"}
        or not _is_pos(prev_sl)
        or not _is_pos(target_sl)
        or not _is_pos(expected_tp)
        or not _is_pos(prev_vol)
    ):
        return _out(
            status="INVALID_EXPECTED_STATE_FAIL_CLOSED",
            reason="EXPECTED_SLTP_STATE_INCOMPLETE",
            reconciled=False,
            retry_required=False,
            escalation_required=True,
            block_new_orders=True,
        )

    snap_ts = broker_readback.get("snapshotTimestampUtc")
    if (
        type(snap_ts) is not int
        or type(now_utc) is not int
        or type(max_snapshot_age_seconds) is not int
        or max_snapshot_age_seconds <= 0
        or (now_utc - snap_ts) < 0
        or (now_utc - snap_ts) > max_snapshot_age_seconds
    ):
        return _out(
            status="SNAPSHOT_STALE_OR_UNVERIFIED_FAIL_CLOSED",
            reason="BROKER_READBACK_SNAPSHOT_STALE",
            reconciled=False,
            retry_required=True,
            escalation_required=False,
            block_new_orders=True,
        )

    pos_exists = broker_readback.get("positionExists")
    if pos_exists is False:
        if closing_deal_observed is True:
            return _out(
                status="CALLER_CLOSING_DEAL_CLAIM_UNVERIFIED",
                reason="CLOSING_DEAL_BOOLEAN_NOT_TRUSTED_BROKER_HISTORY",
                reconciled=False,
                retry_required=False,
                escalation_required=True,
                block_new_orders=True,
                observed_vol=0.0,
            )
        return _out(
            status="MISSING_POSITION_WITHOUT_CLOSING_DEAL",
            reason="POSITION_ABSENT_NO_CLOSING_DEAL_EVIDENCE",
            reconciled=False,
            retry_required=True,
            escalation_required=True,
            block_new_orders=True,
            observed_vol=0.0,
        )

    if pos_exists is not True:
        return _out(
            status="SNAPSHOT_STALE_OR_UNVERIFIED_FAIL_CLOSED",
            reason="POSITION_EXISTENCE_UNVERIFIED",
            reconciled=False,
            retry_required=True,
            escalation_required=False,
            block_new_orders=True,
        )

    if (
        type(broker_readback.get("ticket")) is not int
        or type(broker_readback.get("magic")) is not int
        or broker_readback.get("ticket") != ticket
        or broker_readback.get("magic") != bot_magic
        or broker_readback.get("accountLogin") != expected_login
        or broker_readback.get("server") != expected_server
        or str(broker_readback.get("symbol") or "").strip().upper() != symbol
        or str(broker_readback.get("direction") or "").strip().upper() != direction
    ):
        return _out(
            status="IDENTITY_MISMATCH_FAIL_CLOSED",
            reason="BROKER_READBACK_IDENTITY_MISMATCH",
            reconciled=False,
            retry_required=False,
            escalation_required=True,
            block_new_orders=True,
        )

    obs_sl = broker_readback.get("sl")
    obs_tp = broker_readback.get("tp")
    obs_vol = broker_readback.get("volume")

    if not _is_pos(obs_sl) or not _is_pos(obs_tp) or not _is_pos(obs_vol):
        return _out(
            status="UNSAFE_SL_WIDENED_OR_TP_WIPED_ESCALATE",
            reason="BROKER_READBACK_MISSING_SL_TP_OR_VOLUME",
            reconciled=False,
            retry_required=True,
            escalation_required=True,
            block_new_orders=True,
            observed_sl=obs_sl,
            observed_tp=obs_tp,
            observed_vol=obs_vol,
        )

    obs_sl_f = float(obs_sl)
    obs_tp_f = float(obs_tp)
    obs_vol_f = float(obs_vol)
    prev_sl_f = float(prev_sl)
    target_sl_f = float(target_sl)
    expected_tp_f = float(expected_tp)
    prev_vol_f = float(prev_vol)

    sl_widened = (direction == "BUY" and obs_sl_f < prev_sl_f - EPS) or (
        direction == "SELL" and obs_sl_f > prev_sl_f + EPS
    )
    tp_drifted = abs(obs_tp_f - expected_tp_f) > EPS
    if sl_widened or tp_drifted:
        return _out(
            status="UNSAFE_SL_WIDENED_OR_TP_WIPED_ESCALATE",
            reason="SL_WIDENED_OR_TP_DRIFTED_AT_BROKER",
            reconciled=False,
            retry_required=True,
            escalation_required=True,
            block_new_orders=True,
            observed_sl=round(obs_sl_f, 4),
            observed_tp=round(obs_tp_f, 4),
            observed_vol=round(obs_vol_f, 8),
        )

    if obs_vol_f > prev_vol_f + 1e-9:
        return _out(
            status="POSITION_VOLUME_INCREASED_UNVERIFIED_ESCALATE",
            reason="VOLUME_RISE_REQUIRES_FRESH_BROKER_INVENTORY",
            reconciled=False,
            retry_required=False,
            escalation_required=True,
            block_new_orders=True,
            observed_sl=round(obs_sl_f, 4),
            observed_tp=round(obs_tp_f, 4),
            observed_vol=round(obs_vol_f, 8),
        )

    target_confirmed = abs(obs_sl_f - target_sl_f) <= EPS
    partial_reduced = obs_vol_f < prev_vol_f - 1e-9

    if target_confirmed and partial_reduced:
        return _out(
            status="CALLER_PARTIAL_VOLUME_TARGET_MATCH_UNVERIFIED",
            reason="UNVERIFIED_CALLER_SNAPSHOT_PARTIAL_VOLUME",
            reconciled=True,
            retry_required=False,
            escalation_required=False,
            block_new_orders=False,
            observed_sl=round(obs_sl_f, 4),
            observed_tp=round(obs_tp_f, 4),
            observed_vol=round(obs_vol_f, 8),
        )

    if target_confirmed:
        return _out(
            status="CALLER_TARGET_FIELDS_MATCH_UNVERIFIED",
            reason="TARGET_MATCH_IN_CALLER_SNAPSHOT_NOT_BROKER_EVIDENCE",
            reconciled=True,
            retry_required=False,
            escalation_required=False,
            block_new_orders=False,
            observed_sl=round(obs_sl_f, 4),
            observed_tp=round(obs_tp_f, 4),
            observed_vol=round(obs_vol_f, 8),
        )

    return _out(
        status="SL_DRIFT_UNVERIFIED_RECONCILE_BEFORE_RETRY",
        reason="NO_TRUSTED_ACK_OR_FRESH_BROKER_READBACK_FOR_RETRY",
        reconciled=False,
        retry_required=True,
        escalation_required=False,
        block_new_orders=False,
        observed_sl=round(obs_sl_f, 4),
        observed_tp=round(obs_tp_f, 4),
        observed_vol=round(obs_vol_f, 8),
    )
