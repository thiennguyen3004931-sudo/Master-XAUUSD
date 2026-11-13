import unittest

from pydantic import ValidationError

from mt5_bridge.models import ModifyRequest, OrderRequest


class Phase7BDemoOrderModelTests(unittest.TestCase):
    def test_market_order_allows_zero_take_profit(self):
        request = OrderRequest(
            symbol="XAUUSD",
            side="BUY",
            orderType="MARKET",
            timeInForce="GTC",
            volume=0.03,
            requestedPrice=2400.0,
            stopLoss=2394.0,
            takeProfit=0.0,
            deviationPoints=50,
            magicNumber=270713,
            comment="phase7b-demo",
            clientOrderId="phase7b-demo-1",
            idempotencyKey="phase7b-demo-1",
        )
        self.assertEqual(request.takeProfit, 0.0)

    def test_modify_position_allows_take_profit_only(self):
        request = ModifyRequest(
            takeProfit=4320.82,
            commandId="phase7c-fixed-tp-broker-trend-305091979",
        )
        self.assertIsNone(request.stopLoss)
        self.assertEqual(request.takeProfit, 4320.82)

    def test_modify_position_allows_stop_loss_only(self):
        request = ModifyRequest(
            stopLoss=4340.87,
            commandId="p7b-be-305091979-1",
        )
        self.assertEqual(request.stopLoss, 4340.87)
        self.assertIsNone(request.takeProfit)

    def test_modify_position_rejects_empty_protection_patch(self):
        with self.assertRaises(ValidationError):
            ModifyRequest(commandId="empty-protection-patch")


if __name__ == "__main__":
    unittest.main()
