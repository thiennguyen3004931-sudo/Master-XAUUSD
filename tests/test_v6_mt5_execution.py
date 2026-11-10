"""Mock-broker tests: these never connect to or place an actual MT5 order."""
import importlib.util
import sys
import io
from unittest import mock
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


class MissingPackageSafetyTest(unittest.TestCase):
    def test_probe_never_installs_mt5_package_implicitly(self):
        with mock.patch.dict(sys.modules, {"MetaTrader5": None}):
            with mock.patch.object(engine.subprocess, "check_call", side_effect=AssertionError("installer must not run")) as install:
                package, error = engine.ensure_mt5_installed()
        self.assertIsNone(package)
        self.assertIn("not installed", error)
        install.assert_not_called()


class ExistingTerminalAccount:
    """Mock terminal identity fixture: never establishes a real connection."""

    def __init__(self, *, login=111222, server="Broker-Demo", init_ok=True, account_ok=True):
        self.account = SimpleNamespace(login=login, server=server) if account_ok else None
        self.init_ok = init_ok
        self.initialized = 0
        self.login_calls = 0

    def initialize(self, **kwargs):
        self.initialized += 1
        return self.init_ok

    def account_info(self):
        return self.account

    def login(self, **kwargs):
        self.login_calls += 1
        raise AssertionError("V6 must never call MT5 login or switch accounts")


class ExistingSessionBindingTest(unittest.TestCase):
    def test_probe_mismatch_fails_without_switching_even_with_password(self):
        terminal = ExistingTerminalAccount(login=999111)
        ok, error = engine.connect_mt5(terminal, {
            "login": "111222", "server": "Broker-Demo", "password": "not-used"
        })
        self.assertFalse(ok)
        self.assertEqual(error, "MT5_ACCOUNT_BINDING_MISMATCH")
        self.assertEqual(terminal.login_calls, 0)

    def test_server_mismatch_fails_and_does_not_switch(self):
        terminal = ExistingTerminalAccount(server="Broker-Other")
        ok, error = engine.connect_mt5(terminal, {
            "login": "111222", "server": "Broker-Demo"
        })
        self.assertFalse(ok)
        self.assertEqual(error, "MT5_ACCOUNT_BINDING_MISMATCH")
        self.assertEqual(terminal.login_calls, 0)

    def test_matching_account_accepts_read_only_probe_without_login(self):
        terminal = ExistingTerminalAccount()
        ok, error = engine.connect_mt5(terminal, {
            "login": "111222", "server": " broker-demo ", "password": "unused"
        })
        self.assertTrue(ok, error)
        self.assertIsNone(error)
        self.assertEqual(terminal.login_calls, 0)

    def test_mutation_requires_explicit_account_and_server(self):
        for config in ({}, {"login": "111222"}, {"server": "Broker-Demo"}):
            with self.subTest(config=config):
                terminal = ExistingTerminalAccount()
                ok, error = engine.connect_mt5(
                    terminal, config, require_account_binding=True
                )
                self.assertFalse(ok)
                self.assertIn(error, (
                    "MT5_ACCOUNT_BINDING_REQUIRED",
                    "MT5_ACCOUNT_BINDING_INCOMPLETE",
                ))
                self.assertEqual(terminal.initialized, 0)
                self.assertEqual(terminal.login_calls, 0)

    def test_probe_without_configured_identity_does_not_switch(self):
        terminal = ExistingTerminalAccount()
        ok, error = engine.connect_mt5(terminal, {})
        self.assertTrue(ok, error)
        self.assertEqual(terminal.login_calls, 0)

    def test_invalid_login_is_rejected_before_initialize(self):
        for value in ("1e3", "0", "-1", "1.5", "１", True):
            with self.subTest(value=value):
                terminal = ExistingTerminalAccount()
                ok, _ = engine.connect_mt5(terminal, {
                    "login": value, "server": "Broker-Demo"
                })
                self.assertFalse(ok)
                self.assertEqual(terminal.initialized, 0)

    def test_missing_or_unverifiable_terminal_account_rejected(self):
        terminal = ExistingTerminalAccount(account_ok=False)
        ok, error = engine.connect_mt5(terminal, {
            "login": "111222", "server": "Broker-Demo"
        })
        self.assertFalse(ok)
        self.assertEqual(error, "MT5_ACCOUNT_SESSION_UNAVAILABLE")
        self.assertEqual(terminal.login_calls, 0)

    def test_matching_explicit_binding_allows_mutation_gate_to_continue(self):
        terminal = ExistingTerminalAccount()
        ok, error = engine.connect_mt5(terminal, {
            "login": 111222, "server": "Broker-Demo",
        }, require_account_binding=True)
        self.assertTrue(ok, error)
        self.assertEqual(terminal.login_calls, 0)


