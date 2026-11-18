import os
import shutil
import tempfile
"""Mock-broker tests: these never connect to or place an actual MT5 order."""
import importlib.util
import sys
import time
import unittest
import tempfile
from pathlib import Path
from types import SimpleNamespace

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("xauusd_mt5_direct_probe", SCRIPTS / "mt5-direct-probe.py")
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)


class MockBroker:
    ORDER_TYPE_BUY = 0
    ORDER_TYPE_SELL = 1
    ORDER_FILLING_FOK = 0
    ORDER_TIME_GTC = 0
    TRADE_ACTION_DEAL = 1
    TRADE_ACTION_SLTP = 6
    TRADE_RETCODE_DONE = 10009

    def __init__(self):
        self.positions = []
        self.asks = 4000.20
        self.bids = 4000.00
        self.sent = []

    def symbol_info(self, symbol):
        return SimpleNamespace(
            visible=True, volume_min=0.01, volume_step=0.01,
            volume_max=100.0, digits=2, point=0.01, filling_mode=1,
            trade_stops_level=20
        )

    def symbol_info_tick(self, symbol):
        return SimpleNamespace(ask=self.asks, bid=self.bids, time=int(time.time()))

    def account_info(self):
        return SimpleNamespace(equity=4000.0, balance=4000.0, margin_free=4000.0,
                               login=5201362, server="MOCK-DEMO", trade_mode=0)

    def order_calc_margin(self, kind, symbol, lot, price):
        return lot * price

    def orders_get(self, *args, **kwargs):
        # Default mock confirms an empty pending-order inventory.
        return []

    def history_deals_get(self, from_ts, to_ts):
        # Verified empty history is distinct from missing/unavailable history API.
        return []

    def order_calc_profit(self, kind, symbol, lot, entry, stop):
        if kind == 0:
            return (stop - entry) * lot * 100.0
        return (entry - stop) * lot * 100.0

    def positions_get(self, *args, **kwargs):
        ticket = kwargs.get("ticket")
        if ticket is not None:
            return [p for p in self.positions if int(getattr(p, "ticket", 0)) == int(ticket)]
        symbol = kwargs.get("symbol")
        if symbol is not None:
            return [p for p in self.positions if str(p.symbol) == str(symbol)]
        return self.positions

    def order_send(self, request):
        self.sent.append(request)
        if request["action"] == self.TRADE_ACTION_SLTP:
            for p in self.positions:
                if p.ticket == request["position"]:
                    p.sl = request["sl"]
                    p.tp = request["tp"]
            return SimpleNamespace(retcode=10009, order=123)
        if request["action"] == self.TRADE_ACTION_DEAL and "position" in request:
            for p in list(self.positions):
                if p.ticket == request["position"]:
                    p.volume = round(p.volume - request["volume"], 8)
                    if p.volume <= 1e-8:
                        self.positions.remove(p)
            return SimpleNamespace(retcode=10009, order=123, price=request["price"])
        if request["action"] == self.TRADE_ACTION_DEAL and "position" not in request:
            self.positions.append(SimpleNamespace(
                ticket=123, identifier=123, symbol=request.get("symbol", "XAUUSD.G"),
                type=0 if int(request.get("type", 0)) == 0 else 1,
                volume=float(request.get("volume", 0.02)),
                price_open=float(request.get("price", 4000.0)),
                price_current=float(request.get("price", 4000.0)),
                sl=float(request.get("sl", 0.0)),
                tp=float(request.get("tp", 0.0)),
                magic=int(request.get("magic", 270715)),
                comment=str(request.get("comment", "")),
            ))
        return SimpleNamespace(retcode=10009, order=123, price=request["price"])


