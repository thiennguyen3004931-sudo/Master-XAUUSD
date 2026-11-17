import type { TradeExitReason } from "./TradeExitReason";

export interface PartialExit {
  label: string;
  timestamp: number;
  price: number;
  volume: number;
  grossPnl: number;
  commission: number;
  reason: TradeExitReason;
}