class MockBroker:
    ORDER_TYPE_BUY = 0
    ORDER_TYPE_SELL = 1
    DEAL_TYPE_BUY = 0
    DEAL_TYPE_SELL = 1
    DEAL_ENTRY_IN = 0
    DEAL_ENTRY_OUT = 1
    DEAL_ENTRY_OUT_BY = 3
    ORDER_FILLING_FOK = 0
    ORDER_TIME_GTC = 0
    TRADE_ACTION_DEAL = 1
    TRADE_ACTION_SLTP = 6
    TRADE_RETCODE_DONE = 10009

    def __init__(self):
        self.positions = []
        self.pending_orders = []
        self.deals = []
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
        return SimpleNamespace(equity=4000.0)

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

    def history_deals_get(self, start, end):
        return self.deals

    def orders_get(self):
        return self.pending_orders

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
        return SimpleNamespace(retcode=10009, order=123, price=request["price"])


class ExecutionRiskTest(unittest.TestCase):
    def test_pending_exposure_blocks_all_entry_paths_account_wide(self):
        # Both manual/automatic entries and DCA eventually use execute_order.
        # Foreign symbol/magic must not be filtered out of the account book.
        for tag in ("V6_MANUAL", "V6_BOT_1_TREND", "DCA_PLUS_L1_BUY"):
            for symbol in ("XAUUSD.G", "EURUSD"):
                with self.subTest(tag=tag, symbol=symbol):
                    mt5 = MockBroker()
                    mt5.pending_orders = [SimpleNamespace(symbol=symbol, magic=999)]
                    result = engine.execute_order(mt5, "XAUUSD.G", {
                        "side": "BUY", "volume": 0.02,
                        "slDistance": 6.8, "tpDistance": 16,
                    }, comment_tag=tag)
                    self.assertFalse(result["ok"])
                    self.assertIn("pending orders", result["message"])
                    self.assertEqual(mt5.sent, [])

    def test_unknown_or_malformed_pending_inventory_never_means_empty(self):
        for inventory in (None, False, 0, "", {}, "unavailable"):
            with self.subTest(inventory=inventory):
                mt5 = MockBroker()
                mt5.pending_orders = inventory
                result = engine.execute_order(mt5, "XAUUSD.G", {
                    "side": "SELL", "volume": 0.02,
                    "slDistance": 6.8, "tpDistance": 16,
                })
                self.assertFalse(result["ok"])
                self.assertIn("Cannot verify broker pending orders", result["message"])
                self.assertEqual(mt5.sent, [])

    def test_missing_or_failing_pending_inventory_api_blocks_entry(self):
        for api in (None, mock.Mock(side_effect=RuntimeError("unavailable"))):
            mt5 = MockBroker()
            mt5.orders_get = api
            result = engine.execute_order(mt5, "XAUUSD.G", {
                "side": "BUY", "volume": 0.02,
                "slDistance": 6.8, "tpDistance": 16,
            })
            self.assertFalse(result["ok"])
            self.assertEqual(mt5.sent, [])

    def test_verified_empty_pending_tuple_allows_protected_entry(self):
        mt5 = MockBroker()
        mt5.pending_orders = ()
        result = engine.execute_order(mt5, "XAUUSD.G", {
            "side": "SELL", "volume": 0.02,
            "slDistance": 6.8, "tpDistance": 16,
        })
        self.assertTrue(result["ok"], result)
        self.assertEqual(len(mt5.sent), 1)

    def test_above_risk_budget_is_rejected_before_send(self):
        mt5 = MockBroker()
        result = engine.execute_order(mt5, "XAUUSD.G", {
            "side": "BUY", "volume": 0.05, "slDistance": 6.8, "tpDistance": 16,
            "maxRiskPercent": 0.5
        })
        self.assertFalse(result["ok"])
        self.assertEqual(mt5.sent, [])

    def test_daily_account_loss_veto_blocks_order_before_order_send(self):
        mt5 = MockBroker()
        when = int(time.time()) - 60
        mt5.deals = [
            SimpleNamespace(
                time=when, type=0, entry=0, position_id=992,
                profit=0.0, commission=0.0, swap=0.0, fee=0.0
            ),
            SimpleNamespace(
                time=when, type=1, entry=1, position_id=992,
                profit=-75.0, commission=0.0, swap=0.0, fee=0.0
            ),
        ]
        # Broker equity 4000, reconstructed opening equity 4075.00:
        # 2% daily limit 81.50, leaving only 6.50 for new SL risk.
        result = engine.execute_order(mt5, "XAUUSD.G", {
            "side": "BUY", "volume": 0.02,
            "slDistance": 6.8, "tpDistance": 16,
            "maxRiskPercent": 0.5,
        })
        self.assertFalse(result["ok"])
        self.assertIn("daily account loss", result["message"])
        self.assertEqual(mt5.sent, [])

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

    def test_high_spread_is_rejected(self):
        mt5 = MockBroker()
        mt5.asks = 4002.0
        result = engine.execute_order(mt5, "XAUUSD.G", {
            "side": "BUY", "volume": 0.02, "slDistance": 6.8, "tpDistance": 16
        })
        self.assertFalse(result["ok"])
        self.assertEqual(len(mt5.sent), 0)

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


