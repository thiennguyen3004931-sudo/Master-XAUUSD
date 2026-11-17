import { TradingSession } from "@xauusd/types";
import type { StrategyEngineConfig } from "./StrategyEngineConfig";

export const defaultStrategyEngineConfig: StrategyEngineConfig = {
  minimumCandidateScore: 65,
  minimumCandidateEdge: 8,
  minimumRegimeConfidence: 55,
  maximumContextAgeMs: 5 * 60 * 1000,
  requireRiskApproval: true,
  allowedSessions: [
    TradingSession.ASIAN,
    TradingSession.LONDON,
    TradingSession.NEW_YORK,
    TradingSession.OVERLAP,
  ],
  allowAsianRangeMeanReversion: true,
  trendAdxThreshold: 22,
  rangeAdxThreshold: 18,
  breakoutAdxThreshold: 25,
  reversalRsiOversold: 32,
  reversalRsiOverbought: 68,
  breakEvenAtR: 1,
  trailingStartAtR: 1.5,
  trailingAtrMultiple: 1,
  maximumHoldingMinutes: {
    TREND_CONTINUATION: 480,
    BREAKOUT_RETEST: 240,
    LIQUIDITY_SWEEP_REVERSAL: 180,
    RANGE_MEAN_REVERSION: 180,
  },
  strategyWeights: {
    TREND_CONTINUATION: 1,
    BREAKOUT_RETEST: 1,
    LIQUIDITY_SWEEP_REVERSAL: 1,
    RANGE_MEAN_REVERSION: 0.9,
  },
};
