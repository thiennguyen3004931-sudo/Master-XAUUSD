import type { StrategyPlan } from "@xauusd/strategy-engine";

export interface PendingBacktestOrder {
  id: string;
  plan: StrategyPlan;
  createdBarIndex: number;
  createdAt: number;
  expiresAt: number;
}
