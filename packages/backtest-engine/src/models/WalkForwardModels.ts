import type { Candle } from "@xauusd/market-data";

export interface WalkForwardConfig {
  trainingBars: number;
  testingBars: number;
  stepBars: number;
  anchored: boolean;
}

export interface WalkForwardWindow {
  index: number;
  trainingStartIndex: number;
  trainingEndIndex: number;
  testingStartIndex: number;
  testingEndIndex: number;
  trainingCandles: readonly Candle[];
  testingCandles: readonly Candle[];
}
