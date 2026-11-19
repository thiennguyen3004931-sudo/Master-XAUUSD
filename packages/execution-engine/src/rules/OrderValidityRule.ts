import { OrderSide } from "@xauusd/types";
import type { ExecutionEngineConfig } from "../config";
import type { IExecutionRule } from "../contracts";
import type {
  ExecutionPreflightDraft,
  ExecutionRequest,
  ExecutionRuleResult,
} from "../models";

export class OrderValidityRule implements IExecutionRule {
  readonly name = "order-validity";

  evaluate(
    _request: ExecutionRequest,
    draft: ExecutionPreflightDraft,
    _config: ExecutionEngineConfig,
  ): ExecutionRuleResult {
    const order = draft.normalizedOrder;
    const buyValid =
      order?.side === OrderSide.BUY &&
      order.stopLoss < order.requestedPrice &&
      order.takeProfit > order.requestedPrice;
    const sellValid =
      order?.side === OrderSide.SELL &&
      order.stopLoss > order.requestedPrice &&
      order.takeProfit < order.requestedPrice;
    const passed =
      (buyValid || sellValid) &&
      Number.isFinite(order?.requestedPrice) &&
      Number.isFinite(order?.stopLoss) &&
      Number.isFinite(order?.takeProfit);

    return {
      rule: this.name,
      passed,
      code: passed ? undefined : "ORDER_INVALID",
      message: passed
        ? "Normalized order prices are directionally valid."
        : "Normalized order prices are invalid.",
    };
  }
}
