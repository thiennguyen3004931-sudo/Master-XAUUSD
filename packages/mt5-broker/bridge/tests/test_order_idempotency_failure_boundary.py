import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from mt5_bridge.errors import BridgeError
from mt5_bridge.guarded_gateway import GuardedMt5Gateway
from mt5_bridge.ledger import IdempotencyLedger
from mt5_bridge.models import OrderRequest
from mt5_bridge.mt5_gateway import Mt5Gateway
from test_gateway import FakeMt5, settings


class OrderIdempotencyFailureBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "ledger.sqlite3"
        self.ledger = IdempotencyLedger(self.path)
        self.fake = FakeMt5()
        self.gateway = Mt5Gateway(settings(self.path), self.ledger, self.fake)
        self.assertTrue(self.gateway.start())
        self.request = OrderRequest(
            symbol="XAUUSD", side="BUY", orderType="MARKET", timeInForce="IOC",
            volume=0.03, requestedPrice=2400, stopLoss=2395, takeProfit=2411,
            deviationPoints=50, magicNumber=260806, comment="fake-replay-test",
            clientOrderId="fake-client", idempotencyKey="fake-request",
        )

    def tearDown(self):
        self.ledger.close()
        self.directory.cleanup()

    def assert_replay_blocked(self, gateway=None):
        with self.assertRaises(BridgeError) as error:
            (gateway or self.gateway).place_order(self.request)
        self.assertEqual(error.exception.code, "IDEMPOTENCY_IN_PROGRESS")
        self.assertEqual(error.exception.status_code, 425)
        self.assertEqual(self.fake.send_calls, 1)

    def test_accepted_order_is_not_resent_when_ledger_completion_fails(self):
        with patch.object(self.ledger, "complete", side_effect=OSError("simulated disk failure")):
            with self.assertRaises(OSError):
                self.gateway.place_order(self.request)
        self.assert_replay_blocked()

    def test_none_after_broker_acceptance_does_not_unlock_the_request(self):
        original = self.fake.order_send

        def lost_response(payload):
            original(payload)
            return None

        with patch.object(self.fake, "order_send", side_effect=lost_response):
            with self.assertRaisesRegex(BridgeError, "order_send failed"):
                self.gateway.place_order(self.request)
            self.assert_replay_blocked()

    def test_exception_after_broker_acceptance_does_not_unlock_the_request(self):
        original = self.fake.order_send

        def lost_response(payload):
            original(payload)
            raise OSError("simulated IPC response loss")

        with patch.object(self.fake, "order_send", side_effect=lost_response):
            with self.assertRaises(OSError):
                self.gateway.place_order(self.request)
            self.assert_replay_blocked()

    def test_response_decoding_failure_does_not_unlock_the_request(self):
        with patch.object(self.gateway, "_order_result", side_effect=ValueError("simulated malformed result")):
            with self.assertRaises(ValueError):
                self.gateway.place_order(self.request)
        self.assert_replay_blocked()

    def test_uncertain_order_stays_blocked_after_bridge_restart(self):
        with patch.object(self.ledger, "complete", side_effect=OSError("simulated disk failure")):
            with self.assertRaises(OSError):
                self.gateway.place_order(self.request)
        self.ledger.close()
        self.ledger = IdempotencyLedger(self.path)
        # Production's guarded gateway inherits the same durable replay boundary.
        restarted = GuardedMt5Gateway(settings(self.path), self.ledger, self.fake)
        self.assertTrue(restarted.start())
        self.assert_replay_blocked(restarted)

    def test_failure_before_order_send_allows_a_safe_retry(self):
        with patch.object(self.fake, "order_check", return_value=None):
            with self.assertRaisesRegex(BridgeError, "order_check failed"):
                self.gateway.place_order(self.request)
        self.assertEqual(self.fake.send_calls, 0)
        response = self.gateway.place_order(self.request)
        self.assertTrue(response["accepted"])
        self.assertEqual(self.fake.send_calls, 1)

    def test_successful_order_still_replays_without_another_send(self):
        first = self.gateway.place_order(self.request)
        second = self.gateway.place_order(self.request)
        self.assertTrue(first["accepted"])
        self.assertTrue(second["idempotentReplay"])
        self.assertEqual(self.fake.send_calls, 1)

    def test_completed_record_survives_an_error_reported_after_commit(self):
        original = self.ledger.complete

        def write_then_fail(key, response):
            original(key, response)
            raise OSError("simulated error after commit")

        with patch.object(self.ledger, "complete", side_effect=write_then_fail):
            with self.assertRaises(OSError):
                self.gateway.place_order(self.request)
        response = self.gateway.place_order(self.request)
        self.assertTrue(response["idempotentReplay"])
        self.assertEqual(self.fake.send_calls, 1)


if __name__ == "__main__":
    unittest.main()
