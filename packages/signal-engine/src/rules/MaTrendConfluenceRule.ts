import type { ISignalRule } from "../contracts";
import type { SignalEngineConfig } from "../config";
import type { SignalContext, SignalRuleResult } from "../models";
import { RuleResultFactory } from "../utils";

const WEIGHT = 25;

function valueAt(
  context: SignalContext,
  period: number,
): number | null {
  const key = String(period);
  return context.indicators.latest.ema[key]
    ?? context.indicators.latest.sma[key]
    ?? null;
}

export class MaTrendConfluenceRule implements ISignalRule {
  readonly name = "MaTrendConfluenceRule";

  evaluate(
    context: SignalContext,
    _config: SignalEngineConfig,
  ): SignalRuleResult {
    const close = context.indicators.latest.close;
    const ma20 = valueAt(context, 20);
    const ma50 = valueAt(context, 50);
    const ma200 = valueAt(context, 200);

    if (
      ma20 === null ||
      ma50 === null ||
      ma200 === null
    ) {
      return RuleResultFactory.neutral(
        this.name,
        WEIGHT,
        "MA20/MA50/MA200 values are unavailable",
        { close, ma20, ma50, ma200 },
      );
    }

    if (
      close >= ma20 &&
      ma20 > ma50 &&
      ma50 > ma200
    ) {
      return RuleResultFactory.create(
        this.name,
        WEIGHT,
        "BULLISH",
        1,
        "MA20 > MA50 > MA200 with price above MA20 confirms the uptrend",
        { close, ma20, ma50, ma200 },
      );
    }

    if (
      close <= ma20 &&
      ma20 < ma50 &&
      ma50 < ma200
    ) {
      return RuleResultFactory.create(
        this.name,
        WEIGHT,
        "BEARISH",
        1,
        "MA20 < MA50 < MA200 with price below MA20 confirms the downtrend",
        { close, ma20, ma50, ma200 },
      );
    }

    return RuleResultFactory.neutral(
      this.name,
      WEIGHT,
      "MA20/MA50/MA200 are not fully trend-aligned",
      { close, ma20, ma50, ma200 },
    );
  }
}