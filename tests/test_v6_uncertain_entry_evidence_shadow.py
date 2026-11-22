"""Offline evidence golden tests: every branch must keep the entry freeze."""
import importlib.util
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / "scripts" / "v6_uncertain_entry_evidence_shadow.py"
spec = importlib.util.spec_from_file_location("uncertain_evidence_shadow", SOURCE)
shadow = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shadow)

INTENT = {
    "symbol": "XAUUSD.G",
    "side": "BUY",
    "brokerComment": "V6_TREND:12345678901",
    "accountLogin": 123456,
    "server": "Mock-Broker",
    "requestedVolume": 0.10,
}
DEAL = {
    "ticket": 201, "position_id": 301, "volume": 0.10, "magic": 270715,
    "symbol": "XAUUSD.G", "type": 0, "entry": 0, "comment": INTENT["brokerComment"],
}
POSITION = {
    "ticket": 302, "identifier": 301, "magic": 270715,
    "symbol": "XAUUSD.G", "type": 0, "volume": 0.10,
}


def assess(**changes):
    base = dict(intent=INTENT, snapshot_login=123456, snapshot_server="Mock-Broker",
                broker_positions=[], broker_pending_orders=[], broker_deals=[], bot_magic=270715)
    base.update(changes)
    result = shadow.assess_uncertain_entry_evidence(**base)
    assert result["freezeNewOrders"] is True
    assert result["allowDuplicateSend"] is False
    assert result["allowAutomaticFreezeClear"] is False
    assert result["allowProtectivePositionManagement"] is True
    return result


