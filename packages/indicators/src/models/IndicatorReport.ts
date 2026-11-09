import type { Timeframe } from "@xauusd/market-data";
import type { AdxValue } from "./AdxValue";
import type { BollingerBandsValue } from "./BollingerBandsValue";
import type { IndicatorConfig } from "./IndicatorConfig";
import type { MacdValue } from "./MacdValue";
import type { NullableNumber } from "./NullableNumber";
import type { StochasticValue } from "./StochasticValue";

export interface IndicatorSeriesSet {
  sma: Record<string, NullableNumber[]>;
  ema: Record<string, NullableNumber[]>;
  atr: NullableNumber[];
  rsi: NullableNumber[];
  macd: MacdValue[];
  bollingerBands: BollingerBandsValue[];
  stochastic: StochasticValue[];
  adx: AdxValue[];
  vwap: NullableNumber[];
  volumeSma: NullableNumber[];
}

export interface IndicatorSnapshot {
  timestamp: number;
  close: number;
  sma: Record<string, NullableNumber>;
  ema: Record<string, NullableNumber>;
  atr: NullableNumber;
  rsi: NullableNumber;
  macd: MacdValue;
  bollingerBands: BollingerBandsValue;
  stochastic: StochasticValue;
  adx: AdxValue;
  vwap: NullableNumber;
  volumeSma: NullableNumber;
}

export interface IndicatorReport {
  symbol: string;
  timeframe: Timeframe;
  candleCount: number;
  generatedAt: number;
  config: IndicatorConfig;
  series: IndicatorSeriesSet;
  latest: IndicatorSnapshot;
  warmupComplete: boolean;
}
