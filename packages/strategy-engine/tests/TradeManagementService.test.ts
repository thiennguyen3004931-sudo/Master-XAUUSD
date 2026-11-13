import { SignalType, TradingSession } from "@xauusd/types";
import { describe, expect, it } from "vitest";
import {
  TradeManagementService,
  defaultStrategyEngineConfig,
  type StrategyCandidate,
} from "../src";
import { createContext, now } from "./fixtures";

function candidate(strategyId: StrategyCandidate["strategyId"]): StrategyCandidate {
  return {
    strategyId,
    name: strategyId,
    eligible: true,
    direction: SignalType.BUY,
    score: 80,
    rawScore: 80,
    scoreBreakdown: {
      signal: 16,
      structure: 14,
      regime: 14,
      momentum: 12,
      location: 10,
      multiTimeframe: 8,
      session: 6,
      total: 80,
    },
    supportedRegimes: strategyId === "RANGE_MEAN_REVERSION" ? ["RANGING"] : ["TRENDING"],
    supportedSessions: [TradingSession.LONDON],
    reasons: [],
    invalidations: [],
    warnings: [],
  };
}

describe("TradeManagementService Phase 7C bot-specific management", () => {
  it("keeps Sideway scale-out targets but disables trailing", () => {
    const plan = new TradeManagementService().create(
      createContext(),
      candidate("RANGE_MEAN_REVERSION"),
      now,
      defaultStrategyEngineConfig,
    );

    expect(plan.partialTargets).toHaveLength(3);
    expect(plan.trailingStop.enabled).toBe(false);
    expect(plan.trailingStop.mode).toBe("ATR");
    expect(plan.maximumHoldingMinutes).toBe(180);
    expect(plan.hardInvalidationPrice).toBe(2395);
    expect(plan.trendHoldUntilStructureBreak).toBeUndefined();
  });

  it("preserves Trend structure trailing and runner management", () => {
    const plan = new TradeManagementService().create(
      createContext(),
      candidate("TREND_CONTINUATION"),
      now,
      defaultStrategyEngineConfig,
    );

    expect(plan.partialTargets).toEqual([]);
    expect(plan.trailingStop.enabled).toBe(true);
    expect(plan.trailingStop.mode).toBe("TREND_STRUCTURE");
    expect(plan.maximumHoldingMinutes).toBe(480);
    expect(plan.trendHoldUntilStructureBreak).toBe(true);
  });
});
