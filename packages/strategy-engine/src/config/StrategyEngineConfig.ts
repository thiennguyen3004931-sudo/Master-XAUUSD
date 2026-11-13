import type { TradingSession } from "@xauusd/types";
import type { StrategyId } from "../models/StrategyId";

export interface StrategyEngineConfig {
  minimumCandidateScore: number;
  minimumCandidateEdge: number;
  minimumRegimeConfidence: number;
  maximumContextAgeMs: number;
  requireRiskApproval: boolean;
  allowedSessions: readonly TradingSession[];
  allowAsianRangeMeanReversion: boolean;
  trendAdxThreshold: number;
  rangeAdxThreshold: number;
  breakoutAdxThreshold: number;
  reversalRsiOversold: number;
  reversalRsiOverbought: number;
  breakEvenAtR: number;
  trailingStartAtR: number;
  trailingAtrMultiple: number;
  maximumHoldingMinutes: Readonly<Record<StrategyId, number>>;
  strategyWeights: Readonly<Record<StrategyId, number>>;
}