class UncertainEntryEvidenceTests(unittest.TestCase):
    def test_no_match_never_grants_retry(self):
        self.assertEqual(assess()["status"], "NO_MATCH_NOT_PROOF_OF_NO_FILL")

    def test_broker_snapshot_missing_or_invalid_blocks(self):
        self.assertEqual(assess(broker_pending_orders=None)["status"], "BROKER_SNAPSHOT_UNAVAILABLE")
        self.assertEqual(assess(broker_deals=[None])["status"], "BROKER_SNAPSHOT_MALFORMED")

    def test_mismatched_account_or_corrupt_intent_blocks(self):
        self.assertEqual(assess(snapshot_login=999)["status"], "ACCOUNT_SERVER_MISMATCH")
        self.assertEqual(assess(snapshot_server="Other-Broker")["status"], "ACCOUNT_SERVER_MISMATCH")
        self.assertEqual(assess(intent={})["status"], "INTENT_UNVERIFIED")

    def test_deal_direction_requires_an_integer_enum(self):
        for side, direction in (("BUY", 0), ("SELL", 1)):
            for invalid in (bool(direction), float(direction)):
                with self.subTest(side=side, invalid=repr(invalid)):
                    result = assess(intent=dict(INTENT, side=side),
                                    broker_deals=[dict(DEAL, type=invalid)])
                    self.assertEqual(result["status"], "MATCHED_DEAL_INVALID")

    def test_pending_order_blocks_even_with_no_deal(self):
        pending = dict(DEAL, ticket=401)
        result = assess(broker_pending_orders=[pending])
        self.assertEqual(result["status"], "BROKER_PENDING_ORDER_REVIEW")
        self.assertEqual(result["matchedPendingCount"], 1)

    def test_exit_reversal_and_unknown_entry_never_prove_opening_volume(self):
        for entry in (1, 2, 3, None, False, 0.0, "0"):
            with self.subTest(entry=repr(entry)):
                deal = dict(DEAL, entry=entry)
                if entry is None:
                    del deal["entry"]
                result = assess(broker_deals=[deal], broker_positions=[POSITION])
                self.assertEqual(result["status"], "DEAL_ENTRY_NOT_VERIFIED_REVIEW")
                self.assertIsNone(result["observedDealVolume"])

    def test_partial_and_overfill_both_stay_frozen(self):
        partial = dict(DEAL, volume=0.04)
        self.assertEqual(assess(broker_deals=[partial])["status"], "BROKER_PARTIAL_FILL_REVIEW")
        over = dict(DEAL, volume=0.15)
        self.assertEqual(assess(broker_deals=[over])["status"], "BROKER_OVERFILL_REVIEW")

    def test_full_fill_with_and_without_position_stays_frozen(self):
        history_only = assess(broker_deals=[DEAL])
        self.assertEqual(history_only["status"], "BROKER_FULL_FILL_HISTORY_ONLY_REVIEW")
        with_position = assess(broker_deals=[DEAL], broker_positions=[POSITION])
        self.assertEqual(with_position["status"], "BROKER_FULL_FILL_POSITION_OBSERVED_REVIEW")

    def test_opposite_side_or_incomplete_position_never_claims_readback(self):
        incomplete = (
            {"type": 1},
            {"type": None},
            {"ticket": None},
            {"volume": 0.0},
            {"volume": float("nan")},
            {"magic": 0},
            {"identifier": 999},
        )
        for overrides in incomplete:
            with self.subTest(overrides=overrides):
                position = {**POSITION, **overrides}
                result = assess(broker_deals=[DEAL], broker_positions=[position])
                self.assertEqual(result["status"], "BROKER_FULL_FILL_HISTORY_ONLY_REVIEW")
                self.assertTrue(result["freezeNewOrders"])

    def test_duplicate_or_ambiguous_position_link_is_history_only(self):
        duplicate = assess(broker_deals=[DEAL], broker_positions=[POSITION, dict(POSITION)])
        self.assertEqual(duplicate["status"], "BROKER_FULL_FILL_HISTORY_ONLY_REVIEW")

        no_id = dict(DEAL, position_id=None)
        missing_id = assess(broker_deals=[no_id], broker_positions=[POSITION])
        self.assertEqual(missing_id["status"], "BROKER_FULL_FILL_HISTORY_ONLY_REVIEW")

        # The sum can exactly match a single requested order, but distinct
        # position IDs cannot establish unambiguous readback for that order.
        split_a = dict(DEAL, ticket=201, volume=0.04, position_id=301)
        split_b = dict(DEAL, ticket=202, volume=0.06, position_id=401)
        multiple_ids = assess(broker_deals=[split_a, split_b], broker_positions=[POSITION])
        self.assertEqual(multiple_ids["status"], "BROKER_FULL_FILL_HISTORY_ONLY_REVIEW")

    def test_sell_position_matching_all_fields_is_observed_without_unlock(self):
        intent = {**INTENT, "side": "SELL"}
        deal = {**DEAL, "type": 1}
        position = {**POSITION, "type": 1}
        result = assess(intent=intent, broker_deals=[deal], broker_positions=[position])
        self.assertEqual(result["status"], "BROKER_FULL_FILL_POSITION_OBSERVED_REVIEW")
        self.assertTrue(result["freezeNewOrders"])

    def test_duplicate_or_invalid_broker_deal_blocks(self):
        self.assertEqual(assess(broker_deals=[DEAL, DEAL])["status"], "DUPLICATE_BROKER_RECORDS")
        sell = dict(DEAL, type=1)
        self.assertEqual(assess(broker_deals=[sell])["status"], "MATCHED_DEAL_INVALID")
        no_volume = dict(DEAL, volume=float("nan"))
        self.assertEqual(assess(broker_deals=[no_volume])["status"], "MATCHED_DEAL_INVALID")

    def test_external_records_are_not_claimed_as_bot_owned(self):
        manual = dict(DEAL, magic=0)
        self.assertEqual(assess(broker_deals=[manual])["status"], "NO_MATCH_NOT_PROOF_OF_NO_FILL")
        other_symbol = dict(DEAL, symbol="EURUSD")
        self.assertEqual(assess(broker_deals=[other_symbol])["status"], "NO_MATCH_NOT_PROOF_OF_NO_FILL")


if __name__ == "__main__":
    unittest.main()
