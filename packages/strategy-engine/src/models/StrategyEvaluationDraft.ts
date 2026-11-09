import type { TradingSession } from "@xauusd/types";
import type { MarketRegimeAssessment } from "./MarketRegimeAssessment";
import type { StrategySelection } from "./StrategySelection";

export interface StrategyEvaluationDraft {
  session: TradingSession;
  regime: MarketRegimeAssessment;
  selection: StrategySelection;
}
