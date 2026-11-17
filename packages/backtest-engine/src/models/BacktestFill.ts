import type { OrderSide } from "@xauusd/types";
import type { FillIntent } from "./FillIntent";

export interface BacktestFill {
  transactionSide: OrderSide;
  intent: FillIntent;
  referencePrice: number;
  fillPrice: number;
  volume: number;
  spreadCostPerUnit: number;
  slippagePerUnit: number;
  commission: number;
  timestamp: number;
}
