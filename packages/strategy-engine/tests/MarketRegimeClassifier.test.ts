import { describe, expect, it } from "vitest";
import { MarketStructure, Trend } from "@xauusd/types";
import { MarketRegimeClassifier, defaultStrategyEngineConfig } from "../src";
import { createContext } from "./fixtures";

function configureSidewayContext(withZones = true) {
  const context = createContext();
  context.analysis.trend = Trend.Ranging;
  context.analysis.structure = MarketStructure.Range;
  context.analysis.structureEvents = [];
  context.analysis.supplyDemandZones = withZones
    ? [
        { id: "demand-1", type: "DEMAND", low: 2392, high: 2395, strength: 4, active: true, touched: true, createdAt: context.evaluatedAt! - 3_600_000 },
        { id: "supply-1", type: "SUPPLY", low: 2405, high: 2408, strength: 4, active: true, touched: true, createdAt: context.evaluatedAt! - 3_000_000 },
      ]
    : [];
  context.indicators.latest.adx = {
    ...context.indicators.latest.adx,
    adx: 16,
  };
  return context;
}

describe("MarketRegimeClassifier", () => {
  it("classifies a strong BOS and ADX as breakout", () => {
    const result = new MarketRegimeClassifier().classify(createContext(), defaultStrategyEngineConfig);
    expect(result.regime).toBe("BREAKOUT");
    expect(result.confidence).toBeGreaterThanOrEqual(65);
  });

  it("confirms sideway only when price is trapped between qualified demand and supply", () => {
    const result = new MarketRegimeClassifier().classify(
      configureSidewayContext(true),
      defaultStrategyEngineConfig,
    );

    expect(result.regime).toBe("RANGING");
    expect(result.confidence).toBeGreaterThanOrEqual(62);
    expect(result.reasons.some((reason) => reason.includes("Supply/Demand confirms sideway"))).toBe(true);
  });

  it("keeps suspected sideway uncertain when Supply/Demand does not confirm a corridor", () => {
    const result = new MarketRegimeClassifier().classify(
      configureSidewayContext(false),
      defaultStrategyEngineConfig,
    );

    expect(result.regime).toBe("UNCERTAIN");
    expect(result.reasons.some((reason) => reason.includes("no qualified Supply/Demand corridor"))).toBe(true);
  });
});
