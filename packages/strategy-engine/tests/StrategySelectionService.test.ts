import { describe, expect, it } from "vitest";
import { SignalType, TradingSession } from "@xauusd/types";
import { StrategySelectionService, type StrategyCandidate } from "../src";

function candidate(id: StrategyCandidate["strategyId"], score: number, eligible = true): StrategyCandidate {
  return {
    strategyId: id,
    name: id,
    eligible,
    direction: SignalType.BUY,
    score,
    rawScore: score,
    scoreBreakdown: { signal: 0, structure: 0, regime: 0, momentum: 0, location: 0, multiTimeframe: 0, session: 0, total: score },
    supportedRegimes: ["TRENDING"],
    supportedSessions: [TradingSession.LONDON],
    reasons: [], invalidations: [], warnings: [],
  };
}

describe("StrategySelectionService", () => {
  it("selects the highest-scoring eligible candidate", () => {
    const result = new StrategySelectionService().select([
      candidate("TREND_CONTINUATION", 75),
      candidate("BREAKOUT_RETEST", 88),
      candidate("RANGE_MEAN_REVERSION", 95, false),
    ]);
    expect(result.selected?.strategyId).toBe("BREAKOUT_RETEST");
    expect(result.edge).toBe(13);
  });
});
