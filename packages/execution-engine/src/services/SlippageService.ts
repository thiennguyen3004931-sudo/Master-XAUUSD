import { OrderSide } from "@xauusd/types";
import type {
  ExecutionQuote,
  NormalizedExecutionOrder,
  SlippageAssessment,
  SymbolExecutionSpec,
} from "../models";
import { MarketMath, NumberUtils } from "../utils";

export class SlippageService {
  assess(
    order: NormalizedExecutionOrder,
    quote: ExecutionQuote,
    spec: SymbolExecutionSpec,
  ): SlippageAssessment {
    const executablePrice = MarketMath.executablePrice(
      order.side,
      quote.bid,
      quote.ask,
    );
    const signedDistance =
      order.side === OrderSide.BUY
        ? executablePrice - order.requestedPrice
        : order.requestedPrice - executablePrice;
    const slippageTicks =
      spec.tickSize > 0
        ? signedDistance / spec.tickSize
        : Number.POSITIVE_INFINITY;

    return {
      plannedPrice: order.requestedPrice,
      executablePrice,
      slippageDistance: NumberUtils.round(
        Math.abs(executablePrice - order.requestedPrice),
      ),
      slippageTicks: NumberUtils.round(Math.abs(slippageTicks)),
      favorable: signedDistance <= 0,
    };
  }
}
