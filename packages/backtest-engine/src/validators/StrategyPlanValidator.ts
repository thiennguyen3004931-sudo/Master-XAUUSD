import { OrderSide } from "@xauusd/types";
import type { StrategyPlan } from "@xauusd/strategy-engine";

export class StrategyPlanValidator {
  isValid(
    plan: StrategyPlan,
    expectedSymbol?: string,
  ): boolean {
    const { order } = plan;
    const buyValid =
      order.side === OrderSide.BUY &&
      order.stopLoss < order.entry &&
      order.takeProfit > order.entry;
    const sellValid =
      order.side === OrderSide.SELL &&
      order.stopLoss > order.entry &&
      order.takeProfit < order.entry;

    return (
      (buyValid || sellValid) &&
      Number.isFinite(order.volume) &&
      order.volume > 0 &&
      Number.isFinite(plan.expiresAt) &&
      Number.isFinite(plan.generatedAt) &&
      plan.expiresAt > plan.generatedAt &&
      (expectedSymbol === undefined ||
        order.symbol === expectedSymbol)
    );
  }
}
