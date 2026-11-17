import type { Candle } from "@xauusd/market-data";
import type { BacktestPositionSnapshot } from "./BacktestPositionSnapshot";
import type { BacktestTrade } from "./BacktestTrade";

export interface HistoricalStrategyContext {
  candles: readonly Candle[];
  currentIndex: number;
  currentCandle: Candle;
  balance: number;
  equity: number;
  openPositions: readonly BacktestPositionSnapshot[];
  closedTrades: readonly BacktestTrade[];
}
