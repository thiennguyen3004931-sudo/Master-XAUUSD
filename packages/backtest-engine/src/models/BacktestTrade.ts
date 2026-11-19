import type { OrderSide } from "@xauusd/types";
import type { PartialExit } from "./PartialExit";
import type { TradeExitReason } from "./TradeExitReason";

export interface BacktestTrade {
  id: string;
  symbol: string;
  side: OrderSide;
  strategyId: string;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  averageExitPrice: number;
  initialVolume: number;
  grossPnl: number;
  commission: number;
  netPnl: number;
  rMultiple: number;
  durationMinutes: number;
  exitReason: TradeExitReason;
  partialExits: PartialExit[];
}
