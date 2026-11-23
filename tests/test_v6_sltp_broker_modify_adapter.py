"""No-MT5 offline tests for V6 inert protective SLTP candidate validation."""

from __future__ import annotations

from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import v6_sltp_broker_modify_adapter as adapter


BOT_MAGIC = 600001


def _pos(**overrides):
    position = {
        "ticket": 123456,
        "magic": BOT_MAGIC,
        "accountLogin": 5201362,
        "server": "DBGMarkets-Live",
        "symbol": "XAUUSD.G",
        "direction": "BUY",
        "entryPrice": 2650.0,
        "initialSl": 2643.0,
        "initialRiskUsd": 7.0,
        "currentSl": 2643.0,
        "currentTp": 2665.0,
    }
    position.update(overrides)
    return position


def _quote(**overrides):
    quote = {
        "bid": 2658.0,
        "ask": 2658.2,
        "accountLogin": 5201362,
        "server": "DBGMarkets-Live",
        "symbol": "XAUUSD.G",
        "quoteTimestampUtc": 1795416000,
    }
    quote.update(overrides)
    return quote


def _evaluate(*, position=None, quote=None, sl=2650.2, sender=None, **extra):
    return adapter.execute_protective_sltp_update_mock_boundary(
        position=_pos() if position is None else position,
        bot_magic=BOT_MAGIC,
        quote=_quote() if quote is None else quote,
        now_utc=1795416003,
        proposed_sl=sl,
        broker_stops_level_usd=0.5,
        broker_freeze_level_usd=0.3,
        broker_sltp_sender=sender,
        **extra,
    )


