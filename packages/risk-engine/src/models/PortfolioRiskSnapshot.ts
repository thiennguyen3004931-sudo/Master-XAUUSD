import type { OpenRiskPosition } from "./OpenRiskPosition";

export interface PortfolioRiskSnapshot {
  openPositions: readonly OpenRiskPosition[];
  dailyRealizedPnl: number;
  dailyUnrealizedPnl?: number;
  peakEquity: number;
  consecutiveLosses: number;
  lastTradeClosedAt?: number;
  spread: number;
}
