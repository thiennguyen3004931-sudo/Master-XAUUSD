"""Offline tests for G2 P1 shadow-only Auto Lot contract (#76)."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.v6_auto_lot_shadow_contract import evaluate_shadow_auto_lot_p1


def _base_kwargs() -> dict:
    return {
        "snapshot_epoch_utc": 1700000000,
        "now_utc": 1700000002,
        "expected_account_login": 1001,
        "expected_server": "Broker-Demo",
        "observed_account_login": 1001,
        "observed_server": "Broker-Demo",
        "broker_contract_attested": True,
        "equity_usd": 10000.0,
        "max_total_risk_pct": 0.02,
        "candidate_entry_price": 2600.0,
        "candidate_stop_loss": 2590.0,
        "tick_size": 0.01,
        "tick_value": 1.0,
        "volume_min": 0.01,
        "volume_max": 5.0,
        "volume_step": 0.01,
        "commission_per_lot_rt": 7.0,
        "slippage_ticks": 10.0,
        "positions": [],
        "pending_orders": [],
    }


class AutoLotShadowContractP1Tests(unittest.TestCase):
    def test_always_stays_shadow_only_and_deducts_commission_slippage_and_all_symbol_stop_limit(self):
        kw = _base_kwargs()
        kw["positions"] = [{
            "ticket": 11,
            "symbol": "EURUSD",
            "type": 0,
            "priceOpen": 1.1000,
            "sl": 1.0960,
            "volume": 0.1,
            "tickSize": 0.0001,
            "tickValue": 1.0,
            "commissionPerLotRt": 0.0,
            "swap": -2.0,
        }]
        kw["pending_orders"] = [{
            "ticket": 22,
            "symbol": "XAUUSD",
            "type": 6,
            "priceOpen": 2610.0,
            "stopLimitPrice": 2605.0,
            "sl": 2600.0,
            "volume": 0.1,
            "tickSize": 0.01,
            "tickValue": 1.0,
            "commissionPerLotRt": 7.0,
        }]
        res = evaluate_shadow_auto_lot_p1(**kw)
        self.assertTrue(res["shadowOnly"])
        self.assertFalse(res["executionEnabled"])
        self.assertEqual(res["activeSizingMode"], "FIXED_LOT")
        self.assertTrue(res["admitted"])
        self.assertEqual(res["symbolsIncluded"], ["EURUSD", "XAUUSD"])
        self.assertGreater(res["recommendedLot"], 0.0)
        self.assertLess(res["recommendedLot"], 0.20)

    def test_fails_closed_on_unattested_contract_stale_clock_or_missing_pending_sl(self):
        kw_unattested = _base_kwargs()
        kw_unattested["broker_contract_attested"] = False
        r1 = evaluate_shadow_auto_lot_p1(**kw_unattested)
        self.assertFalse(r1["admitted"])
        self.assertEqual(r1["reason"], "BROKER_CONTRACT_NOT_ATTESTED")

        kw_stale = _base_kwargs()
        kw_stale["now_utc"] = 1700000010
        r2 = evaluate_shadow_auto_lot_p1(**kw_stale)
        self.assertFalse(r2["admitted"])
        self.assertEqual(r2["reason"], "SNAPSHOT_STALE")

        kw_no_sl = _base_kwargs()
        kw_no_sl["pending_orders"] = [{
            "ticket": 33,
            "symbol": "GBPUSD",
            "type": 7,
            "priceOpen": 1.2500,
            "sl": 0.0,
            "volume": 0.1,
            "tickSize": 0.0001,
            "tickValue": 1.0,
        }]
        r3 = evaluate_shadow_auto_lot_p1(**kw_no_sl)
        self.assertFalse(r3["admitted"])
        self.assertEqual(r3["reason"], "PENDING_ORDER_INVALID_PRICE_SL_OR_VOLUME")


if __name__ == "__main__":
    unittest.main()
