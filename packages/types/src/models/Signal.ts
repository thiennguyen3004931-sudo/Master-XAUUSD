import type { SignalStrength } from "../enums/SignalStrength";
import type { SignalType } from "../enums/SignalType";

export interface Signal {
  symbol: string;
  timeframe: string;
  type: SignalType;
  strength: SignalStrength;
  confidence: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  reasons: string[];
  createdAt: number;
}
