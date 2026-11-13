import type { Order, TradingSession } from "@xauusd/types";
import type { MarketRegimeAssessment } from "./MarketRegimeAssessment";
import type { StrategyCandidate } from "./StrategyCandidate";
import type { TradeManagementPlan } from "./TradeManagementPlan";

export interface StrategyPlan {
  order: Order;
  selectedStrategy: StrategyCandidate;
  regime: MarketRegimeAssessment;
  session: TradingSession;
  management: TradeManagementPlan;
  expiresAt: number;
  generatedAt: number;
}
