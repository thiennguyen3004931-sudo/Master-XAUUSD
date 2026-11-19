import tempfile
import unittest
from pathlib import Path

from mt5_bridge.ledger import IdempotencyLedger


class LedgerTests(unittest.TestCase):
    def test_reserves_and_replays_response(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = IdempotencyLedger(Path(directory) / "ledger.sqlite3")
            state, replay = ledger.reserve("order:test")
            self.assertEqual(state, "ACQUIRED")
            self.assertIsNone(replay)

            state, replay = ledger.reserve("order:test")
            self.assertEqual(state, "PENDING")
            self.assertIsNone(replay)

            ledger.complete("order:test", {"accepted": True})
            state, replay = ledger.reserve("order:test")
            self.assertEqual(state, "COMPLETED")
            self.assertEqual(replay, {"accepted": True})
            ledger.close()

    def test_release_allows_retry_after_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = IdempotencyLedger(Path(directory) / "ledger.sqlite3")
            self.assertEqual(ledger.reserve("order:test")[0], "ACQUIRED")
            ledger.release("order:test")
            self.assertEqual(ledger.reserve("order:test")[0], "ACQUIRED")
            ledger.close()


if __name__ == "__main__":
    unittest.main()
