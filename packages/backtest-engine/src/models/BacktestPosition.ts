import type { StrategyPlan } from "@xauusd/strategy-engine";
import type { OrderSide } from "@xauusd/types";
import type { PartialExit } from "./PartialExit";

export interface BacktestPosition {
  id: string;
  symbol: string;
  side: OrderSide;
  strategyId: string;
  plan: StrategyPlan;
  entryBarIndex: number;
  entryTime: number;
  entryPrice: number;
  initialVolume: number;
  remainingVolume: number;
  initialStopLoss: number;
  stopLoss: number;
  takeProfit: number;
  initialRiskDistance: number;
  entryCommission: number;
  realizedGrossPnl: number;
  exitCommission: number;
  partialExits: PartialExit[];
  completedTargetLabels: string[];
  breakEvenApplied: boolean;
  highestPrice: number;
  lowestPrice: number;
}
