import { describe, expect, it } from "vitest";
import { TradingSession } from "@xauusd/types";
import {
  RangeMeanReversionStrategy,
  defaultStrategyEngineConfig,
  type MarketRegimeAssessment,
} from "../src";
import { createContext } from "./fixtures";

const rangingRegime: MarketRegimeAssessment = {
  regime: "RANGING",
  confidence: 78,
  reasons: ["Supply/Demand confirms sideway."],
  metrics: {
    adx: 16,
    bollingerBandwidth: 0.006,
    volatilityPercent: 0.8,
    confirmedBosCount: 0,
    confirmedChochCount: 0,
  },
};

function createRangeContext(close: number) {
  const context = createContext();
  context.analysis.supplyDemandZones = [
    { id: "demand-1", type: "DEMAND", low: 2392, high: 2395, strength: 4, active: true, touched: true, createdAt: context.evaluatedAt! - 3_600_000 },
    { id: "supply-1", type: "SUPPLY", low: 2405, high: 2408, strength: 4, active: true, touched: true, createdAt: context.evaluatedAt! - 3_000_000 },
  ];
  context.indicators.latest.close = close;
  context.indicators.latest.adx = {
    ...context.indicators.latest.adx,
    adx: 16,
  };
  context.indicators.latest.bollingerBands = {
    ...context.indicators.latest.bollingerBands,
    percentB: 0.15,
  };
  return context;
}

describe("RangeMeanReversionStrategy", () => {
  it("allows a BUY only near the demand/lower range boundary", () => {
    const candidate = new RangeMeanReversionStrategy().evaluate(
      createRangeContext(2396),
      rangingRegime,
      TradingSession.LONDON,
      defaultStrategyEngineConfig,
    );

    expect(candidate.eligible).toBe(true);
    expect(candidate.strategyId).toBe("RANGE_MEAN_REVERSION");
  });

  it("blocks a BUY in the middle of the Supply/Demand corridor", () => {
    const candidate = new RangeMeanReversionStrategy().evaluate(
      createRangeContext(2400),
      rangingRegime,
      TradingSession.LONDON,
      defaultStrategyEngineConfig,
    );

    expect(candidate.eligible).toBe(false);
    expect(candidate.reasons.some((reason) => reason.includes("middle of the range"))).toBe(true);
  });
});
