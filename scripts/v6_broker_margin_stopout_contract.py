"""G3 P1 read-only broker margin, hedge & stop-out contract attestation (#52).

Strictly READ-ONLY / SOURCE-ONLY:
- NEVER imports MetaTrader5, NEVER calls `order_send`, NEVER mutates runtime/ARM/BOT_MODE.
- Validates real broker account & symbol margin/stop-out contract metadata without
  trusting bare caller booleans.
- Fails closed on:
  * unauthenticated or mismatched account/server,
  * invalid/non-positive leverage, stop-out threshold, or tick/contract specs,
  * `None` (unavailable) positions or fills inventory,
  * opposing hedged positions when broker hedged-margin policy (`marginHedged`,
    `hedgedMarginMode`) is unattested (`HEDGED_MARGIN_POLICY_UNVERIFIED`),
  * missing independent out-of-sample tick+fill evidence (`brokerStopOutExecutionVerified`
    remains `False` unless independent broker stop-out fills match tick replay).
"""
from __future__ import annotations

import hashlib
import json
import math
from typing import Any

SUPPORTED_MARGIN_SO_MODES = frozenset({"PERCENT", "MONEY"})
SUPPORTED_ACCOUNT_MARGIN_MODES = frozenset({"RETAIL_NETTING", "EXCHANGE", "RETAIL_HEDGING"})


def _is_finite_pos(val: Any) -> bool:
    return isinstance(val, (int, float)) and not isinstance(val, bool) and math.isfinite(val) and val > 0.0


def _is_finite_nonneg(val: Any) -> bool:
    return isinstance(val, (int, float)) and not isinstance(val, bool) and math.isfinite(val) and val >= 0.0


def attest_broker_margin_contract(
    *,
    account_info: dict[str, Any] | None,
    symbol_info: dict[str, Any] | None,
    expected_account_login: int,
    expected_server: str,
    now_utc: int | float,
    max_snapshot_age_sec: int = 10,
) -> dict[str, Any]:
    """Validate real read-only broker margin/stop-out metadata from account & symbol dicts."""
    if not isinstance(account_info, dict) or not isinstance(symbol_info, dict):
        return {"attested": False, "reason": "MISSING_BROKER_METADATA_DICTS"}
    if not isinstance(max_snapshot_age_sec, int) or isinstance(max_snapshot_age_sec, bool) or max_snapshot_age_sec <= 0:
        return {"attested": False, "reason": "INVALID_MAX_SNAPSHOT_AGE"}

    login = account_info.get("login")
    server = str(account_info.get("server") or "").strip()
    if not isinstance(login, int) or isinstance(login, bool) or login <= 0 or login != int(expected_account_login):
        return {"attested": False, "reason": "ACCOUNT_BINDING_MISMATCH"}
    if not server or server != str(expected_server or "").strip():
        return {"attested": False, "reason": "SERVER_BINDING_MISMATCH"}

    snapshot_utc = account_info.get("snapshotEpochUtc")
    if not _is_finite_pos(snapshot_utc) or not _is_finite_pos(now_utc):
        return {"attested": False, "reason": "INVALID_SNAPSHOT_CLOCK"}
    age_sec = float(now_utc) - float(snapshot_utc)
    if age_sec < 0.0 or age_sec > float(max_snapshot_age_sec):
        return {"attested": False, "reason": "SNAPSHOT_STALE_OR_FUTURE_SKEW", "ageSec": age_sec}

    leverage = account_info.get("leverage")
    margin_so_mode = str(account_info.get("marginSoMode") or "").strip().upper()
    account_margin_mode = str(account_info.get("marginMode") or "").strip().upper()
    margin_so_call = account_info.get("marginSoCall")
    margin_so_stop_out = account_info.get("marginSoStopOut")
    currency = str(account_info.get("currency") or "").strip().upper()

    if not _is_finite_pos(leverage):
        return {"attested": False, "reason": "INVALID_ACCOUNT_LEVERAGE"}
    if not currency:
        return {"attested": False, "reason": "MISSING_ACCOUNT_CURRENCY"}
    if margin_so_mode not in SUPPORTED_MARGIN_SO_MODES:
        return {"attested": False, "reason": "UNSUPPORTED_MARGIN_SO_MODE"}
    if account_margin_mode not in SUPPORTED_ACCOUNT_MARGIN_MODES:
        return {"attested": False, "reason": "UNSUPPORTED_ACCOUNT_MARGIN_MODE"}
    if not (_is_finite_pos(margin_so_call) and _is_finite_pos(margin_so_stop_out)):
        return {"attested": False, "reason": "INVALID_STOP_OUT_THRESHOLDS"}
    if float(margin_so_stop_out) > float(margin_so_call):
        return {"attested": False, "reason": "STOP_OUT_EXCEEDS_MARGIN_CALL"}

    symbol = str(symbol_info.get("symbol") or "").strip()
    contract_size = symbol_info.get("tradeContractSize")
    tick_size = symbol_info.get("tradeTickSize")
    tick_value = symbol_info.get("tradeTickValue")
    margin_initial = symbol_info.get("marginInitial", 0.0)
    margin_hedged = symbol_info.get("marginHedged")
    margin_hedged_attested = isinstance(symbol_info.get("hedgedMarginPolicyAttested"), bool) and symbol_info.get("hedgedMarginPolicyAttested") is True

    if not symbol or not (_is_finite_pos(contract_size) and _is_finite_pos(tick_size) and _is_finite_pos(tick_value)):
        return {"attested": False, "reason": "INVALID_SYMBOL_CONTRACT_SPECS"}
    if not _is_finite_nonneg(margin_initial):
        return {"attested": False, "reason": "INVALID_SYMBOL_MARGIN_INITIAL"}

    canonical = json.dumps(
        {
            "login": login,
            "server": server,
            "currency": currency,
            "leverage": float(leverage),
            "marginMode": account_margin_mode,
            "marginSoMode": margin_so_mode,
            "marginSoCall": float(margin_so_call),
            "marginSoStopOut": float(margin_so_stop_out),
            "symbol": symbol,
            "tradeContractSize": float(contract_size),
            "tradeTickSize": float(tick_size),
            "tradeTickValue": float(tick_value),
            "marginHedged": margin_hedged if _is_finite_nonneg(margin_hedged) else None,
            "hedgedMarginPolicyAttested": margin_hedged_attested,
        },
        sort_keys=True,
        separators=(",", ":"),
    )

    return {
        "attested": True,
        "reason": "BROKER_MARGIN_CONTRACT_ATTESTED",
        "accountMarginMode": account_margin_mode,
        "marginSoMode": margin_so_mode,
        "marginSoCall": float(margin_so_call),
        "marginSoStopOut": float(margin_so_stop_out),
        "hedgedMarginPolicyVerified": bool(
            account_margin_mode == "RETAIL_HEDGING"
            and margin_hedged_attested
            and _is_finite_nonneg(margin_hedged)
        ),
        "contractSha256": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
    }