class SecureStdinTransportTest(unittest.TestCase):
    def test_valid_stdin_json_object(self):
        with mock.patch.object(sys, "argv", ["mt5-direct-probe.py"]):
            with mock.patch.object(sys, "stdin", io.StringIO('{"action":"probe","brokerSymbol":"XAUUSD.G"}\n')):
                cfg, error = engine._read_stdin_payload()
        self.assertIsNone(error)
        self.assertEqual(cfg["action"], "probe")
        self.assertEqual(cfg["brokerSymbol"], "XAUUSD.G")

    def test_command_line_payload_is_rejected_without_reading_stdin(self):
        fake_stdin = io.StringIO('{"action":"order"}\n')
        with mock.patch.object(sys, "argv", ["mt5-direct-probe.py", '{"password":"sensitive"}']):
            with mock.patch.object(sys, "stdin", fake_stdin):
                cfg, error = engine._read_stdin_payload()
        self.assertIsNone(cfg)
        self.assertEqual(error, "CLI_PAYLOAD_FORBIDDEN")
        self.assertEqual(fake_stdin.tell(), 0)

    def test_invalid_and_oversized_stdin_fail_closed(self):
        invalid_cases = [
            ("", "STDIN_CONFIG_REQUIRED"),
            ("not-json\n", "STDIN_INVALID_JSON"),
            ("[]\n", "STDIN_OBJECT_REQUIRED"),
            ('{"value":"' + "a" * 1_048_577 + '"}', "STDIN_CONFIG_TOO_LARGE"),
        ]
        for payload, expected in invalid_cases:
            with self.subTest(expected=expected):
                with mock.patch.object(sys, "argv", ["mt5-direct-probe.py"]):
                    with mock.patch.object(sys, "stdin", io.StringIO(payload)):
                        cfg, error = engine._read_stdin_payload()
                self.assertIsNone(cfg)
                self.assertEqual(error, expected)


if __name__ == "__main__":
    unittest.main()
