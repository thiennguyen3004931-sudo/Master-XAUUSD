import { MarketStructure, Trend } from "@xauusd/types";
import type { ISignalRule } from "../contracts";
import type { SignalEngineConfig } from "../config";
import type { SignalContext, SignalRuleResult } from "../models";
import { RuleResultFactory } from "../utils";

const WEIGHT = 20;

export class PriceStructureConfluenceRule implements ISignalRule {
  readonly name = "PriceStructureConfluenceRule";

  evaluate(
    context: SignalContext,
    _config: SignalEngineConfig,
  ): SignalRuleResult {
    const { trend, structure, structureEvents } = context.analysis;
    const latestConfirmed = structureEvents
      .filter((event) => event.confirmed)
      .at(-1);

    if (
      trend === Trend.Bullish &&
      structure === MarketStructure.Bullish
    ) {
      const eventAligned =
        latestConfirmed?.direction === Trend.Bullish;

      return RuleResultFactory.create(
        this.name,
        WEIGHT,
        "BULLISH",
        eventAligned ? 1 : 0.85,
        eventAligned
          ? "HH/HL structure and latest confirmed structure event support the uptrend"
          : "HH/HL price structure supports the uptrend",
        {
          trend,
          structure,
          event: latestConfirmed?.type ?? null,
          eventDirection: latestConfirmed?.direction ?? null,
        },
      );
    }

    if (
      trend === Trend.Bearish &&
      structure === MarketStructure.Bearish
    ) {
      const eventAligned =
        latestConfirmed?.direction === Trend.Bearish;

      return RuleResultFactory.create(
        this.name,
        WEIGHT,
        "BEARISH",
        eventAligned ? 1 : 0.85,
        eventAligned
          ? "LH/LL structure and latest confirmed structure event support the downtrend"
          : "LH/LL price structure supports the downtrend",
        {
          trend,
          structure,
          event: latestConfirmed?.type ?? null,
          eventDirection: latestConfirmed?.direction ?? null,
        },
      );
    }

    return RuleResultFactory.neutral(
      this.name,
      WEIGHT,
      "Price structure is ranging or conflicts with the primary trend",
      { trend, structure },
    );
  }
}