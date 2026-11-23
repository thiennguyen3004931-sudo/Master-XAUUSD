#!/usr/bin/env python3
"""V6 Protective SL/TP Broker-Boundary Adapter (Stream D — Issue #7)."""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any, Callable, Mapping


SCHEMA_VERSION = 1
TRADE_ACTION_SLTP = "TRADE_ACTION_SLTP"
MT5_RETCODE_DONE = 10009
EPS = 1e-9


def _is_pos(val: Any) -> bool:
    return not isinstance(val, bool) and isinstance(val, (int, float)) and math.isfinite(float(val)) and float(val) > 0.0


def _is_nonneg(val: Any) -> bool:
    return not isinstance(val, bool) and isinstance(val, (int, float)) and math.isfinite(float(val)) and float(val) >= 0.0


def _sha256_canonical(payload: Mapping[str, Any]) -> str:
    body = {k: v for k, v in payload.items() if k != "reportSha256"}
    encoded = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def execute_protective_sltp_update_mock_boundary(
    *,
    position: Mapping[str, Any],
    bot_magic: int,
    quote: Mapping[str, Any],
    now_utc: int,
    proposed_sl: float | None,
    broker_stops_level_usd: float,
    broker_freeze_level_usd: float,
    max_quote_age_seconds: int = 10,
    broker_sltp_sender: Callable[[Mapping[str, Any]], Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """Validate and apply a protective SLTP-only modification via an injected mock broker boundary."""
    pos_magic = position.get("magic")
    ticket = position.get("ticket")
    direction = str(position.get("direction") or "").strip().upper()
    current_sl = position.get("currentSl")
    current_tp = position.get("currentTp")
    entry_price = position.get("entryPrice")
    initial_sl = position.get("initialSl")
    initial_risk = position.get("initialRiskUsd")

    def _finalize(
        *,
        status: str,
        reason: str,
        modified: bool,
        preserved_sl: Any,
        preserved_tp: Any,
        retry_required: bool = False,
        broker_retcode: int | None = None,
    ) -> dict[str, Any]:
        rep: dict[str, Any] = {
            "schemaVersion": SCHEMA_VERSION,
            "actionType": TRADE_ACTION_SLTP,
            "ticket": ticket,
            "direction": direction,
            "status": status,
            "reason": reason,
            "modified": modified,
            "effectiveSl": preserved_sl,
            "effectiveTp": preserved_tp,
            "retryRequired": retry_required,
            "brokerRetcode": broker_retcode,
            "positionAutoClosed": False,
            "newOrderSubmitted": False,
            "liveAuthorized": False,
        }
        rep["reportSha256"] = _sha256_canonical(rep)
        return rep

    if type(pos_magic) is not int or pos_magic != bot_magic:
        return _finalize(
            status="NO_MODIFY",
            reason="POSITION_NOT_OWNED_BY_BOT",
            modified=False,
            preserved_sl=current_sl,
            preserved_tp=current_tp,
        )

    if (
        type(ticket) is not int
        or ticket <= 0
        or direction not in {"BUY", "SELL"}
        or not _is_pos(entry_price)
        or not _is_pos(current_sl)
        or (current_tp is not None and not _is_pos(current_tp))
    ):
        return _finalize(
            status="NO_MODIFY",
            reason="INVALID_POSITION_STATE",
            modified=False,
            preserved_sl=current_sl,
            preserved_tp=current_tp,
        )

    if _is_pos(initial_sl) and _is_pos(initial_risk):
        expected_r = (
            float(entry_price) - float(initial_sl)
            if direction == "BUY"
            else float(initial_sl) - float(entry_price)
        )
        if expected_r <= EPS or abs(expected_r - float(initial_risk)) > 1e-4:
            return _finalize(
                status="NO_MODIFY",
                reason="IMMUTABLE_INITIAL_RISK_MISMATCH",
                modified=False,
                preserved_sl=round(float(current_sl), 4),
                preserved_tp=round(float(current_tp), 4) if current_tp is not None else None,
            )

    bid = quote.get("bid")
    ask = quote.get("ask")
    quote_ts = quote.get("quoteTimestampUtc")
    if (
        not _is_pos(bid)
        or not _is_pos(ask)
        or float(ask) < float(bid)
        or type(quote_ts) is not int
        or type(now_utc) is not int
        or type(max_quote_age_seconds) is not int
        or max_quote_age_seconds <= 0
    ):
        return _finalize(
            status="NO_MODIFY",
            reason="INVALID_QUOTE_OR_TIMESTAMP",
            modified=False,
            preserved_sl=round(float(current_sl), 4),
            preserved_tp=round(float(current_tp), 4) if current_tp is not None else None,
        )

    if (now_utc - quote_ts) < 0 or (now_utc - quote_ts) > max_quote_age_seconds:
        return _finalize(
            status="NO_MODIFY",
            reason="QUOTE_STALE_NO_MODIFY",
            modified=False,
            preserved_sl=round(float(current_sl), 4),
            preserved_tp=round(float(current_tp), 4) if current_tp is not None else None,
        )

    if not _is_nonneg(broker_stops_level_usd) or not _is_nonneg(broker_freeze_level_usd):
        return _finalize(
            status="NO_MODIFY",
            reason="BROKER_LEVELS_UNVERIFIED",
            modified=False,
            preserved_sl=round(float(current_sl), 4),
            preserved_tp=round(float(current_tp), 4) if current_tp is not None else None,
        )

    if not _is_pos(proposed_sl):
        return _finalize(
            status="NO_MODIFY",
            reason="PROPOSED_SL_INVALID",
            modified=False,
            preserved_sl=round(float(current_sl), 4),
            preserved_tp=round(float(current_tp), 4) if current_tp is not None else None,
        )

    cur_sl_f = float(current_sl)
    prop_sl_f = float(proposed_sl)
    bid_f = float(bid)
    ask_f = float(ask)
    stops_lvl = float(broker_stops_level_usd)
    freeze_lvl = float(broker_freeze_level_usd)
    tp_out = round(float(current_tp), 4) if current_tp is not None else None

    if direction == "BUY" and prop_sl_f <= cur_sl_f + EPS:
        return _finalize(
            status="NO_MODIFY",
            reason="NON_MONOTONIC_SL_REJECTED",
            modified=False,
            preserved_sl=round(cur_sl_f, 4),
            preserved_tp=tp_out,
        )
    if direction == "SELL" and prop_sl_f >= cur_sl_f - EPS:
        return _finalize(
            status="NO_MODIFY",
            reason="NON_MONOTONIC_SL_REJECTED",
            modified=False,
            preserved_sl=round(cur_sl_f, 4),
            preserved_tp=tp_out,
        )

    market_ref = bid_f if direction == "BUY" else ask_f
    if abs(market_ref - cur_sl_f) <= freeze_lvl + EPS:
        return _finalize(
            status="NO_MODIFY",
            reason="CURRENT_SL_IN_FREEZE_LEVEL",
            modified=False,
            preserved_sl=round(cur_sl_f, 4),
            preserved_tp=tp_out,
        )

    target_dist = (bid_f - prop_sl_f) if direction == "BUY" else (prop_sl_f - ask_f)
    if target_dist < stops_lvl - EPS or target_dist <= freeze_lvl + EPS:
        return _finalize(
            status="NO_MODIFY",
            reason="TARGET_SL_VIOLATES_STOPS_OR_FREEZE_LEVEL",
            modified=False,
            preserved_sl=round(cur_sl_f, 4),
            preserved_tp=tp_out,
        )

    if broker_sltp_sender is None:
        return _finalize(
            status="PROPOSAL_READY_NO_SENDER",
            reason="OFFLINE_SLTP_PROPOSAL_VALIDATED",
            modified=False,
            preserved_sl=round(cur_sl_f, 4),
            preserved_tp=tp_out,
        )

    req_payload = {
        "action": TRADE_ACTION_SLTP,
        "ticket": ticket,
        "magic": bot_magic,
        "sl": round(prop_sl_f, 4),
        "tp": tp_out,
    }
    try:
        broker_res = broker_sltp_sender(req_payload)
    except Exception:
        return _finalize(
            status="BROKER_MODIFY_EXCEPTION_SL_PRESERVED",
            reason="BROKER_SENDER_EXCEPTION",
            modified=False,
            preserved_sl=round(cur_sl_f, 4),
            preserved_tp=tp_out,
            retry_required=True,
        )

    retcode = broker_res.get("retcode") if isinstance(broker_res, Mapping) else None
    retcode_int = retcode if type(retcode) is int else None
    if retcode_int == MT5_RETCODE_DONE:
        return _finalize(
            status="MODIFIED_ON_MOCK_BROKER",
            reason="SLTP_MODIFIED_MONOTONICALLY",
            modified=True,
            preserved_sl=round(prop_sl_f, 4),
            preserved_tp=tp_out,
            retry_required=False,
            broker_retcode=retcode_int,
        )

    return _finalize(
        status="BROKER_REJECTED_SL_PRESERVED",
        reason="BROKER_SLTP_MODIFY_REJECTED",
        modified=False,
        preserved_sl=round(cur_sl_f, 4),
        preserved_tp=tp_out,
        retry_required=True,
        broker_retcode=retcode_int,
    )
