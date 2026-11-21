"""G3 P1 *offline* broker margin and stop-out metadata plausibility checks (#52).

Inputs are plain caller-supplied dictionaries, NOT authenticated MT5 reads,
independent broker fills, or out-of-sample evidence. Hashes only fingerprint
the supplied values. No return value in this module can attest broker execution,
authorize LIVE, import MT5, modify ARM, or submit an order.
"""
from __future__ import annotations

import hashlib
import json
import math
from typing import Any

SUPPORTED_MARGIN_SO_MODES = frozenset({"PERCENT", "MONEY"})
SUPPORTED_ACCOUNT_MARGIN_MODES = frozenset({
    "RETAIL_NETTING", "EXCHANGE", "RETAIL_HEDGING",
})
NON_AUTHORIZING = {
    "readOnly": True,
    "executionEnabled": False,
    "runtimePreSendAccepted": False,
    "liveAuthorized": False,
    "admitted": False,
    "brokerStopOutExecutionVerified": False,
    "brokerMarginContractIndependentlyAttested": False,
    "brokerFillSourceIndependentlyVerified": False,
    "scope": "CALLER_SUPPLIED_OFFLINE_SCENARIO_NOT_BROKER_ATTESTED",
}


def _pos(value: Any) -> bool:
    try:
        return (isinstance(value, (int, float))
                and not isinstance(value, bool)
                and math.isfinite(float(value)) and value > 0)
    except (TypeError, ValueError, OverflowError):
        return False


def _nonneg(value: Any) -> bool:
    try:
        return (isinstance(value, (int, float))
                and not isinstance(value, bool)
                and math.isfinite(float(value)) and value >= 0)
    except (TypeError, ValueError, OverflowError):
        return False


