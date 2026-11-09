import json
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

from mt5_bridge.config import Settings
from mt5_bridge.errors import BridgeError
from mt5_bridge.guarded_gateway import GuardedMt5Gateway
from mt5_bridge.ledger import IdempotencyLedger
from mt5_bridge.live_arm import evaluate_live_arm, profile_fingerprint
from mt5_bridge.models import CloseRequest, ModifyRequest


class RealFakeMt5:
    ACCOUNT_TRADE_MODE_DEMO = 0
    ACCOUNT_TRADE_MODE_CONTEST = 1

    def initialize(self, **_):
        return True

    def shutdown(self):
        return None

    def last_error(self):
        return (0, "ok")

    def version(self):
        return (500, 5735, "test")

    def terminal_info(self):
        return SimpleNamespace(trade_allowed=True)

    def account_info(self):
        return SimpleNamespace(
            login=900001,
            trade_mode=2,
            trade_allowed=True,
            trade_expert=True,
            server="Broker-Live",
        )


class ManagedRiskFakeMt5(RealFakeMt5):
    TRADE_ACTION_DEAL = 1
    TRADE_ACTION_REMOVE = 8
    TRADE_ACTION_SLTP = 6
    ORDER_TYPE_BUY = 0
    ORDER_TYPE_SELL = 1
    POSITION_TYPE_BUY = 0
    POSITION_TYPE_SELL = 1
    ORDER_TIME_GTC = 0
    ORDER_FILLING_IOC = 1
    TRADE_RETCODE_DONE = 10009
    TRADE_RETCODE_DONE_PARTIAL = 10010
    TRADE_RETCODE_NO_CHANGES = 10025

    def __init__(self, side: str = "BUY") -> None:
        self.sent: list[dict] = []
        self.position = SimpleNamespace(
            ticket=321,
            symbol="XAUUSD.G",
            type=self.POSITION_TYPE_BUY if side == "BUY" else self.POSITION_TYPE_SELL,
            volume=0.12,
            price_open=4610.0,
            sl=4604.0 if side == "BUY" else 4616.0,
            tp=0.0,
            profit=0.0,
            swap=0.0,
            time=1,
            time_msc=1000,
        )

    def positions_get(self, ticket=None, symbol=None):
        if ticket is not None and int(ticket) != int(self.position.ticket):
            return []
        if symbol is not None and symbol != self.position.symbol:
            return []
        return [self.position]

    def symbol_info(self, _symbol):
        return SimpleNamespace(filling_mode=2, trade_exemode=0)

    def symbol_info_tick(self, _symbol):
        return SimpleNamespace(bid=4618.0, ask=4618.1)

    def order_send(self, payload):
        self.sent.append(dict(payload))
        return SimpleNamespace(retcode=self.TRADE_RETCODE_DONE, comment="done")


def make_settings(ledger_path: Path, arm_path: Path, compatibility: bool = True) -> Settings:
    return Settings(
        host="127.0.0.1",
        port=8765,
        api_key="0123456789abcdef",
        trading_enabled=True,
        allow_real_account=True,
        allowed_logins=frozenset({900001}),
        terminal_path=r"C:\MT5-LIVE\terminal64.exe",
        login=900001,
        password=None,
        server="Broker-Live",
        portable=False,
        initialize_timeout_ms=60000,
        fail_startup_if_disconnected=True,
        symbol_map={"XAUUSD": "XAUUSD.G"},
        max_spread_points={"XAUUSD": 65},
        magic_number=270715,
        deviation_points=50,
        ledger_path=ledger_path,
        log_level="INFO",
        account_mode="LIVE",
        live_arm_state_path=arm_path,
        live_compatibility_enabled=compatibility,
    )


