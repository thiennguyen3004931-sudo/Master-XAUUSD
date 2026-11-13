import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

from mt5_bridge.config import Settings
from mt5_bridge.ledger import IdempotencyLedger
from mt5_bridge.models import ModifyRequest, OrderRequest
from mt5_bridge.mt5_gateway import Mt5Gateway


class FakeMt5:
    ACCOUNT_TRADE_MODE_DEMO = 0
    ACCOUNT_TRADE_MODE_CONTEST = 1
    POSITION_TYPE_BUY = 0
    POSITION_TYPE_SELL = 1
    ORDER_TYPE_BUY = 0
    ORDER_TYPE_SELL = 1
    ORDER_TYPE_BUY_LIMIT = 2
    ORDER_TYPE_SELL_LIMIT = 3
    ORDER_TYPE_BUY_STOP = 4
    ORDER_TYPE_SELL_STOP = 5
    TRADE_ACTION_DEAL = 1
    TRADE_ACTION_PENDING = 5
    TRADE_ACTION_SLTP = 6
    TRADE_ACTION_REMOVE = 8
    ORDER_FILLING_FOK = 0
    ORDER_FILLING_IOC = 1
    ORDER_FILLING_RETURN = 2
    SYMBOL_FILLING_FOK = 1
    SYMBOL_FILLING_IOC = 2
    SYMBOL_TRADE_EXECUTION_MARKET = 2
    ORDER_TIME_GTC = 0
    ORDER_TIME_DAY = 1
    ORDER_TIME_SPECIFIED = 2
    TRADE_RETCODE_PLACED = 10008
    TRADE_RETCODE_DONE = 10009
    TRADE_RETCODE_DONE_PARTIAL = 10010
    TRADE_RETCODE_NO_CHANGES = 10025

    def __init__(self, trade_mode=0, bid=2399.9, ask=2400.0):
        self.send_calls = 0
        self.check_calls = 0
        self.position = None
        self.trade_mode = trade_mode
        self.bid = bid
        self.ask = ask

    def initialize(self, **_): return True
    def shutdown(self): return None
    def last_error(self): return (0, "ok")
    def version(self): return (500, 5735, "test")
    def terminal_info(self): return SimpleNamespace(trade_allowed=True)
    def account_info(self):
        return SimpleNamespace(login=123456, trade_mode=self.trade_mode, trade_allowed=True, trade_expert=True, server="Demo")
    def symbol_select(self, _symbol, _select): return True
    def symbol_info(self, symbol):
        return SimpleNamespace(symbol=symbol, visible=True, trade_tick_size=0.01, point=0.01, trade_tick_value=0.1, trade_tick_value_profit=0.1, trade_tick_value_loss=0.1, trade_contract_size=100.0, digits=2,
            volume_min=0.01, volume_max=100.0, volume_step=0.01, trade_stops_level=10,
            trade_freeze_level=5, filling_mode=3, trade_exemode=2)
    def symbol_info_tick(self, _symbol):
        return SimpleNamespace(bid=self.bid, ask=self.ask, time=1700000000, time_msc=1700000000000)
    def order_calc_profit(
        self,
        order_type,
        symbol,
        volume,
        price_open,
        price_close,
    ):
        direction = 1.0 if int(order_type) == int(self.ORDER_TYPE_BUY) else -1.0
        return (
            direction
            * (float(price_close) - float(price_open))
            * 100.0
            * float(volume)
        )

    def order_check(self, request):
        self.check_calls += 1
        return SimpleNamespace(retcode=0, comment="ok", request=request)
    def order_send(self, request):
        self.send_calls += 1
        self.position = SimpleNamespace(ticket=2001, symbol=request.get("symbol", "XAUUSD"), type=0,
            volume=request.get("volume", 0.2), price_open=2400.0, sl=request.get("sl", 2395.0),
            tp=request.get("tp", 2411.0), profit=0.0, swap=0.0, time=1700000000, time_msc=1700000000000,
            magic=request.get("magic", 0), comment=request.get("comment", ""))
        return SimpleNamespace(retcode=10009, order=1001, deal=3001, price=2400.0,
            volume=request.get("volume", 0.2), comment="done")
    def positions_get(self, symbol=None, ticket=None):
        if self.position is None: return ()
        if symbol is not None and self.position.symbol != symbol: return ()
        if ticket is not None and self.position.ticket != ticket: return ()
        return (self.position,)


