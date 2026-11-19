import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from mt5_bridge.config import Settings
from mt5_bridge.ledger import IdempotencyLedger
from mt5_bridge.mt5_gateway import Mt5Gateway


class FakeDealHistoryMt5:
    ACCOUNT_TRADE_MODE_DEMO = 0
    ACCOUNT_TRADE_MODE_CONTEST = 1
    DEAL_TYPE_BUY = 0
    DEAL_TYPE_SELL = 1
    DEAL_ENTRY_IN = 0
    DEAL_ENTRY_OUT = 1
    DEAL_ENTRY_INOUT = 2
    DEAL_ENTRY_OUT_BY = 3

    def __init__(self, broker_symbol: str):
        self.broker_symbol = broker_symbol

    def terminal_info(self):
        return SimpleNamespace(trade_allowed=True)

    def account_info(self):
        return SimpleNamespace(
            login=123456,
            trade_mode=self.ACCOUNT_TRADE_MODE_DEMO,
            trade_allowed=True,
            trade_expert=True,
            server="Demo",
        )

    def last_error(self):
        return (0, "ok")

    def version(self):
        return (500, 5735, "test")

    def history_deals_get(self, _start, _end):
        return (
            SimpleNamespace(
                ticket=3001,
                order=2001,
                position_id=1001,
                symbol=self.broker_symbol,
                type=self.DEAL_TYPE_BUY,
                entry=self.DEAL_ENTRY_IN,
                volume=0.03,
                price=2400.0,
                profit=0.0,
                commission=-0.15,
                swap=0.0,
                fee=0.0,
                magic=270715,
                comment="phase7c-trend",
                time=1788000000,
                time_msc=1788000000000,
            ),
        )


def settings(path: Path, broker_symbol: str) -> Settings:
    return Settings(
        host="127.0.0.1",
        port=8765,
        api_key="0123456789abcdef",
        trading_enabled=False,
        allow_real_account=False,
        allowed_logins=frozenset({123456}),
        terminal_path=None,
        login=None,
        password=None,
        server=None,
        portable=False,
        initialize_timeout_ms=60000,
        fail_startup_if_disconnected=True,
        symbol_map={"XAUUSD": broker_symbol},
        max_spread_points={"XAUUSD": 50},
        magic_number=270715,
        deviation_points=50,
        ledger_path=path,
        log_level="INFO",
    )


class DealHistoryCanonicalSymbolTests(unittest.TestCase):
    def assert_canonical_deal_symbol(self, broker_symbol: str):
        with tempfile.TemporaryDirectory() as directory:
            ledger_path = Path(directory) / "ledger.sqlite3"
            ledger = IdempotencyLedger(ledger_path)
            gateway = Mt5Gateway(
                settings(ledger_path, broker_symbol),
                ledger,
                FakeDealHistoryMt5(broker_symbol),
            )

            deals = gateway.deals(
                1787990000000,
                1788010000000,
                "XAUUSD",
            )

            self.assertEqual(len(deals), 1)
            self.assertEqual(deals[0]["symbol"], "XAUUSD")
            ledger.close()

    def test_live_xauusd_dot_g_deal_history_returns_canonical_xauusd(self):
        self.assert_canonical_deal_symbol("XAUUSD.G")

    def test_demo_xauusd_deal_history_keeps_canonical_xauusd(self):
        self.assert_canonical_deal_symbol("XAUUSD")


if __name__ == "__main__":
    unittest.main()
