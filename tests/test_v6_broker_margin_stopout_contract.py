"""G3 offline metadata plausibility tests. No test impersonates broker evidence."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.v6_broker_margin_stopout_contract import (
    attest_broker_margin_contract,
    evaluate_g3_stopout_evidence_contract,
)


def _account(**overrides):
    d = {
        "login": 1001,
        "server": "Broker-Demo",
        "currency": "USD",
        "leverage": 100,
        "marginMode": "RETAIL_HEDGING",
        "marginSoMode": "PERCENT",
        "marginSoCall": 80.0,
        "marginSoStopOut": 50.0,
        "snapshotEpochUtc": 1700000000,
    }
    d.update(overrides)
    return d


def _symbol(**overrides):
    d = {
        "symbol": "XAUUSD",
        "tradeContractSize": 100.0,
        "tradeTickSize": 0.01,
        "tradeTickValue": 1.0,
        "marginInitial": 0.0,
        "marginHedged": 50.0,
        "hedgedMarginPolicyAttested": True,
    }
    d.update(overrides)
    return d


def _kwargs(**overrides):
    d = {
        "account_info": _account(),
        "symbol_info": _symbol(),
        "expected_account_login": 1001,
        "expected_server": "Broker-Demo",
        "now_utc": 1700000002,
        "positions": [{"ticket": 1, "type": 0}],
        "observed_stopout_fills": [{"positionTicket": 1}],
        "replayed_stopout_events": [{"positionTicket": 1}],
    }
    d.update(overrides)
    return d


class BrokerMarginStopOutContractP1Tests(unittest.TestCase):
    def assert_not_attested(self, x):
        self.assertFalse(x["attested"])
        self.assertFalse(x["brokerSourceIndependentlyVerified"])
        self.assertFalse(x["hedgedMarginPolicyVerified"])

    def assert_never_authorizes(self, x):
        self.assertTrue(x["readOnly"])
        self.assertFalse(x["executionEnabled"])
        self.assertFalse(x["runtimePreSendAccepted"])
        self.assertFalse(x["liveAuthorized"])
        self.assertFalse(x["admitted"])
        self.assertFalse(x["brokerStopOutExecutionVerified"])
        self.assertFalse(x["brokerMarginContractIndependentlyAttested"])
        self.assertFalse(x["brokerFillSourceIndependentlyVerified"])

    def test_matching_caller_tickets_are_only_diagnostic_not_broker_fills(self):
        result = evaluate_g3_stopout_evidence_contract(**_kwargs())
        self.assert_never_authorizes(result)
        self.assert_not_attested(result["contract"])
        self.assertTrue(result["contract"]["metadataShapeValid"])
        self.assertTrue(result["ticketSequenceMatches"])
        self.assertEqual(result["matchedTicketCount"], 1)
        self.assertEqual(
            result["reason"], "CALLER_SUPPLIED_TICKET_ORDER_MATCH_ONLY_NOT_BROKER_VERIFIED"
        )
        self.assertFalse(result["priceVolumeTimingMatchVerified"])
        self.assertFalse(result["outOfSampleIndependentlyVerified"])
        self.assertEqual(len(result["contract"]["contractSha256"]), 64)
        self.assertFalse(result["contract"]["fingerprintIsBrokerAttestation"])

    def test_same_ticket_but_different_volume_price_time_does_not_prove_execution(self):
        kw = _kwargs(
            observed_stopout_fills=[{
                "positionTicket": 1, "volume": 0.5,
                "price": 2600.0, "timestampMs": 1700000000000,
            }],
            replayed_stopout_events=[{
                "positionTicket": 1, "volume": 5.0,
                "price": 2400.0, "timestampMs": 1700000300000,
            }],
        )
        result = evaluate_g3_stopout_evidence_contract(**kw)
        self.assert_never_authorizes(result)
        self.assertTrue(result["ticketSequenceMatches"])
        self.assertFalse(result["priceVolumeTimingMatchVerified"])

    def test_caller_hedge_policy_flag_never_verifies_opposing_positions(self):
        result = evaluate_g3_stopout_evidence_contract(**_kwargs(
            positions=[{"ticket": 10, "type": 0}, {"ticket": 20, "type": 1}],
            observed_stopout_fills=[{"positionTicket": 20}],
            replayed_stopout_events=[{"positionTicket": 20}],
        ))
        self.assert_never_authorizes(result)
        self.assert_not_attested(result["contract"])
        self.assertTrue(result["contract"]["claimedHedgePolicyFlag"])
        self.assertEqual(result["reason"], "HEDGED_MARGIN_POLICY_UNVERIFIED")

    def test_missing_inventories_and_fills_fail_closed(self):
        for update, reason in (
            ({"positions": None}, "BROKER_INVENTORY_OR_FILLS_UNAVAILABLE"),
            ({"positions": "not a list"}, "BROKER_INVENTORY_OR_FILLS_UNAVAILABLE"),
            ({"observed_stopout_fills": None}, "BROKER_INVENTORY_OR_FILLS_UNAVAILABLE"),
            ({"replayed_stopout_events": None}, "BROKER_INVENTORY_OR_FILLS_UNAVAILABLE"),
            ({"observed_stopout_fills": []}, "NO_OUT_OF_SAMPLE_STOPOUT_FILLS_TO_VERIFY"),
            ({"replayed_stopout_events": []}, "NO_OUT_OF_SAMPLE_STOPOUT_FILLS_TO_VERIFY"),
        ):
            with self.subTest(update=update):
                x = evaluate_g3_stopout_evidence_contract(**_kwargs(**update))
                self.assert_never_authorizes(x)
                self.assertEqual(x["reason"], reason)

    def test_unknown_positions_and_duplicate_or_invalid_tickets_fail_closed(self):
        for update, reason in (
            ({"positions": [None]}, "INVALID_OR_DUPLICATE_POSITION"),
            ({"positions": [{"ticket": 2, "type": 0}, {"ticket": 2, "type": 0}]},
             "INVALID_OR_DUPLICATE_POSITION"),
            ({"positions": [{"ticket": 1, "type": True}]}, "UNKNOWN_POSITION_TYPE"),
            ({"positions": [{"ticket": 1, "type": 99}]}, "UNKNOWN_POSITION_TYPE"),
            ({"observed_stopout_fills": [None]}, "INVALID_OBSERVED_FILL_TICKET"),
            ({"observed_stopout_fills": [{"positionTicket": True}]},
             "INVALID_OBSERVED_FILL_TICKET"),
            ({"observed_stopout_fills": [{"positionTicket": 1}, {"positionTicket": 1}]},
             "DUPLICATE_OBSERVED_FILL_TICKET"),
            ({"replayed_stopout_events": [{"positionTicket": 1}, {"positionTicket": 1}]},
             "DUPLICATE_REPLAYED_EVENT_TICKET"),
        ):
            with self.subTest(update=update):
                x = evaluate_g3_stopout_evidence_contract(**_kwargs(**update))
                self.assert_never_authorizes(x)
                self.assertEqual(x["reason"], reason)

    def test_mismatched_sequence_only_reports_a_scenario_mismatch(self):
        x = evaluate_g3_stopout_evidence_contract(**_kwargs(
            positions=[{"ticket": 1, "type": 0}, {"ticket": 2, "type": 0}],
            observed_stopout_fills=[{"positionTicket": 2}, {"positionTicket": 1}],
            replayed_stopout_events=[{"positionTicket": 1}, {"positionTicket": 2}],
        ))
        self.assert_never_authorizes(x)
        self.assertFalse(x["ticketSequenceMatches"])
        self.assertEqual(x["reason"], "STOPOUT_TICKET_SEQUENCE_MISMATCH")

    def test_broker_metadata_shape_does_not_attest_source_or_contract(self):
        c = attest_broker_margin_contract(
            account_info=_account(), symbol_info=_symbol(),
            expected_account_login=1001, expected_server="Broker-Demo",
            now_utc=1700000002,
        )
        self.assert_not_attested(c)
        self.assertTrue(c["metadataShapeValid"])
        self.assertEqual(c["reason"], "CALLER_SUPPLIED_MARGIN_METADATA_SHAPE_VALID_NOT_ATTESTED")
        self.assertFalse(c["fingerprintIsBrokerAttestation"])

    def test_malformed_account_or_symbol_and_untrusted_clock_fail_closed(self):
        for changes, reason in (
            ({"account_info": None}, "MISSING_BROKER_METADATA_DICTS"),
            ({"expected_account_login": None}, "ACCOUNT_BINDING_MISMATCH"),
            ({"expected_account_login": True}, "ACCOUNT_BINDING_MISMATCH"),
            ({"expected_account_login": 10**1000}, "ACCOUNT_BINDING_MISMATCH"),
            ({"account_info": _account(login=2000)}, "ACCOUNT_BINDING_MISMATCH"),
            ({"account_info": _account(marginSoStopOut=100.0)},
             "INVALID_STOP_OUT_THRESHOLDS"),
            ({"symbol_info": _symbol(tradeTickValue=None)}, "INVALID_SYMBOL_CONTRACT_SPECS"),
            ({"symbol_info": _symbol(marginInitial=-2)}, "INVALID_SYMBOL_MARGIN_INITIAL"),
            ({"now_utc": 1700000020}, "SNAPSHOT_STALE_OR_FUTURE_SKEW"),
        ):
            with self.subTest(changes=changes):
                x = evaluate_g3_stopout_evidence_contract(**_kwargs(**changes))
                self.assert_never_authorizes(x)
                self.assertEqual(x["reason"], reason)

    def test_boolean_claim_hedged_policy_does_not_make_hedged_verified(self):
        for flag in (True, False, "true", 1, None):
            with self.subTest(flag=flag):
                c = attest_broker_margin_contract(
                    account_info=_account(),
                    symbol_info=_symbol(hedgedMarginPolicyAttested=flag),
                    expected_account_login=1001,
                    expected_server="Broker-Demo",
                    now_utc=1700000002,
                )
                self.assert_not_attested(c)
                self.assertTrue(c["metadataShapeValid"])


if __name__ == "__main__":
    unittest.main()
