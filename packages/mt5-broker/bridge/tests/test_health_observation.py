import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from mt5_bridge.config import Settings
from mt5_bridge.guarded_gateway import GuardedMt5Gateway
from mt5_bridge.ledger import IdempotencyLedger
from mt5_bridge.mt5_gateway import Mt5Gateway


class RecoveringHealthFakeMt5:
    ACCOUNT_TRADE_MODE_DEMO = 0
    ACCOUNT_TRADE_MODE_CONTEST = 1

    def __init__(self):
        self.connected = True
        self.initialize_calls = 0

    def initialize(self, **_):
        self.initialize_calls += 1
        self.connected = True
        return True

    def shutdown(self):
        self.connected = False

    def last_error(self):
        return (0, "ok") if self.connected else (-10001, "IPC send failed")

    def version(self):
        return (500, 5735, "test")

    def terminal_info(self):
        return SimpleNamespace(trade_allowed=True) if self.connected else None

    def account_info(self):
        if not self.connected:
            return None
        return SimpleNamespace(
            login=123456,
            trade_mode=self.ACCOUNT_TRADE_MODE_DEMO,
            trade_allowed=True,
            trade_expert=True,
            server="Demo",
        )

    def positions_get(self, **_):
        return () if self.connected else None

    def orders_get(self, **_):
        return () if self.connected else None


def settings(path: Path):
    return Settings(
        host="127.0.0.1",
        port=8765,
        api_key="0123456789abcdef",
        trading_enabled=True,
        allow_real_account=False,
        allowed_logins=frozenset({123456}),
        terminal_path=None,
        login=None,
        password=None,
        server=None,
        portable=False,
        initialize_timeout_ms=60000,
        fail_startup_if_disconnected=True,
        symbol_map={"XAUUSD": "XAUUSDm"},
        max_spread_points={"XAUUSD": 50},
        magic_number=260806,
        deviation_points=50,
        ledger_path=path,
        log_level="INFO",
    )


class HealthObservationTests(unittest.TestCase):
    def test_health_observation_can_disable_reconnect(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger_path = Path(directory) / "ledger.sqlite3"
            fake = RecoveringHealthFakeMt5()
            ledger = IdempotencyLedger(ledger_path)
            gateway = Mt5Gateway(settings(ledger_path), ledger, fake)
            self.assertTrue(gateway.start())
            fake.connected = False

            health = gateway.health(reconnect=False)

            self.assertFalse(health["connected"])
            self.assertEqual(health["status"], "degraded")
            self.assertEqual(health["reconnectCount"], 0)
            self.assertIsNone(health["lastReconnectAt"])
            self.assertTrue(health["reconnecting"])
            self.assertEqual(fake.initialize_calls, 1)
            ledger.close()

    def test_positions_observation_can_disable_reconnect(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger_path = Path(directory) / "ledger.sqlite3"
            fake = RecoveringHealthFakeMt5()
            ledger = IdempotencyLedger(ledger_path)
            gateway = Mt5Gateway(settings(ledger_path), ledger, fake)
            self.assertTrue(gateway.start())
            fake.connected = False

            with self.assertRaisesRegex(Exception, "positions_get failed"):
                gateway.positions("XAUUSD", reconnect=False)

            self.assertEqual(gateway.reconnect_count, 0)
            self.assertEqual(fake.initialize_calls, 1)
            ledger.close()

    def test_pending_orders_observation_can_disable_reconnect(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger_path = Path(directory) / "ledger.sqlite3"
            fake = RecoveringHealthFakeMt5()
            ledger = IdempotencyLedger(ledger_path)
            gateway = GuardedMt5Gateway(settings(ledger_path), ledger, fake)
            self.assertTrue(gateway.start())
            fake.connected = False

            with self.assertRaisesRegex(Exception, "orders_get failed"):
                gateway.pending_orders("XAUUSD", reconnect=False)

            self.assertEqual(gateway.reconnect_count, 0)
            self.assertEqual(fake.initialize_calls, 1)
            ledger.close()


if __name__ == "__main__":
    unittest.main()