def write_valid_arm(path: Path, session_id: str, *, expires_delta_ms: int = 120000) -> None:
    now = int(time.time() * 1000)
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "armed": True,
                "accountMode": "LIVE",
                "bridgeSessionId": session_id,
                "accountLogin": 900001,
                "server": "Broker-Live",
                "profileFingerprint": profile_fingerprint(
                    "LIVE", 900001, "Broker-Live", r"C:\MT5-LIVE\terminal64.exe"
                ),
                "armedAt": now,
                "expiresAt": now + expires_delta_ms,
            }
        ),
        encoding="utf-8",
    )


def write_session_arm(path: Path, session_id: str) -> None:
    path.write_text(
        json.dumps(
            {
                "version": 2,
                "armed": True,
                "scope": "BRIDGE_SESSION",
                "accountMode": "LIVE",
                "bridgeSessionId": session_id,
                "accountLogin": 900001,
                "server": "Broker-Live",
                "profileFingerprint": profile_fingerprint(
                    "LIVE", 900001, "Broker-Live", r"C:\MT5-LIVE\terminal64.exe"
                ),
                "armedAt": int(time.time() * 1000),
            }
        ),
        encoding="utf-8",
    )


class LiveArmTests(unittest.TestCase):
    def test_compatibility_flag_alone_is_not_an_arm(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            arm = root / "live-arm.json"
            decision = evaluate_live_arm(
                path=arm,
                bridge_session_id="session-a",
                configured_account_mode="LIVE",
                account_login=900001,
                account_server="Broker-Live",
                terminal_path=r"C:\MT5-LIVE\terminal64.exe",
                compatibility_enabled=True,
            )
            self.assertFalse(decision.armed)
            self.assertEqual(decision.reason, "ARM_FILE_MISSING")

    def test_missing_corrupt_expired_and_mismatched_legacy_arm_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            arm = root / "live-arm.json"
            common = dict(
                path=arm,
                bridge_session_id="session-a",
                configured_account_mode="LIVE",
                account_login=900001,
                account_server="Broker-Live",
                terminal_path=r"C:\MT5-LIVE\terminal64.exe",
                compatibility_enabled=True,
            )

            arm.write_text("{broken", encoding="utf-8")
            self.assertEqual(evaluate_live_arm(**common).reason, "ARM_FILE_INVALID_JSON")

            write_valid_arm(arm, "wrong-session")
            self.assertEqual(evaluate_live_arm(**common).reason, "ARM_BRIDGE_SESSION_MISMATCH")

            write_valid_arm(arm, "session-a", expires_delta_ms=-1)
            self.assertEqual(evaluate_live_arm(**common).reason, "ARM_EXPIRED")

            write_valid_arm(arm, "session-a")
            wrong_login = {**common, "account_login": 900002}
            self.assertEqual(evaluate_live_arm(**wrong_login).reason, "ARM_LOGIN_MISMATCH")

    def test_session_arm_remains_valid_for_same_bridge_session_without_ttl(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            arm = root / "live-arm.json"
            common = dict(
                path=arm,
                configured_account_mode="LIVE",
                account_login=900001,
                account_server="Broker-Live",
                terminal_path=r"C:\MT5-LIVE\terminal64.exe",
                compatibility_enabled=True,
            )

            write_session_arm(arm, "session-a")
            decision = evaluate_live_arm(bridge_session_id="session-a", **common)
            self.assertTrue(decision.armed)
            self.assertEqual(decision.reason, "ARMED")
            self.assertEqual(decision.state.get("scope"), "BRIDGE_SESSION")

            restarted = evaluate_live_arm(bridge_session_id="session-b", **common)
            self.assertFalse(restarted.armed)
            self.assertEqual(restarted.reason, "ARM_BRIDGE_SESSION_MISMATCH")

    def test_exact_current_legacy_arm_passes_and_bridge_restart_invalidates_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            arm = root / "live-arm.json"
            ledger_path = root / "ledger.sqlite3"

            first_ledger = IdempotencyLedger(ledger_path)
            first = GuardedMt5Gateway(
                make_settings(ledger_path, arm), first_ledger, RealFakeMt5()
            )
            self.assertTrue(first.start())

            with self.assertRaises(BridgeError) as blocked:
                first._require_trading()
            self.assertEqual(blocked.exception.code, "LIVE_EXECUTION_DISARMED")

            write_valid_arm(arm, first.bridge_session_id)
            first._require_trading()
            health = first.health()
            self.assertTrue(health["liveExecutionArmed"])
            self.assertEqual(health["liveArmStatus"], "ARMED")
            first.stop()

            second_ledger = IdempotencyLedger(root / "ledger-2.sqlite3")
            second = GuardedMt5Gateway(
                make_settings(root / "ledger-2.sqlite3", arm),
                second_ledger,
                RealFakeMt5(),
            )
            self.assertTrue(second.start())
            with self.assertRaises(BridgeError) as stale:
                second._require_trading()
            self.assertEqual(stale.exception.code, "LIVE_EXECUTION_DISARMED")
            self.assertEqual(second.health()["liveArmReason"], "ARM_BRIDGE_SESSION_MISMATCH")
            second.stop()

    def test_disarmed_live_allows_partial_close_to_reduce_exposure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            arm = root / "missing-live-arm.json"
            ledger_path = root / "ledger.sqlite3"
            mt5 = ManagedRiskFakeMt5("BUY")
            gateway = GuardedMt5Gateway(make_settings(ledger_path, arm), IdempotencyLedger(ledger_path), mt5)
            self.assertTrue(gateway.start())
            try:
                try:
                    response = gateway.close_position(
                        "321",
                        CloseRequest(volume=0.04, commandId="reduce-risk-close"),
                    )
                except BridgeError as exc:
                    self.fail(f"partial close must remain available while DISARMED, got {exc.code}")

                self.assertTrue(response["success"])
                self.assertEqual(len(mt5.sent), 1)
                self.assertAlmostEqual(mt5.sent[0]["volume"], 0.04)
                self.assertEqual(mt5.sent[0]["position"], 321)
            finally:
                gateway.stop()

    def test_disarmed_live_allows_break_even_stop_but_blocks_looser_stop(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            arm = root / "missing-live-arm.json"
            ledger_path = root / "ledger.sqlite3"
            mt5 = ManagedRiskFakeMt5("BUY")
            gateway = GuardedMt5Gateway(make_settings(ledger_path, arm), IdempotencyLedger(ledger_path), mt5)
            self.assertTrue(gateway.start())
            try:
                try:
                    response = gateway.modify_position(
                        "321",
                        ModifyRequest(stopLoss=4610.0, commandId="move-to-be"),
                    )
                except BridgeError as exc:
                    self.fail(f"BE/tighter stop must remain available while DISARMED, got {exc.code}")

                self.assertTrue(response["success"])
                self.assertEqual(len(mt5.sent), 1)
                self.assertAlmostEqual(mt5.sent[0]["sl"], 4610.0)

                with self.assertRaises(BridgeError) as loosened:
                    gateway.modify_position(
                        "321",
                        ModifyRequest(stopLoss=4600.0, commandId="loosen-stop"),
                    )
                self.assertEqual(loosened.exception.code, "LIVE_RISK_INCREASE_BLOCKED")
                self.assertEqual(len(mt5.sent), 1)
            finally:
                gateway.stop()

    def test_demo_settings_do_not_require_live_arm(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            decision = evaluate_live_arm(
                path=root / "missing.json",
                bridge_session_id="demo-session",
                configured_account_mode="DEMO",
                account_login=123456,
                account_server="Demo",
                terminal_path=r"C:\MT5-DEMO\terminal64.exe",
                compatibility_enabled=False,
            )
            self.assertFalse(decision.armed)
            self.assertEqual(decision.reason, "LIVE_NOT_SELECTED")


if __name__ == "__main__":
    unittest.main()