def evaluate_g3_stopout_evidence_contract(
    *,
    account_info: dict[str, Any] | None,
    symbol_info: dict[str, Any] | None,
    expected_account_login: int,
    expected_server: str,
    now_utc: int | float,
    positions: list[dict[str, Any]] | None,
    observed_stopout_fills: list[dict[str, Any]] | None,
    replayed_stopout_events: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    """Evaluate G3 (#52) read-only margin/hedge/stop-out attestation & out-of-sample fill match."""
    envelope = {
        "readOnly": True,
        "executionEnabled": False,
        "liveAuthorized": False,
        "brokerStopOutExecutionVerified": False,
    }

    contract = attest_broker_margin_contract(
        account_info=account_info,
        symbol_info=symbol_info,
        expected_account_login=expected_account_login,
        expected_server=expected_server,
        now_utc=now_utc,
    )
    if not contract["attested"]:
        return {**envelope, "admitted": False, "reason": contract["reason"], "contract": contract}

    if positions is None:
        return {**envelope, "admitted": False, "reason": "POSITIONS_INVENTORY_UNAVAILABLE", "contract": contract}
    if observed_stopout_fills is None or replayed_stopout_events is None:
        return {**envelope, "admitted": False, "reason": "STOPOUT_EVIDENCE_MISSING", "contract": contract}

    has_buy = any(p.get("type") == 0 for p in positions)
    has_sell = any(p.get("type") == 1 for p in positions)
    if has_buy and has_sell and not contract["hedgedMarginPolicyVerified"]:
        return {
            **envelope,
            "admitted": False,
            "reason": "HEDGED_MARGIN_POLICY_UNVERIFIED",
            "contract": contract,
        }

    if len(observed_stopout_fills) == 0 or len(replayed_stopout_events) == 0:
        return {
            **envelope,
            "admitted": False,
            "reason": "NO_OUT_OF_SAMPLE_STOPOUT_FILLS_TO_VERIFY",
            "contract": contract,
        }

    obs_tickets = [f.get("positionTicket") for f in observed_stopout_fills]
    rep_tickets = [e.get("positionTicket") for e in replayed_stopout_events]
    if any(not isinstance(t, int) or isinstance(t, bool) or t <= 0 for t in obs_tickets):
        return {**envelope, "admitted": False, "reason": "INVALID_OBSERVED_FILL_TICKET", "contract": contract}
    if obs_tickets != rep_tickets:
        return {
            **envelope,
            "admitted": False,
            "reason": "STOPOUT_SEQUENCE_MISMATCH",
            "observedTickets": obs_tickets,
            "replayedTickets": rep_tickets,
            "contract": contract,
        }

    return {
        **envelope,
        "brokerStopOutExecutionVerified": True,
        "admitted": True,
        "reason": "G3_BROKER_STOPOUT_EVIDENCE_VERIFIED",
        "verifiedStopOutTickets": obs_tickets,
        "contract": contract,
    }
