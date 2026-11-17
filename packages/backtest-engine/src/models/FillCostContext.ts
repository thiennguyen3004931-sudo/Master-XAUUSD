import type { OrderSide } from "@xauusd/types";
import type { FillIntent } from "./FillIntent";

export interface FillCostContext {
  symbol: string;
  transactionSide: OrderSide;
  intent: FillIntent;
  referencePrice: number;
  volume: number;
  tickSize: number;
  contractSize: number;
  timestamp: number;
}