class ExecutionRiskTest(unittest.TestCase):
    def setUp(self):
        self._tmp_rt = Path(tempfile.mkdtemp(prefix="v6-exec-rt-"))
        os.environ["V6_RUNTIME_DIR"] = str(self._tmp_rt)
        engine.RUNTIME_DIR = self._tmp_rt
        engine.MANAGER_STATE_FILE = self._tmp_rt / "v6-position-tracker.json"
        engine.DAILY_RISK_STATE_FILE = self._tmp_rt / "v6-daily-risk-state.json"
        engine.REGIME_STATE_FILE = self._tmp_rt / "v6-regime-state.json"

    def tearDown(self):
        shutil.rmtree(self._tmp_rt, ignore_errors=True)
    def test_pending_orders_read_fail_closed(self):
        for failure in ("missing", "exception", "none"):
            with self.subTest(failure=failure):
                mt5 = MockBroker()
                if failure == "missing":
                    mt5.orders_get = None
                elif failure == "exception":
                    def unavailable(*args, **kwargs):
                        raise RuntimeError("mock read failure")
                    mt5.orders_get = unavailable
                else:
                    mt5.orders_get = lambda *args, **kwargs: None
                result = engine.execute_order(mt5, "XAUUSD.G", {
                    "side": "BUY", "volume": 0.02, "slDistance": 7,
                    "tpDistance": 16
                })
                self.assertFalse(result["ok"], result)
                self.assertEqual(result["status"], "BLOCKED_PENDING_ORDERS_UNVERIFIED")
                self.assertEqual(mt5.sent, [])

    def test_above_risk_budget_emits_warning_without_blocking_fixed_lot(self):
        mt5 = MockBroker()
        result = engine.execute_order(mt5, "XAUUSD.G", {
            "side": "BUY", "volume": 0.05, "slDistance": 6.8, "tpDistance": 16,
            "maxRiskPercent": 0.5
        })
        self.assertTrue(result["ok"])
        self.assertEqual(result["sizingMode"], "FIXED_LOT")
        self.assertEqual(result["volume"], 0.05)
        self.assertTrue(any("WARNING_PER_TRADE_RISK" in w for w in result.get("riskWarnings", [])))
        self.assertEqual(len(mt5.sent), 1)

    def test_within_risk_budget_sends_protected_order(self):
        mt5 = MockBroker()
        result = engine.execute_order(mt5, "XAUUSD.G", {
            "side": "BUY", "volume": 0.02, "slDistance": 6.8, "tpDistance": 16,
            "maxRiskPercent": 0.5
        })
        self.assertTrue(result["ok"])
        self.assertEqual(len(mt5.sent), 1)
        self.assertGreater(mt5.sent[0]["tp"], mt5.sent[0]["price"])
        self.assertLess(mt5.sent[0]["sl"], mt5.sent[0]["price"])

    def test_margin_data_or_calculation_failure_blocks_new_orders(self):
        """P0: missing, invalid or inaccessible broker margin cannot submit."""
        from unittest.mock import patch

        scenarios = [
            ("missing_free_margin", None, None),
            ("nan_free_margin", float("nan"), None),
            ("zero_free_margin", 0.0, None),
            ("negative_free_margin", -5.0, None),
            ("invalid_free_margin", "unavailable", None),
            ("missing_margin_api", 4000.0, "missing"),
            ("none_margin", 4000.0, None),
            ("nan_margin", 4000.0, float("nan")),
            ("negative_margin", 4000.0, -1.0),
            ("zero_margin", 4000.0, 0.0),
            ("margin_exception", 4000.0, "raise"),
        ]
        cfg = {"side": "BUY", "volume": 0.02, "slDistance": 6.8, "tpDistance": 16}
        for label, free, required in scenarios:
            with self.subTest(case=label):
                broker = MockBroker()
                old_info = broker.account_info
                def with_margin():
                    account = old_info()
                    if label == "missing_free_margin":
                        del account.margin_free
                    else:
                        account.margin_free = free
                    return account

                def margin_calc(*args):
                    if required == "raise":
                        raise RuntimeError("mock broker unavailable")
                    return required

                with patch.object(broker, "account_info", side_effect=with_margin):
                    if label == "missing_margin_api":
                        broker.order_calc_margin = None
                        outcome = engine.execute_order(broker, "XAUUSD.G", cfg)
                    elif label in ("missing_free_margin", "nan_free_margin", "zero_free_margin",
                                   "negative_free_margin", "invalid_free_margin"):
                        outcome = engine.execute_order(broker, "XAUUSD.G", cfg)
                    else:
                        with patch.object(broker, "order_calc_margin", side_effect=margin_calc):
                            outcome = engine.execute_order(broker, "XAUUSD.G", cfg)
                self.assertFalse(outcome["ok"], outcome)
                self.assertFalse(outcome.get("submitted", False), outcome)
                self.assertEqual(outcome.get("status"), "BLOCKED_MARGIN_UNVERIFIED", outcome)
                self.assertEqual(broker.sent, [])

    def test_margin_reserve_is_required_but_valid_margin_allows_entry(self):
        """P0: margin requirement must be below the conservative 95% budget."""
        from unittest.mock import patch
        cfg = {"side": "BUY", "volume": 0.02, "slDistance": 6.8, "tpDistance": 16}
        broker = MockBroker()
        with patch.object(broker, "order_calc_margin", return_value=3800.01):
            blocked = engine.execute_order(broker, "XAUUSD.G", cfg)
        self.assertEqual(blocked.get("status"), "BLOCKED_INSUFFICIENT_MARGIN")
        self.assertFalse(blocked.get("submitted", False))
        self.assertEqual(broker.sent, [])

        with patch.object(broker, "order_calc_margin", return_value=100.0):
            allowed = engine.execute_order(broker, "XAUUSD.G", cfg)
        self.assertTrue(allowed["ok"], allowed)
        self.assertEqual(len(broker.sent), 1)

    def test_high_spread_is_rejected(self):
        mt5 = MockBroker()
        mt5.asks = 4002.0
        result = engine.execute_order(mt5, "XAUUSD.G", {
            "side": "BUY", "volume": 0.02, "slDistance": 6.8, "tpDistance": 16
        })
        self.assertFalse(result["ok"])
        self.assertEqual(len(mt5.sent), 0)

    def test_buy_sell_wide_structural_sl_waits_without_broker_submission(self):
        """Actual execution gateway must not shrink a >8 USD structural stop."""
        for side, stop, tp, invalidation in [
            ("BUY", 3992.10, 4017.0, 3992.50),   # 4000.20 - 3992.10 = 8.10
            ("SELL", 4008.10, 3983.0, 4007.90),  # 4008.10 - 4000.00 = 8.10
        ]:
            with self.subTest(side=side):
                broker = MockBroker()
                cfg = {
                    "side": side, "volume": 0.02,
                    "explicitSlPrice": stop, "explicitTpPrice": tp,
                    "structuralInvalidationPrice": invalidation,
                    "minRewardRisk": 1.2,
                }
                rejected = engine.execute_order(broker, "XAUUSD.G", cfg)
                self.assertFalse(rejected["ok"], rejected)
                self.assertFalse(rejected.get("submitted", False))
                self.assertEqual(rejected["status"], "WAIT_PULLBACK")
                self.assertGreater(rejected["slDistance"], 8.0)
                self.assertEqual(broker.sent, [])

                # A confirmed non-submission is safe to reevaluate after a
                # pullback; unlike unknown broker fills it must not latch
                # BLOCKED_UNCERTAIN_PREVIOUS_ENTRY.
                again = engine.execute_order(broker, "XAUUSD.G", cfg)
                self.assertEqual(again["status"], "WAIT_PULLBACK")
                self.assertEqual(broker.sent, [])

    def test_buy_sell_exactly_eight_usd_sl_is_not_forced_to_pullback(self):
        """8.00 is an inclusive maximum at the final broker quote."""
        for side, stop, tp, invalidation in [
            ("BUY", 3992.20, 4017.0, 3992.50),
            ("SELL", 4008.00, 3983.0, 4007.80),
        ]:
            with self.subTest(side=side):
                broker = MockBroker()
                result = engine.execute_order(broker, "XAUUSD.G", {
                    "side": side, "volume": 0.02,
                    "explicitSlPrice": stop, "explicitTpPrice": tp,
                    "structuralInvalidationPrice": invalidation,
                    "minRewardRisk": 1.2,
                })
                self.assertTrue(result["ok"], result)
                self.assertEqual(len(broker.sent), 1)
                self.assertEqual(broker.sent[0]["sl"], stop)

    def test_lot_not_rounded_up_to_broker_step(self):
        mt5 = MockBroker()
        result = engine.execute_order(mt5, "XAUUSD.G", {
            "side": "BUY", "volume": 0.025, "slDistance": 6.8, "tpDistance": 16
        })
        self.assertFalse(result["ok"])
        self.assertEqual(mt5.sent, [])

    def test_unfavorable_reward_risk_rejected_at_actual_quote(self):
        mt5 = MockBroker()
        result = engine.execute_order(mt5, "XAUUSD.G", {
            "side": "BUY", "volume": 0.01, "slDistance": 6.8, "tpDistance": 5,
            "minRewardRisk": 1.6
        })
        self.assertFalse(result["ok"])
        self.assertEqual(mt5.sent, [])

    def test_broker_pending_order_not_claimed_as_fill(self):
        class PendingBroker(MockBroker):
            def order_send(self, request):
                self.sent.append(request)
                return SimpleNamespace(retcode=10008)
        mt5 = PendingBroker()
        result = engine.execute_order(mt5, "XAUUSD.G", {
            "side": "BUY", "volume": 0.01, "slDistance": 6.8, "tpDistance": 16
        })
        self.assertFalse(result["ok"])
        self.assertTrue(result.get("pending"))
        self.assertTrue(result.get("submitted"))
        self.assertTrue(result.get("uncertain"))
        self.assertEqual(len(mt5.sent), 1)

    def test_partial_entry_fill_must_not_claim_full_lot_or_success(self):
        class PartialEntryBroker(MockBroker):
            def order_send(self, request):
                self.sent.append(request)
                return SimpleNamespace(retcode=10010, volume=0.01, price=request["price"], order=123)
        mt5 = PartialEntryBroker()
        result = engine.execute_order(mt5, "XAUUSD.G", {
            "side": "BUY", "volume": 0.02,
            "slDistance": 6.8, "tpDistance": 16,
        })
        self.assertFalse(result["ok"])
        self.assertTrue(result["partialFill"])
        self.assertTrue(result["submitted"])
        self.assertTrue(result["uncertain"])
        self.assertEqual(result["requestedVolume"], 0.02)
        self.assertNotIn("volume", result)
        self.assertEqual(len(mt5.sent), 1)

    def test_order_send_exception_after_dispatch_is_uncertain_and_not_retried(self):
        class ExceptionAfterSubmitBroker(MockBroker):
            def order_send(self, request):
                self.sent.append(request)
                raise TimeoutError("broker transport exception")
        mt5 = ExceptionAfterSubmitBroker()
        result = engine.execute_order(mt5, "XAUUSD.G", {
            "side": "BUY", "volume": 0.02,
            "slDistance": 6.8, "tpDistance": 16,
        })
        self.assertFalse(result["ok"])
        self.assertTrue(result["submitted"])
        self.assertTrue(result["uncertain"])
        self.assertEqual(len(mt5.sent), 1)

    def test_done_retcode_mismatched_volume_is_not_full_fill(self):
        class MismatchedVolumeBroker(MockBroker):
            def order_send(self, request):
                self.sent.append(request)
                return SimpleNamespace(retcode=10009, order=123, price=request["price"],
                                       volume=request["volume"] / 2)
        mt5 = MismatchedVolumeBroker()
        result = engine.execute_order(mt5, "XAUUSD.G", {
            "side": "SELL", "volume": 0.02,
            "slDistance": 6.8, "tpDistance": 16,
        })
        self.assertFalse(result["ok"])
        self.assertTrue(result["submitted"])
        self.assertTrue(result["uncertain"])
        self.assertTrue(result["partialFill"])
        self.assertEqual(result["requestedVolume"], 0.02)
        self.assertEqual(len(mt5.sent), 1)

    def test_order_without_broker_response_is_uncertain_not_safe_to_retry(self):
        class NoResponseBroker(MockBroker):
            def order_send(self, request):
                self.sent.append(request)
                return None
        mt5 = NoResponseBroker()
        result = engine.execute_order(mt5, "XAUUSD.G", {
            "side": "BUY", "volume": 0.02,
            "slDistance": 6.8, "tpDistance": 16,
        })
        self.assertFalse(result["ok"])
        self.assertTrue(result["submitted"])
        self.assertTrue(result["uncertain"])
        self.assertEqual(len(mt5.sent), 1)

    def test_uncertain_entry_freeze_survives_restart_and_blocks_retry(self):
        """P0: An ambiguous broker submission must freeze future entries."""
        class NoResponseBroker(MockBroker):
            def order_send(self, request):
                self.sent.append(request)
                return None

        broker = NoResponseBroker()
        cfg = {"side": "BUY", "volume": 0.02, "slDistance": 6.8, "tpDistance": 16.0}
        first = engine.execute_order(broker, "XAUUSD.G", cfg)
        self.assertFalse(first["ok"])
        self.assertTrue(first["submitted"])
        self.assertTrue(first["uncertain"])
        self.assertEqual(len(broker.sent), 1)

        # New broker object simulates a restarted process sharing runtime state.
        restarted_broker = MockBroker()
        blocked = engine.execute_order(restarted_broker, "XAUUSD.G", cfg)
        self.assertFalse(blocked["ok"])
        self.assertFalse(blocked["submitted"])
        self.assertEqual(blocked["status"], "BLOCKED_UNCERTAIN_PREVIOUS_ENTRY")
        self.assertEqual(restarted_broker.sent, [])

        # A corrupt persistent marker must block rather than authorize orders.
        (engine.RUNTIME_DIR / "v6-uncertain-entry-state.json").write_text(
            "{partial", encoding="utf-8"
        )
        invalid = engine.execute_order(restarted_broker, "XAUUSD.G", cfg)
        self.assertFalse(invalid["ok"])
        self.assertFalse(invalid["submitted"])
        self.assertEqual(invalid["status"], "BLOCKED_ENTRY_STATE_UNAVAILABLE")
        self.assertEqual(restarted_broker.sent, [])

    def test_crash_during_entry_leaves_persistent_freeze(self):
        """P0: A crash after durable intent but before response is not retried."""
        from unittest.mock import patch

        broker = MockBroker()
        cfg = {"side": "BUY", "volume": 0.02, "slDistance": 6.8, "tpDistance": 16.0}
        with patch.object(engine, "_execute_order_serialized", side_effect=RuntimeError("synthetic crash")):
            with self.assertRaises(RuntimeError):
                engine.execute_order(broker, "XAUUSD.G", cfg)

        blocked = engine.execute_order(MockBroker(), "XAUUSD.G", cfg)
        self.assertFalse(blocked["ok"])
        self.assertFalse(blocked["submitted"])
        self.assertEqual(blocked["status"], "BLOCKED_UNCERTAIN_PREVIOUS_ENTRY")

    def test_broker_timeout_and_connection_loss_are_not_confirmed_rejections(self):
        class TransportIssueBroker(MockBroker):
            def __init__(self, code):
                super().__init__()
                self.code = code
            def order_send(self, request):
                self.sent.append(request)
                return SimpleNamespace(retcode=self.code)
        for code in (10012, 10031):
            with self.subTest(code=code):
                # Distinct mocked broker scenarios, not a retry of a prior
                # ambiguous request; reset synthetic test state explicitly.
                engine._write_uncertain_entry_state({})
                mt5 = TransportIssueBroker(code)
                result = engine.execute_order(mt5, "XAUUSD.G", {
                    "side": "SELL", "volume": 0.02,
                    "slDistance": 6.8, "tpDistance": 16,
                })
                self.assertFalse(result["ok"])
                self.assertTrue(result["submitted"])
                self.assertTrue(result["uncertain"])
                self.assertEqual(len(mt5.sent), 1)

    def test_full_entry_fill_can_succeed_without_partial_warning(self):
        mt5 = MockBroker()
        result = engine.execute_order(mt5, "XAUUSD.G", {
            "side": "SELL", "volume": 0.02,
            "slDistance": 6.8, "tpDistance": 16,
        })
        self.assertTrue(result["ok"])
        self.assertFalse(result.get("uncertain", False))
        self.assertEqual(len(mt5.sent), 1)

    def test_order_without_explicit_side_must_not_default_to_buy(self):
        mt5 = MockBroker()
        for side in (None, "", "WAIT", "HOLD"):
            result = engine.execute_order(mt5, "XAUUSD.G", {
                "side": side, "volume": 0.02,
                "slDistance": 6.8, "tpDistance": 16,
            })
            self.assertFalse(result["ok"])
        self.assertEqual(mt5.sent, [])

    def test_portfolio_readback_unavailable_fails_closed_before_order_send(self):
        class UnavailablePortfolioBroker(MockBroker):
            def positions_get(self, *args, **kwargs):
                return None
        mt5 = UnavailablePortfolioBroker()
        result = engine.execute_order(mt5, "XAUUSD.G", {
            "side": "BUY", "volume": 0.02,
            "slDistance": 6.8, "tpDistance": 16,
        })
        self.assertFalse(result["ok"])
        self.assertIn("portfolio", result["message"].lower())
        self.assertEqual(mt5.sent, [])

    def test_portfolio_readback_exception_fails_closed(self):
        class BrokenPortfolioBroker(MockBroker):
            def positions_get(self, *args, **kwargs):
                raise RuntimeError("broker unavailable")
        mt5 = BrokenPortfolioBroker()
        result = engine.execute_order(mt5, "XAUUSD.G", {
            "side": "SELL", "volume": 0.02,
            "slDistance": 6.8, "tpDistance": 16,
        })
        self.assertFalse(result["ok"])
        self.assertEqual(mt5.sent, [])

    def test_unprotected_existing_position_blocks_new_risk(self):
        mt5 = MockBroker()
        mt5.positions = [SimpleNamespace(sl=0, type=0, symbol="XAUUSD.G", volume=0.01, price_open=4000)]
        result = engine.execute_order(mt5, "XAUUSD.G", {
            "side": "BUY", "volume": 0.02, "slDistance": 6.8, "tpDistance": 16
        })
        self.assertFalse(result["ok"])
        self.assertEqual(len(mt5.sent), 0)

    def test_sl_modification_broker_readback_and_monotonic(self):
        mt5 = MockBroker()
        position = SimpleNamespace(
            symbol="XAUUSD.G", ticket=202, type=0, price_open=3990,
            price_current=3997, sl=3983.0, tp=4020.0, magic=270715
        )
        mt5.positions = [position]
        update = engine.modify_position_sl_tp(mt5, position, 3990.25, 4020.0, "BE")
        self.assertTrue(update["ok"], update)
        self.assertGreaterEqual(position.sl, 3990.25)
        previous_sent = len(mt5.sent)
        denied = engine.modify_position_sl_tp(mt5, position, 3988, 4020.0, "Invalid widen")
        self.assertFalse(denied["ok"])
        self.assertEqual(len(mt5.sent), previous_sent)
        self.assertAlmostEqual(position.sl, 3990.25)

    def test_sl_broker_ack_without_readback_must_not_claim_success(self):
        class AckWithoutReadback(MockBroker):
            def order_send(self, req):
                self.sent.append(req)
                return SimpleNamespace(retcode=10009)
        mt5 = AckWithoutReadback()
        p = SimpleNamespace(symbol="XAUUSD.G", ticket=303, type=0, price_open=3990,
                            price_current=3997, sl=3983, tp=4020, magic=270715)
        mt5.positions = [p]
        result = engine.modify_position_sl_tp(mt5, p, 3990.25, 4020, "Unconfirmed BE")
        self.assertFalse(result["ok"])
        self.assertFalse(result["changed"])

    def test_stale_position_snapshot_must_not_widen_newer_broker_sl(self):
        mt5 = MockBroker()
        current = SimpleNamespace(symbol="XAUUSD.G", ticket=309, type=0, price_open=3990,
                                  price_current=3997, sl=3995, tp=4030, magic=270715)
        stale = SimpleNamespace(symbol="XAUUSD.G", ticket=309, type=0, price_open=3990,
                                price_current=3997, sl=3983, tp=4020, magic=270715)
        mt5.positions = [current]
        denied = engine.modify_position_sl_tp(mt5, stale, 3990.25, None, "Stale BE")
        self.assertFalse(denied["ok"])
        self.assertEqual(mt5.sent, [])
        self.assertEqual(current.sl, 3995)
        self.assertEqual(current.tp, 4030)

    def test_sl_only_preserves_broker_tp_when_caller_snapshot_stale(self):
        mt5 = MockBroker()
        current = SimpleNamespace(symbol="XAUUSD.G", ticket=310, type=0, price_open=3990,
                                  price_current=3997, sl=3983, tp=4030, magic=270715)
        stale = SimpleNamespace(symbol="XAUUSD.G", ticket=310, type=0, price_open=3990,
                                price_current=3997, sl=3983, tp=4010, magic=270715)
        mt5.positions = [current]
        result = engine.modify_position_sl_tp(mt5, stale, 3990.25, None, "Fresh broker TP")
        self.assertTrue(result["ok"], result)
        self.assertEqual(current.tp, 4030)
        self.assertEqual(mt5.sent[0]["tp"], 4030)

    def test_partial_close_uses_exact_broker_lot_step_and_readback(self):
        class MillilotBroker(MockBroker):
            def symbol_info(self, symbol):
                info = super().symbol_info(symbol)
                info.volume_min = 0.001
                info.volume_step = 0.001
                return info
        mt5 = MillilotBroker()
        p = SimpleNamespace(symbol="XAUUSD.G", ticket=320, type=0,
                            volume=0.011, magic=270715)
        mt5.positions = [p]
        result = engine.partial_close_position(mt5, p, close_ratio=0.5)
        self.assertTrue(result["ok"], result)
        self.assertAlmostEqual(mt5.sent[0]["volume"], 0.005)
        self.assertAlmostEqual(result["closedVolume"], 0.005)
        self.assertAlmostEqual(result["remainingVolume"], 0.006)

    def test_partial_close_ack_without_position_volume_reduction_is_unconfirmed(self):
        class AcknowledgementOnlyBroker(MockBroker):
            def order_send(self, request):
                self.sent.append(request)
                return SimpleNamespace(retcode=10009, price=request["price"])
        mt5 = AcknowledgementOnlyBroker()
        p = SimpleNamespace(symbol="XAUUSD.G", ticket=321, type=0,
                            volume=0.06, magic=270715)
        mt5.positions = [p]
        result = engine.partial_close_position(mt5, p, close_ratio=0.5)
        self.assertFalse(result["ok"])
        self.assertTrue(result["uncertain"])
        self.assertEqual(len(mt5.sent), 1)

    def test_partial_fill_reports_actual_closed_not_requested_volume(self):
        class PartiallyFilledBroker(MockBroker):
            def order_send(self, request):
                self.sent.append(request)
                for p in self.positions:
                    if p.ticket == request["position"]:
                        p.volume = round(p.volume - 0.01, 8)
                return SimpleNamespace(retcode=10010, price=request["price"])
        mt5 = PartiallyFilledBroker()
        p = SimpleNamespace(symbol="XAUUSD.G", ticket=322, type=0,
                            volume=0.06, magic=270715)
        mt5.positions = [p]
        result = engine.partial_close_position(mt5, p, close_ratio=0.5)
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["partialFill"])
        self.assertAlmostEqual(result["requestedCloseVolume"], 0.03)
        self.assertAlmostEqual(result["closedVolume"], 0.01)
        self.assertAlmostEqual(result["remainingVolume"], 0.05)

    def test_partial_close_does_not_force_broker_minimum_above_requested_ratio(self):
        mt5 = MockBroker()
        p = SimpleNamespace(symbol="XAUUSD.G", ticket=323, type=0,
                            volume=0.02, magic=270715)
        mt5.positions = [p]
        result = engine.partial_close_position(mt5, p, close_ratio=0.1)
        self.assertFalse(result["ok"])
        self.assertEqual(mt5.sent, [])

    def test_operator_be_never_loosens_profitable_sl(self):
        mt5 = MockBroker()
        p = SimpleNamespace(symbol="XAUUSD.G", ticket=304, type=0, price_open=3990,
                            price_current=3997, sl=3995, tp=4020, magic=270715)
        mt5.positions = [p]
        result = engine.move_sl_to_breakeven(mt5, 304)
        self.assertTrue(result["ok"])
        self.assertAlmostEqual(p.sl, 3995)
        self.assertEqual(mt5.sent, [])

    def test_auto_sideway_blocks_pyramiding(self):
        signal = {"allowed": True, "side": "BUY", "confidence": 88,
                  "strategyMode": "BOT_2_SIDEWAY", "requestedMode": "AUTO_REGIME"}
        ok, why = engine.check_bot_signal_for_mode(signal, "AUTO_REGIME", "BUY", 85)
        self.assertFalse(ok)
        self.assertIn("sideway", why.lower())

    def test_sideway_dca_prohibited(self):
        signal = {
            "allowed": True, "side": "BUY", "confidence": 88,
            "requestedMode": "BOT_2_SIDEWAY", "patternName": "Range"
        }
        ok, reason = engine.check_bot_signal_for_mode(signal, "BOT_2_SIDEWAY", "BUY", 85)
        self.assertFalse(ok)
        self.assertIn("sideway", reason.lower())

    def test_close_requires_explicit_ticket_and_never_sends_account_wide_order(self):
        mt5 = MockBroker()
        mt5.positions = [SimpleNamespace(
            symbol="EURUSD", ticket=400, type=0, volume=0.03, magic=111
        )]
        for ticket in (None, 0, "", "invalid", True, False, 1.7, "1.7", "01"):
            result = engine.close_position_by_ticket(mt5, ticket)
            self.assertFalse(result["ok"])
        self.assertEqual(mt5.sent, [])
        self.assertEqual(len(mt5.positions), 1)

    def test_close_rejects_non_gold_ticket_even_when_explicit(self):
        mt5 = MockBroker()
        mt5.positions = [SimpleNamespace(
            symbol="EURUSD", ticket=410, type=0, volume=0.03, magic=270715
        )]
        result = engine.close_position_by_ticket(mt5, 410)
        self.assertFalse(result["ok"])
        self.assertEqual(mt5.sent, [])
        self.assertEqual(len(mt5.positions), 1)

    def test_operator_breakeven_rejects_explicit_non_gold_ticket(self):
        mt5 = MockBroker()
        mt5.positions = [SimpleNamespace(
            symbol="EURUSD", ticket=411, type=0, price_open=1.1,
            price_current=1.2, sl=1.0, tp=1.4, volume=0.01, magic=270715
        )]
        result = engine.move_sl_to_breakeven(mt5, 411)
        self.assertFalse(result["ok"])
        self.assertEqual(mt5.sent, [])

    def test_close_explicit_ticket_requires_broker_flat_readback(self):
        mt5 = MockBroker()
        mt5.positions = [SimpleNamespace(
            symbol="XAUUSD.G", ticket=401, type=0, volume=0.03, magic=270715
        )]
        result = engine.close_position_by_ticket(mt5, 401)
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["verifiedClosed"])
        self.assertEqual(result["closedCount"], 1)
        self.assertEqual(mt5.positions, [])

    def test_close_partial_broker_fill_must_not_claim_full_close(self):
        class PartialBroker(MockBroker):
            def order_send(self, request):
                self.sent.append(request)
                for p in self.positions:
                    if p.ticket == request["position"]:
                        p.volume = round(p.volume - 0.01, 8)
                return SimpleNamespace(retcode=10010)
        mt5 = PartialBroker()
        mt5.positions = [SimpleNamespace(
            symbol="XAUUSD.G", ticket=402, type=0, volume=0.03, magic=270715
        )]
        result = engine.close_position_by_ticket(mt5, 402)
        self.assertFalse(result["ok"])
        self.assertTrue(result["submitted"])
        self.assertTrue(result["partialFill"])
        self.assertAlmostEqual(result["remainingVolume"], 0.02)

    def test_close_order_ack_but_broker_readback_unavailable_is_uncertain(self):
        class ReadbackMissingBroker(MockBroker):
            def __init__(self):
                super().__init__()
                self.after_order = False
            def order_send(self, request):
                self.sent.append(request)
                self.after_order = True
                return SimpleNamespace(retcode=10009)
            def positions_get(self, *args, **kwargs):
                if self.after_order:
                    return None
                return super().positions_get(*args, **kwargs)
        mt5 = ReadbackMissingBroker()
        mt5.positions = [SimpleNamespace(
            symbol="XAUUSD.G", ticket=403, type=0, volume=0.03, magic=270715
        )]
        result = engine.close_position_by_ticket(mt5, 403)
        self.assertFalse(result["ok"])
        self.assertTrue(result["uncertain"])
        self.assertEqual(result["closedCount"], 0)
        self.assertEqual(len(mt5.sent), 1)

    def test_close_pending_order_retcode_is_not_fill_confirmation(self):
        class PendingBroker(MockBroker):
            def order_send(self, request):
                self.sent.append(request)
                return SimpleNamespace(retcode=10008)
        mt5 = PendingBroker()
        mt5.positions = [SimpleNamespace(
            symbol="XAUUSD.G", ticket=404, type=0, volume=0.03, magic=270715
        )]
        result = engine.close_position_by_ticket(mt5, 404)
        self.assertFalse(result["ok"])
        self.assertEqual(result["closedCount"], 0)
        self.assertEqual(len(mt5.positions), 1)

    def test_dca_read_only_preview_does_not_send(self):
        mt5 = MockBroker()
        mt5.positions = [SimpleNamespace(
            type=0, profit=10, symbol="XAUUSD.G", ticket=101, time=1000,
            price_open=4000, price_current=4010, sl=4000.25, volume=0.02, tp=4020
        )]
        signal = {
            "allowed": True, "side": "BUY", "confidence": 88,
            "requestedMode": "BOT_1_TREND", "patternName": "Trend",
            "closedM15Time": 3000000, "sl": 4001, "tp": 4030
        }
        result = engine.evaluate_and_execute_positive_dca(
            mt5, "XAUUSD.G", mt5.positions, signal,
            {"enabled": True, "strategyMode": "BOT_1_TREND", "minConfidence": 85, "stepDistance": 4.5},
            execute=False
        )
        self.assertTrue(result["eligible"])
        self.assertFalse(result["executed"])
        self.assertEqual(len(mt5.sent), 0)


if __name__ == "__main__":
    unittest.main()