def _ticket(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _fail(reason: str, **extra: Any) -> dict[str, Any]:
    return {
        "attested": False,
        "metadataShapeValid": False,
        "reason": reason,
        "brokerSourceIndependentlyVerified": False,
        "hedgedMarginPolicyVerified": False,
        **extra,
    }


def attest_broker_margin_contract(
    *, account_info: dict[str, Any] | None,
    symbol_info: dict[str, Any] | None,
    expected_account_login: int, expected_server: str,
    now_utc: int | float, max_snapshot_age_sec: int = 10,
) -> dict[str, Any]:
    """Validate *shape*, account-claim and freshness; never attest broker provenance."""
    if not isinstance(account_info, dict) or not isinstance(symbol_info, dict):
        return _fail("MISSING_BROKER_METADATA_DICTS")
    if (not _ticket(expected_account_login)
            or not _ticket(account_info.get("login"))
            or account_info["login"] != expected_account_login):
        return _fail("ACCOUNT_BINDING_MISMATCH")
    server = account_info.get("server")
    if (not isinstance(server, str) or not server.strip()
            or not isinstance(expected_server, str) or not expected_server.strip()
            or server.strip() != expected_server.strip()):
        return _fail("SERVER_BINDING_MISMATCH")
    if (not _pos(max_snapshot_age_sec) or max_snapshot_age_sec > 30
            or not _pos(account_info.get("snapshotEpochUtc"))
            or not _pos(now_utc)):
        return _fail("INVALID_SNAPSHOT_CLOCK_OR_AGE_BOUND")
    age = float(now_utc) - float(account_info["snapshotEpochUtc"])
    if age < 0 or age > float(max_snapshot_age_sec):
        return _fail("SNAPSHOT_STALE_OR_FUTURE_SKEW", ageSec=age)

    margin_mode = account_info.get("marginMode")
    stopout_mode = account_info.get("marginSoMode")
    if not isinstance(margin_mode, str) or margin_mode not in SUPPORTED_ACCOUNT_MARGIN_MODES:
        return _fail("UNSUPPORTED_ACCOUNT_MARGIN_MODE")
    if not isinstance(stopout_mode, str) or stopout_mode not in SUPPORTED_MARGIN_SO_MODES:
        return _fail("UNSUPPORTED_MARGIN_SO_MODE")
    if not _pos(account_info.get("leverage")):
        return _fail("INVALID_ACCOUNT_LEVERAGE")
    currency = account_info.get("currency")
    if not isinstance(currency, str) or not currency.strip():
        return _fail("MISSING_ACCOUNT_CURRENCY")
    so_call = account_info.get("marginSoCall")
    so_out = account_info.get("marginSoStopOut")
    if not _pos(so_call) or not _pos(so_out) or so_out > so_call:
        return _fail("INVALID_STOP_OUT_THRESHOLDS")

    symbol = symbol_info.get("symbol")
    if not isinstance(symbol, str) or not symbol.strip():
        return _fail("INVALID_SYMBOL_CONTRACT_SPECS")
    for key in ("tradeContractSize", "tradeTickSize", "tradeTickValue"):
        if not _pos(symbol_info.get(key)):
            return _fail("INVALID_SYMBOL_CONTRACT_SPECS")
    margin_initial = symbol_info.get("marginInitial")
    if not _nonneg(margin_initial):
        return _fail("INVALID_SYMBOL_MARGIN_INITIAL")
    hedged_margin = symbol_info.get("marginHedged")
    if hedged_margin is not None and not _nonneg(hedged_margin):
        return _fail("INVALID_SYMBOL_HEDGED_MARGIN")

    # Calling this function with dicts and a caller-controlled boolean does
    # NOT establish that a field came from the broker or matches this account.
    # The hash below is merely a deterministic fingerprint of supplied data.
    normalized = {
        "login": account_info["login"],
        "server": server.strip(),
        "currency": currency.strip().upper(),
        "leverage": float(account_info["leverage"]),
        "marginMode": margin_mode,
        "marginSoMode": stopout_mode,
        "marginSoCall": float(so_call),
        "marginSoStopOut": float(so_out),
        "symbol": symbol.strip(),
        "tradeContractSize": float(symbol_info["tradeContractSize"]),
        "tradeTickSize": float(symbol_info["tradeTickSize"]),
        "tradeTickValue": float(symbol_info["tradeTickValue"]),
        "marginInitial": float(margin_initial),
        "marginHedged": float(hedged_margin) if hedged_margin is not None else None,
    }
    digest = hashlib.sha256(
        json.dumps(normalized, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return {
        "attested": False,
        "metadataShapeValid": True,
        "reason": "CALLER_SUPPLIED_MARGIN_METADATA_SHAPE_VALID_NOT_ATTESTED",
        "contractSha256": digest,
        "fingerprintIsBrokerAttestation": False,
        "accountMarginMode": margin_mode,
        "marginSoMode": stopout_mode,
        "marginSoCall": float(so_call),
        "marginSoStopOut": float(so_out),
        "hedgedMarginPolicyVerified": False,
        "brokerSourceIndependentlyVerified": False,
        "claimedHedgePolicyFlag": symbol_info.get("hedgedMarginPolicyAttested") is True,
    }


def _ticket_sequence(items: list[dict[str, Any]], name: str) -> tuple[list[int] | None, str | None]:
    ids: list[int] = []
    for item in items:
        if not isinstance(item, dict) or not _ticket(item.get("positionTicket")):
            return None, "INVALID_" + name + "_TICKET"
        ids.append(item["positionTicket"])
    if len(set(ids)) != len(ids):
        return None, "DUPLICATE_" + name + "_TICKET"
    return ids, None


def evaluate_g3_stopout_evidence_contract(
    *, account_info: dict[str, Any] | None,
    symbol_info: dict[str, Any] | None,
    expected_account_login: int, expected_server: str,
    now_utc: int | float,
    positions: list[dict[str, Any]] | None,
    observed_stopout_fills: list[dict[str, Any]] | None,
    replayed_stopout_events: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    """Compare caller-claimed ticket order; NEVER verify actual broker stop-out."""
    contract = attest_broker_margin_contract(
        account_info=account_info, symbol_info=symbol_info,
        expected_account_login=expected_account_login,
        expected_server=expected_server, now_utc=now_utc,
    )
    envelope = {**NON_AUTHORIZING, "contract": contract}
    if not contract.get("metadataShapeValid"):
        return {**envelope, "reason": contract["reason"],
                "ticketSequenceMatches": False}
    if not isinstance(positions, list) or not isinstance(observed_stopout_fills, list) or not isinstance(replayed_stopout_events, list):
        return {**envelope, "reason": "BROKER_INVENTORY_OR_FILLS_UNAVAILABLE",
                "ticketSequenceMatches": False}

    position_ids: set[int] = set()
    has_buy = False
    has_sell = False
    for pos in positions:
        if not isinstance(pos, dict) or not _ticket(pos.get("ticket")) or pos["ticket"] in position_ids:
            return {**envelope, "reason": "INVALID_OR_DUPLICATE_POSITION",
                    "ticketSequenceMatches": False}
        kind = pos.get("type")
        if not isinstance(kind, int) or isinstance(kind, bool) or kind not in (0, 1):
            return {**envelope, "reason": "UNKNOWN_POSITION_TYPE",
                    "ticketSequenceMatches": False}
        position_ids.add(pos["ticket"])
        has_buy |= kind == 0
        has_sell |= kind == 1

    # Cross-side HEDGING requires a broker-validated actual collateral policy,
    # not the caller's hedgedMarginPolicyAttested=True boolean.
    if has_buy and has_sell:
        return {**envelope, "reason": "HEDGED_MARGIN_POLICY_UNVERIFIED",
                "ticketSequenceMatches": False}
    if not observed_stopout_fills or not replayed_stopout_events:
        return {**envelope, "reason": "NO_OUT_OF_SAMPLE_STOPOUT_FILLS_TO_VERIFY",
                "ticketSequenceMatches": False}

    observed_ids, obs_err = _ticket_sequence(observed_stopout_fills, "OBSERVED_FILL")
    if obs_err:
        return {**envelope, "reason": obs_err, "ticketSequenceMatches": False}
    replayed_ids, replay_err = _ticket_sequence(replayed_stopout_events, "REPLAYED_EVENT")
    if replay_err:
        return {**envelope, "reason": replay_err, "ticketSequenceMatches": False}
    if observed_ids != replayed_ids:
        return {
            **envelope, "reason": "STOPOUT_TICKET_SEQUENCE_MISMATCH",
            "ticketSequenceMatches": False,
            "observedTickets": observed_ids, "replayedTickets": replayed_ids,
        }

    return {
        **envelope,
        "reason": "CALLER_SUPPLIED_TICKET_ORDER_MATCH_ONLY_NOT_BROKER_VERIFIED",
        "ticketSequenceMatches": True,
        "matchedTicketCount": len(observed_ids),
        "priceVolumeTimingMatchVerified": False,
        "outOfSampleIndependentlyVerified": False,
        # Actual broker fill receipts, timestamps, volumes, liquidation
        # priority and symbol-level margin rules have NOT been compared.
    }
