"""Offline tests for G3 P1 read-only broker margin, hedge & stop-out contract (#52)."""
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


def _account_info(**overrides) -> dict:
    base = {
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
    base.update(overrides)
    return base


def _symbol_info(**overrides) -> dict:
    base = {
        "symbol": "XAUUSD",
        "tradeContractSize": 100.0,
        "tradeTickSize": 0.01,
        "tradeTickValue": 1.0,
        "marginInitial": 0.0,
        "marginHedged": 50.0,
        "hedgedMarginPolicyAttested": True,
    }
    base.update(overrides)
    return base


class BrokerMarginStopOutContractP1Tests(unittest.TestCase):
    def test_rejects_unattested_hedged_policy_when_opposing_positions_exist(self):
        res = evaluate_g3_stopout_evidence_contract(
            account_info=_account_info(),
            symbol_info=_symbol_info(hedgedMarginPolicyAttested=False),
            expected_account_login=1001,
            expected_server="Broker-Demo",
            now_utc=1700000002,
            positions=[{"ticket": 1, "type": 0}, {"ticket": 2, "type": 1}],
            observed_stopout_fills=[{"positionTicket": 1}],
            replayed_stopout_events=[{"positionTicket": 1}],
        )
        self.assertFalse(res["admitted"])
        self.assertFalse(res["brokerStopOutExecutionVerified"])
        self.assertFalse(res["liveAuthorized"])
        self.assertEqual(res["reason"], "HEDGED_MARGIN_POLICY_UNVERIFIED")

    def test_fails_closed_on_missing_fills_unavailable_positions_or_sequence_mismatch(self):
        r_none_pos = evaluate_g3_stopout_evidence_contract(
            account_info=_account_info(),
            symbol_info=_symbol_info(),
            expected_account_login=1001,
            expected_server="Broker-Demo",
            now_utc=1700000002,
            positions=None,
            observed_stopout_fills=[{"positionTicket": 1}],
            replayed_stopout_events=[{"positionTicket": 1}],
        )
        self.assertFalse(r_none_pos["admitted"])
        self.assertEqual(r_none_pos["reason"], "POSITIONS_INVENTORY_UNAVAILABLE")

        r_empty_fills = evaluate_g3_stopout_evidence_contract(
            account_info=_account_info(),
            symbol_info=_symbol_info(),
            expected_account_login=1001,
            expected_server="Broker-Demo",
            now_utc=1700000002,
            positions=[{"ticket": 1, "type": 0}],
            observed_stopout_fills=[],
            replayed_stopout_events=[],
        )
        self.assertFalse(r_empty_fills["admitted"])
        self.assertFalse(r_empty_fills["brokerStopOutExecutionVerified"])
        self.assertEqual(r_empty_fills["reason"], "NO_OUT_OF_SAMPLE_STOPOUT_FILLS_TO_VERIFY")

        r_mismatch = evaluate_g3_stopout_evidence_contract(
            account_info=_account_info(),
            symbol_info=_symbol_info(),
            expected_account_login=1001,
            expected_server="Broker-Demo",
            now_utc=1700000002,
            positions=[{"ticket": 1, "type": 0}, {"ticket": 2, "type": 0}],
            observed_stopout_fills=[{"positionTicket": 2}, {"positionTicket": 1}],
            replayed_stopout_events=[{"positionTicket": 1}, {"positionTicket": 2}],
        )
        self.assertFalse(r_mismatch["admitted"])
        self.assertEqual(r_mismatch["reason"], "STOPOUT_SEQUENCE_MISMATCH")

    def test_verifies_only_when_contract_hedged_policy_and_out_of_sample_fills_match(self):
        att = attest_broker_margin_contract(
            account_info=_account_info(),
            symbol_info=_symbol_info(),
            expected_account_login=1001,
            expected_server="Broker-Demo",
            now_utc=1700000003,
        )
        self.assertTrue(att["attested"])
        self.assertEqual(len(att["contractSha256"]), 64)

        ok = evaluate_g3_stopout_evidence_contract(
            account_info=_account_info(),
            symbol_info=_symbol_info(),
            expected_account_login=1001,
            expected_server="Broker-Demo",
            now_utc=1700000003,
            positions=[{"ticket": 10, "type": 0}, {"ticket": 20, "type": 1}],
            observed_stopout_fills=[{"positionTicket": 20}, {"positionTicket": 10}],
            replayed_stopout_events=[{"positionTicket": 20}, {"positionTicket": 10}],
        )
        self.assertTrue(ok["admitted"])
        self.assertTrue(ok["brokerStopOutExecutionVerified"])
        self.assertTrue(ok["readOnly"])
        self.assertFalse(ok["executionEnabled"])
        self.assertFalse(ok["liveAuthorized"])


if __name__ == "__main__":
    unittest.main()