class CandleFakeMt5(FakeMt5):
    TIMEFRAME_M1 = 1
    TIMEFRAME_M5 = 5
    TIMEFRAME_M15 = 15
    TIMEFRAME_M30 = 30
    TIMEFRAME_H1 = 60
    TIMEFRAME_H4 = 240
    TIMEFRAME_D1 = 1440

    def __init__(self):
        super().__init__()
        self.copy_rates_calls = 0
        self.copy_rates_requested_counts = []

    def copy_rates_from_pos(self, _symbol, timeframe, _start_pos, count):
        self.copy_rates_calls += 1
        self.copy_rates_requested_counts.append(count)
        duration_seconds = {
            self.TIMEFRAME_M1: 60,
            self.TIMEFRAME_M5: 5 * 60,
            self.TIMEFRAME_M15: 15 * 60,
            self.TIMEFRAME_M30: 30 * 60,
            self.TIMEFRAME_H1: 60 * 60,
            self.TIMEFRAME_H4: 4 * 60 * 60,
            self.TIMEFRAME_D1: 24 * 60 * 60,
        }[timeframe]
        now_seconds = 1_700_000_000
        latest_close = (now_seconds // duration_seconds) * duration_seconds
        first_open = latest_close - duration_seconds * count
        return [
            {
                "time": first_open + duration_seconds * index,
                "open": 2400.0 + index * 0.01,
                "high": 2401.0 + index * 0.01,
                "low": 2399.0 + index * 0.01,
                "close": 2400.5 + index * 0.01,
                "tick_volume": 100 + index,
                "spread": 10,
            }
            for index in range(count)
        ]


class RecoveringFakeMt5(FakeMt5):
    def __init__(self):
        super().__init__()
        self.connected = True
        self.initialize_calls = 0
        self.fail_next_positions = False

    def initialize(self, **_):
        self.initialize_calls += 1
        self.connected = True
        return True

    def shutdown(self):
        self.connected = False

    def last_error(self):
        return (0, "ok") if self.connected else (-10001, "IPC send failed")

    def terminal_info(self):
        return SimpleNamespace(trade_allowed=True) if self.connected else None

    def account_info(self):
        if not self.connected:
            return None
        return super().account_info()

    def positions_get(self, symbol=None, ticket=None):
        if self.fail_next_positions:
            self.fail_next_positions = False
            self.connected = False
            return None
        if not self.connected:
            return None
        return super().positions_get(symbol=symbol, ticket=ticket)


class LostOrderResponseFake(FakeMt5):
    def last_error(self):
        return (-10001, "IPC send failed")

    def order_send(self, _request):
        self.send_calls += 1
        return None


def settings(path: Path):
    return Settings(
        host="127.0.0.1", port=8765, api_key="0123456789abcdef", trading_enabled=True,
        allow_real_account=False, allowed_logins=frozenset({123456}), terminal_path=None,
        login=None, password=None, server=None, portable=False, initialize_timeout_ms=60000,
        fail_startup_if_disconnected=True, symbol_map={"XAUUSD": "XAUUSDm"},
        max_spread_points={"XAUUSD": 50}, magic_number=260806, deviation_points=50,
        ledger_path=path, log_level="INFO")


class GatewayTests(unittest.TestCase):
    def test_health_reconnects_after_terminal_ipc_is_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            fake = RecoveringFakeMt5()
            ledger = IdempotencyLedger(Path(directory) / "ledger.sqlite3")
            gateway = Mt5Gateway(settings(Path(directory) / "ledger.sqlite3"), ledger, fake)
            self.assertTrue(gateway.start())
            fake.connected = False

            health = gateway.health()

            self.assertTrue(health["connected"])
            self.assertEqual(health["status"], "ok")
            self.assertEqual(health["reconnectCount"], 1)
            self.assertIsNotNone(health["lastReconnectAt"])
            self.assertFalse(health["reconnecting"])
            self.assertEqual(fake.initialize_calls, 2)
            ledger.close()

    def test_read_retries_once_after_ipc_send_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            fake = RecoveringFakeMt5()
            ledger = IdempotencyLedger(Path(directory) / "ledger.sqlite3")
            gateway = Mt5Gateway(settings(Path(directory) / "ledger.sqlite3"), ledger, fake)
            self.assertTrue(gateway.start())
            fake.fail_next_positions = True

            positions = gateway.positions()

            self.assertEqual(positions, [])
            self.assertEqual(gateway.reconnect_count, 1)
            self.assertEqual(fake.initialize_calls, 2)
            ledger.close()

    def test_order_send_is_never_retried_after_lost_ipc_response(self):
        with tempfile.TemporaryDirectory() as directory:
            fake = LostOrderResponseFake()
            ledger_path = Path(directory) / "ledger.sqlite3"
            ledger = IdempotencyLedger(ledger_path)
            gateway = Mt5Gateway(settings(ledger_path), ledger, fake)
            self.assertTrue(gateway.start())
            request = OrderRequest(
                symbol="XAUUSD",
                side="BUY",
                orderType="MARKET",
                timeInForce="IOC",
                volume=0.2,
                requestedPrice=2400,
                stopLoss=2395,
                takeProfit=2411,
                deviationPoints=50,
                magicNumber=260806,
                comment="lost-response-test",
                clientOrderId="lost-response-client",
                idempotencyKey="lost-response-key",
            )

            with self.assertRaisesRegex(Exception, "order_send failed"):
                gateway.place_order(request)

            self.assertEqual(fake.send_calls, 1)
            self.assertEqual(gateway.reconnect_count, 0)
            ledger.close()

    def test_take_profit_only_patch_preserves_live_broker_stop_loss(self):
        with tempfile.TemporaryDirectory() as directory:
            fake = FakeMt5()
            fake.position = SimpleNamespace(
                ticket=305091979,
                symbol="XAUUSDm",
                type=fake.POSITION_TYPE_SELL,
                volume=0.12,
                price_open=4340.87,
                sl=4347.52,
                tp=0.0,
                profit=-3.96,
                swap=0.0,
                time=1700000000,
                time_msc=1700000000000,
                magic=260806,
                comment="xau:test",
            )
            ledger_path = Path(directory) / "ledger.sqlite3"
            ledger = IdempotencyLedger(ledger_path)
            gateway = Mt5Gateway(settings(ledger_path), ledger, fake)
            self.assertTrue(gateway.start())

            response = gateway.modify_position(
                "305091979",
                ModifyRequest(
                    takeProfit=4320.82,
                    commandId="phase7c-fixed-tp-broker-trend-305091979",
                ),
            )

            self.assertTrue(response["success"])
            self.assertEqual(fake.send_calls, 1)
            self.assertAlmostEqual(fake.position.sl, 4347.52)
            self.assertAlmostEqual(fake.position.tp, 4320.82)
            ledger.close()

    def test_closed_candles_reuse_bar_aligned_cache_without_reloading_mt5_history(self):
        with tempfile.TemporaryDirectory() as directory:
            fake = CandleFakeMt5()
            ledger_path = Path(directory) / "ledger.sqlite3"
            ledger = IdempotencyLedger(ledger_path)
            gateway = Mt5Gateway(settings(ledger_path), ledger, fake)
            self.assertTrue(gateway.start())

            with patch("mt5_bridge.mt5_gateway.time.time", return_value=1_700_000_000.0):
                first = gateway.candles("XAUUSD", "M15", 320)

                class LockMustNotBeTouched:
                    def acquire(self, *_, **__):
                        raise AssertionError("fresh candle cache hit touched the MT5 gateway lock")

                    def release(self):
                        raise AssertionError("fresh candle cache hit touched the MT5 gateway lock")

                gateway._lock = LockMustNotBeTouched()
                second = gateway.candles("XAUUSD", "M15", 320)
                smaller = gateway.candles("XAUUSD", "M15", 100)

            self.assertEqual(len(first), 320)
            self.assertEqual(second, first)
            self.assertEqual(smaller, first[-100:])
            self.assertEqual(fake.copy_rates_calls, 1)
            ledger.close()

    def test_closed_candle_refresh_uses_small_incremental_tail(self):
        with tempfile.TemporaryDirectory() as directory:
            fake = CandleFakeMt5()
            ledger_path = Path(directory) / "ledger.sqlite3"
            ledger = IdempotencyLedger(ledger_path)
            gateway = Mt5Gateway(settings(ledger_path), ledger, fake)
            self.assertTrue(gateway.start())

            with patch("mt5_bridge.mt5_gateway.time.time", return_value=1_700_000_000.0):
                first = gateway.candles("XAUUSD", "M15", 320)

            # Move just past the next M15 close. The existing cache is recent
            # enough to advance incrementally instead of reloading 320 bars.
            with patch("mt5_bridge.mt5_gateway.time.time", return_value=1_700_000_102.0):
                refreshed = gateway.candles("XAUUSD", "M15", 320)

            self.assertEqual(len(first), 320)
            self.assertEqual(len(refreshed), 320)
            self.assertEqual(fake.copy_rates_calls, 2)
            self.assertEqual(fake.copy_rates_requested_counts, [320, 8])
            ledger.close()

    def test_expired_candle_cache_returns_recent_snapshot_when_mt5_lock_is_busy(self):
        with tempfile.TemporaryDirectory() as directory:
            fake = CandleFakeMt5()
            ledger_path = Path(directory) / "ledger.sqlite3"
            ledger = IdempotencyLedger(ledger_path)
            gateway = Mt5Gateway(settings(ledger_path), ledger, fake)
            self.assertTrue(gateway.start())

            with patch("mt5_bridge.mt5_gateway.time.time", return_value=1_700_000_000.0):
                first = gateway.candles("XAUUSD", "M15", 320)

            class BusyLock:
                def acquire(self, *_, **kwargs):
                    self.blocking = kwargs.get("blocking")
                    return False

                def release(self):
                    raise AssertionError("busy lock must not be released when acquire returned false")

            busy_lock = BusyLock()
            gateway._lock = busy_lock

            # The cached M15 bar expires about 101 seconds after the first
            # request in this fixture, but it is still well inside the
            # one-timeframe stale-on-busy safety window.
            with patch("mt5_bridge.mt5_gateway.time.time", return_value=1_700_000_102.0):
                stale = gateway.candles("XAUUSD", "M15", 320)

            self.assertEqual(stale, first)
            self.assertFalse(busy_lock.blocking)
            self.assertEqual(fake.copy_rates_calls, 1)
            ledger.close()

    def test_symbol_spec_exposes_broker_risk_values(self):
        with tempfile.TemporaryDirectory() as directory:
            fake = FakeMt5()
            ledger_path = Path(directory) / "ledger.sqlite3"
            ledger = IdempotencyLedger(ledger_path)
            gateway = Mt5Gateway(settings(ledger_path), ledger, fake)
            self.assertTrue(gateway.start())

            spec = gateway.symbol_spec("XAUUSD")

            self.assertEqual(spec["tickSize"], 0.01)
            self.assertEqual(spec["point"], 0.01)
            self.assertEqual(spec["tickValuePerLot"], 0.1)
            self.assertEqual(spec["tickValueProfitPerLot"], 0.1)
            self.assertEqual(spec["tickValueLossPerLot"], 0.1)
            self.assertEqual(spec["contractSize"], 100.0)
            self.assertEqual(spec["minVolume"], 0.01)
            self.assertEqual(spec["volumeStep"], 0.01)

            ledger.close()

    def test_order_send_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            fake = FakeMt5()
            ledger = IdempotencyLedger(Path(directory) / "ledger.sqlite3")
            gateway = Mt5Gateway(settings(Path(directory) / "ledger.sqlite3"), ledger, fake)
            self.assertTrue(gateway.start())
            request = OrderRequest(symbol="XAUUSD", side="BUY", orderType="MARKET", timeInForce="IOC",
                volume=0.2, requestedPrice=2400, stopLoss=2395, takeProfit=2411,
                deviationPoints=50, magicNumber=260806, comment="test", clientOrderId="client-1",
                idempotencyKey="same-key")
            first = gateway.place_order(request)
            second = gateway.place_order(request)
            self.assertTrue(first["accepted"])
            self.assertTrue(second["idempotentReplay"])
            self.assertEqual(fake.send_calls, 1)
            ledger.close()

    def test_excessive_spread_is_blocked_before_order_check_and_send(self):
        with tempfile.TemporaryDirectory() as directory:
            # point=0.01, so a 0.66 price spread = 66 broker points.
            # Configured maximum is 50 points.
            fake = FakeMt5(bid=2399.34, ask=2400.00)
            ledger = IdempotencyLedger(Path(directory) / "ledger.sqlite3")
            gateway = Mt5Gateway(settings(Path(directory) / "ledger.sqlite3"), ledger, fake)
            gateway.start()
            request = OrderRequest(
                symbol="XAUUSD",
                side="BUY",
                orderType="MARKET",
                timeInForce="IOC",
                volume=0.01,
                requestedPrice=2400,
                stopLoss=2395,
                takeProfit=2411,
                deviationPoints=50,
                magicNumber=260806,
                comment="spread-guard-test",
                clientOrderId="spread-guard-client",
                idempotencyKey="spread-guard-key",
            )

            with self.assertRaisesRegex(Exception, "Spread too wide"):
                gateway.place_order(request)

            self.assertEqual(fake.check_calls, 0)
            self.assertEqual(fake.send_calls, 0)
            ledger.close()

    def test_market_fill_position_exposes_exact_bot_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            fake = FakeMt5()
            ledger = IdempotencyLedger(Path(directory) / "ledger.sqlite3")
            gateway = Mt5Gateway(settings(Path(directory) / "ledger.sqlite3"), ledger, fake)
            self.assertTrue(gateway.start())
            request = OrderRequest(
                symbol="XAUUSD", side="BUY", orderType="MARKET", timeInForce="IOC",
                volume=0.2, requestedPrice=2400, stopLoss=2395, takeProfit=2411,
                deviationPoints=50, magicNumber=260806, comment="test",
                clientOrderId="p7b-im-1789998340000-BUY", idempotencyKey="provenance-key")

            response = gateway.place_order(request)

            self.assertTrue(response["accepted"])
            self.assertIsNotNone(response["position"])
            self.assertEqual(response["position"]["magic"], 260806)
            self.assertEqual(
                response["position"]["comment"],
                Mt5Gateway._comment(request.clientOrderId),
            )
            ledger.close()

    def test_comment_is_ascii_and_broker_safe_length(self):
        value = "gate2b-orphan-cleanup-1786088035660-\u2603"
        comment = Mt5Gateway._comment(value)

        self.assertLessEqual(len(comment), 28)
        self.assertTrue(comment.isascii())
        self.assertTrue(comment.startswith("xau:"))
        self.assertNotIn("\u2603", comment)

    def test_symbol_mapping_and_quote(self):
        with tempfile.TemporaryDirectory() as directory:
            fake = FakeMt5()
            ledger = IdempotencyLedger(Path(directory) / "ledger.sqlite3")
            gateway = Mt5Gateway(settings(Path(directory) / "ledger.sqlite3"), ledger, fake)
            gateway.start()
            quote = gateway.quote("XAUUSD")
            self.assertEqual(quote["brokerSymbol"], "XAUUSDm")
            self.assertEqual(quote["ask"], 2400.0)
            ledger.close()

    def test_real_account_is_blocked_by_default(self):
        with tempfile.TemporaryDirectory() as directory:
            fake = FakeMt5(trade_mode=2)
            ledger = IdempotencyLedger(Path(directory) / "ledger.sqlite3")
            gateway = Mt5Gateway(settings(Path(directory) / "ledger.sqlite3"), ledger, fake)
            gateway.start()
            request = OrderRequest(symbol="XAUUSD", side="BUY", orderType="MARKET", timeInForce="IOC",
                volume=0.2, requestedPrice=2400, stopLoss=2395, takeProfit=2411,
                deviationPoints=50, magicNumber=260806, comment="test", clientOrderId="client-real",
                idempotencyKey="real-key")
            with self.assertRaisesRegex(Exception, "Real-account trading"):
                gateway.place_order(request)
            self.assertEqual(fake.send_calls, 0)
            ledger.close()


if __name__ == "__main__":
    unittest.main()
