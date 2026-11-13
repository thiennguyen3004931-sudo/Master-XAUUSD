import type { SignalType, TradingSession } from "@xauusd/types";
import type { MarketRegime } from "./MarketRegime";
import type { StrategyId } from "./StrategyId";
import type { StrategyScoreBreakdown } from "./StrategyScoreBreakdown";

export interface StrategyCandidate {
  strategyId: StrategyId;
  name: string;
  eligible: boolean;
  direction: SignalType;
  score: number;
  rawScore: number;
  scoreBreakdown: StrategyScoreBreakdown;
  supportedRegimes: readonly MarketRegime[];
  supportedSessions: readonly TradingSession[];
  reasons: string[];
  invalidations: string[];
  warnings: string[];
}
