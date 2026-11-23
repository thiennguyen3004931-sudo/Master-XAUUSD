"""Unit tests for V6 Protective SL/TP Broker-Boundary Adapter (Stream D — #7)."""

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
    base = {
        "ticket": 123456,
        "magic": BOT_MAGIC,
        "direction": "BUY",
        "entryPrice": 2650.0,
        "initialSl": 2643.0,
        "initialRiskUsd": 7.0,
        "currentSl": 2643.0,
        "currentTp": 2665.0,
    }
    base.update(overrides)
    return base


def _quote(**overrides):
    base = {"bid": 2658.0, "ask": 2658.2, "quoteTimestampUtc": 1795416000}
    base.update(overrides)
    return base


class TestSltpBrokerModifyAdapter(unittest.TestCase):
    def test_valid_buy_and_sell_sltp_modify_on_mock_broker_never_closes_or_opens(self) -> None:
        captured: list[dict] = []

        def mock_sender(req):
            captured.append(dict(req))
            return {"retcode": 10009}

        res = adapter.execute_protective_sltp_update_mock_boundary(
            position=_pos(),
            bot_magic=BOT_MAGIC,
            quote=_quote(),
            now_utc=1795416003,
            proposed_sl=2650.2,
            broker_stops_level_usd=0.5,
            broker_freeze_level_usd=0.3,
            broker_sltp_sender=mock_sender,
        )
        self.assertTrue(res["modified"])
        self.assertEqual(res["status"], "MODIFIED_ON_MOCK_BROKER")
        self.assertEqual(res["effectiveSl"], 2650.2)
        self.assertEqual(res["effectiveTp"], 2665.0)
        self.assertFalse(res["positionAutoClosed"])
        self.assertFalse(res["newOrderSubmitted"])
        self.assertFalse(res["liveAuthorized"])
        self.assertEqual(captured[0]["action"], "TRADE_ACTION_SLTP")

    def test_stale_quote_non_monotonic_and_target_freeze_are_blocked(self) -> None:
        stale = adapter.execute_protective_sltp_update_mock_boundary(
            position=_pos(),
            bot_magic=BOT_MAGIC,
            quote=_quote(quoteTimestampUtc=1795415900),
            now_utc=1795416005,
            proposed_sl=2650.2,
            broker_stops_level_usd=0.5,
            broker_freeze_level_usd=0.3,
        )
        self.assertFalse(stale["modified"])
        self.assertEqual(stale["reason"], "QUOTE_STALE_NO_MODIFY")

        non_mono = adapter.execute_protective_sltp_update_mock_boundary(
            position=_pos(currentSl=2650.2),
            bot_magic=BOT_MAGIC,
            quote=_quote(),
            now_utc=1795416003,
            proposed_sl=2648.0,
            broker_stops_level_usd=0.5,
            broker_freeze_level_usd=0.3,
        )
        self.assertFalse(non_mono["modified"])
        self.assertEqual(non_mono["reason"], "NON_MONOTONIC_SL_REJECTED")

        freeze = adapter.execute_protective_sltp_update_mock_boundary(
            position=_pos(),
            bot_magic=BOT_MAGIC,
            quote=_quote(bid=2652.0, ask=2652.2),
            now_utc=1795416003,
            proposed_sl=2650.8,
            broker_stops_level_usd=0.5,
            broker_freeze_level_usd=1.5,
        )
        self.assertFalse(freeze["modified"])
        self.assertEqual(freeze["reason"], "TARGET_SL_VIOLATES_STOPS_OR_FREEZE_LEVEL")

    def test_broker_reject_and_exception_preserve_existing_sl_tp_and_request_retry(self) -> None:
        rej = adapter.execute_protective_sltp_update_mock_boundary(
            position=_pos(),
            bot_magic=BOT_MAGIC,
            quote=_quote(),
            now_utc=1795416003,
            proposed_sl=2650.2,
            broker_stops_level_usd=0.5,
            broker_freeze_level_usd=0.3,
            broker_sltp_sender=lambda _req: {"retcode": 10016},
        )
        self.assertFalse(rej["modified"])
        self.assertEqual(rej["status"], "BROKER_REJECTED_SL_PRESERVED")
        self.assertEqual(rej["effectiveSl"], 2643.0)
        self.assertEqual(rej["effectiveTp"], 2665.0)
        self.assertTrue(rej["retryRequired"])
        self.assertFalse(rej["positionAutoClosed"])

        def boom(_req):
            raise RuntimeError("terminal disconnected")

        exc = adapter.execute_protective_sltp_update_mock_boundary(
            position=_pos(),
            bot_magic=BOT_MAGIC,
            quote=_quote(),
            now_utc=1795416003,
            proposed_sl=2650.2,
            broker_stops_level_usd=0.5,
            broker_freeze_level_usd=0.3,
            broker_sltp_sender=boom,
        )
        self.assertFalse(exc["modified"])
        self.assertEqual(exc["status"], "BROKER_MODIFY_EXCEPTION_SL_PRESERVED")
        self.assertEqual(exc["effectiveSl"], 2643.0)
        self.assertTrue(exc["retryRequired"])


if __name__ == "__main__":
    unittest.main()