class TestSltpBrokerModifyAdapter(unittest.TestCase):
    def test_buy_and_sell_proposals_are_inert_and_preserve_existing_sl_tp(self):
        for direction in ("BUY", "SELL"):
            with self.subTest(direction=direction):
                buy = direction == "BUY"
                p = _pos() if buy else _pos(
                    direction="SELL", initialSl=2657.0,
                    currentSl=2657.0, currentTp=2635.0,
                )
                q = _quote() if buy else _quote(bid=2642.0, ask=2642.2)
                result = _evaluate(
                    position=p, quote=q,
                    sl=2650.2 if buy else 2649.8,
                )
                self.assertEqual(result["status"], "PROPOSAL_READY_OFFLINE_ONLY")
                self.assertFalse(result["modified"])
                self.assertTrue(result["proposalOnly"])
                self.assertEqual(result["proposedSl"], 2650.2 if buy else 2649.8)
                self.assertEqual(result["effectiveSl"], p["currentSl"])
                self.assertEqual(result["effectiveTp"], p["currentTp"])
                self.assertFalse(result["retryRequired"])
                self.assertFalse(result["brokerSenderInvoked"])
                self.assertFalse(result["brokerPositionReadbackVerified"])
                self.assertFalse(result["immutableInitialRiskProvenanceVerified"])
                self.assertFalse(result["positionAutoClosed"])
                self.assertFalse(result["newOrderSubmitted"])
                self.assertFalse(result["liveAuthorized"])

    def test_injected_callback_cannot_make_real_or_mock_broker_call(self):
        captured = []

        def spoofed_sender(req):
            captured.append(req)
            return {"retcode": 10009}

        for direction in ("BUY", "SELL"):
            p = _pos() if direction == "BUY" else _pos(
                direction="SELL", initialSl=2657.0,
                currentSl=2657.0, currentTp=2635.0,
            )
            q = _quote() if direction == "BUY" else _quote(
                bid=2642.0, ask=2642.2,
            )
            res = _evaluate(
                position=p, quote=q, sl=2650.2 if direction == "BUY" else 2649.8,
                sender=spoofed_sender,
            )
            self.assertEqual(res["reason"], "OFFLINE_BROKER_CALLBACK_FORBIDDEN")
            self.assertFalse(res["modified"])
            self.assertIsNone(res["proposedSl"])
            self.assertFalse(res["retryRequired"])
        self.assertEqual(captured, [])

    def test_missing_initial_risk_or_tp_fails_closed(self):
        for missing in ("initialSl", "initialRiskUsd"):
            for direction in ("BUY", "SELL"):
                p = _pos() if direction == "BUY" else _pos(
                    direction="SELL", initialSl=2657.0, currentSl=2657.0,
                    currentTp=2635.0,
                )
                p[missing] = None
                q = _quote() if direction == "BUY" else _quote(
                    bid=2642.0, ask=2642.2,
                )
                res = _evaluate(
                    position=p, quote=q,
                    sl=2650.2 if direction == "BUY" else 2649.8,
                )
                self.assertFalse(res["modified"])
                self.assertEqual(res["reason"], "IMMUTABLE_INITIAL_RISK_MISSING_OR_UNVERIFIED")
                self.assertIsNone(res["proposedSl"])
        for invalid in (None, 0, float("nan")):
            with self.subTest(tp=invalid):
                res = _evaluate(position=_pos(currentTp=invalid))
                self.assertFalse(res["modified"])
                self.assertEqual(res["reason"], "INVALID_POSITION_STATE")
                self.assertIsNone(res["proposedSl"])

    def test_inconsistent_initial_risk_blocks_candidate(self):
        for direction in ("BUY", "SELL"):
            buy = direction == "BUY"
            pos = _pos(
                direction=direction,
                initialSl=2643.0 if buy else 2657.0,
                currentSl=2643.0 if buy else 2657.0,
                currentTp=2665.0 if buy else 2635.0,
                initialRiskUsd=4.0,
            )
            res = _evaluate(
                position=pos,
                quote=_quote() if buy else _quote(bid=2642.0, ask=2642.2),
                sl=2650.2 if buy else 2649.8,
            )
            self.assertEqual(res["reason"], "IMMUTABLE_INITIAL_RISK_MISMATCH")
            self.assertIsNone(res["proposedSl"])

    def test_stale_quote_nonmonotonic_and_freeze_are_blocked(self):
        stale = _evaluate(quote=_quote(quoteTimestampUtc=1795415900))
        self.assertEqual(stale["reason"], "QUOTE_STALE_NO_MODIFY")
        nonmono = _evaluate(position=_pos(currentSl=2650.2), sl=2648.0)
        self.assertEqual(nonmono["reason"], "NON_MONOTONIC_SL_REJECTED")
        freeze = _evaluate(
            quote=_quote(bid=2652.0, ask=2652.2),
            sl=2650.8,
            broker_freeze_level_usd=1.5,
        )
        self.assertEqual(freeze["reason"], "TARGET_SL_VIOLATES_STOPS_OR_FREEZE_LEVEL")
        for res in (stale, nonmono, freeze):
            self.assertFalse(res["modified"])
            self.assertIsNone(res["proposedSl"])
            self.assertFalse(res["retryRequired"])
            self.assertFalse(res["liveAuthorized"])

    def test_account_symbol_server_and_foreign_magic_or_ticket_are_blocked(self):
        mismatches = [
            (_pos(accountLogin=1), _quote()),
            (_pos(), _quote(accountLogin=42)),
            (_pos(server="Wrong-Server"), _quote()),
            (_pos(), _quote(server="Wrong-Server")),
            (_pos(symbol="GOLD"), _quote()),
            (_pos(), _quote(symbol="GOLD")),
        ]
        for p, q in mismatches:
            with self.subTest(p=p, q=q):
                res = _evaluate(position=p, quote=q)
                self.assertEqual(res["reason"], "ACCOUNT_SERVER_SYMBOL_BINDING_UNVERIFIED")
                self.assertFalse(res["modified"])
        for p in (_pos(magic=9), _pos(ticket=0), _pos(ticket="123456")):
            res = _evaluate(position=p)
            self.assertIn(res["reason"], ("POSITION_NOT_OWNED_BY_BOT", "INVALID_POSITION_STATE"))
            self.assertFalse(res["modified"])
            self.assertFalse(res["liveAuthorized"])


if __name__ == "__main__":
    unittest.main()
