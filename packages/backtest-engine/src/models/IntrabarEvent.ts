import type { TradeExitReason } from "./TradeExitReason";

export interface IntrabarEvent {
  id: string;
  type: "TARGET" | "STOP" | "HARD_INVALIDATION";
  price: number;
  label?: string;
  closePercent?: number;
  reason: TradeExitReason;
}
