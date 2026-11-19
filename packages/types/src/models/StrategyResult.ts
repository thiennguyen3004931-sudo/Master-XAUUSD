import type { TradeDecision } from "../enums/TradeDecision";
import type { Signal } from "./Signal";

export interface StrategyResult {
  decision: TradeDecision;
  signal: Signal | null;
  confidence: number;
  reasons: string[];
  createdAt: number;
}
