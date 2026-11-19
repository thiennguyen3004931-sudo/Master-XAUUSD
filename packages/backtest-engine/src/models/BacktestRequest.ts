import type { Candle } from "@xauusd/market-data";
import type { IHistoricalStrategyEvaluator } from "../contracts";
import type { BacktestConfig } from "../config";

export interface BacktestRequest {
  candles: readonly Candle[];
  strategyEvaluator: IHistoricalStrategyEvaluator;
  config?: Partial<BacktestConfig>;
  runId?: string;
}
