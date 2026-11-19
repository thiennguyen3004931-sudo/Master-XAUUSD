import type { DetailedAnalysisResult } from "@xauusd/analysis-engine";
import type { IndicatorReport } from "@xauusd/indicators";
import { Timeframe } from "@xauusd/market-data";
import {
  MarketStructure,
  SwingType,
  Trend,
  type FairValueGap,
  type LiquidityZone,
  type OrderBlock,
} from "@xauusd/types";
import type { SignalContext } from "../src";

const now = 1_700_000_000_000;

export function createContext(direction: "BULLISH" | "BEARISH" = "BULLISH"): SignalContext {
  const bullish = direction === "BULLISH";
  const close = 2350;
  const orderBlocks: OrderBlock[] = [{
    high: bullish ? 2347 : 2358,
    low: bullish ? 2344 : 2355,
    bullish,
    mitigated: false,
  }];
  const gaps: FairValueGap[] = [{
    high: bullish ? 2349 : 2354,
    low: bullish ? 2347 : 2352,
    bullish,
    filled: false,
  }];
  const liquidity: LiquidityZone[] = [{
    price: bullish ? 2365 : 2335,
    strength: 4,
    touched: false,
  }];

  const analysis: DetailedAnalysisResult = {
    symbol: "XAUUSD",
    timeframe: Timeframe.M15,
    trend: bullish ? Trend.Bullish : Trend.Bearish,
    structure: bullish ? MarketStructure.Bullish : MarketStructure.Bearish,
    lastCandle: {
      symbol: "XAUUSD",
      timeframe: Timeframe.M15,
      openTime: now - 900_000,
      closeTime: now,
      open: bullish ? 2348 : 2352,
      high: 2353,
      low: 2347,
      close,
      volume: 1300,
    },
    swings: [
      {
        index: 10,
        timestamp: now - 1_800_000,
        price: bullish ? 2342 : 2358,
        high: 2358,
        low: 2342,
        close: bullish ? 2344 : 2356,
        type: bullish ? SwingType.Low : SwingType.High,
        strength: 4,
      },
    ],
    internalSwings: [],
    externalSwings: [],
    liquidityZones: liquidity,
    orderBlocks,
    fairValueGaps: gaps,
    equalHighs: [],
    equalLows: [],
    premiumZone: 2360,
    discountZone: 2340,
    equilibrium: 2350,
    score: 82,
    createdAt: now,
    metrics: {
      averageTrueRange: 5,
      volatilityPercent: 0.22,
      rangeHigh: 2370,
      rangeLow: 2330,
      rangeSize: 40,
      dataQuality: 100,
    },
    structureEvents: [{
      id: "event-1",
      type: "CHOCH",
      direction: bullish ? Trend.Bullish : Trend.Bearish,
      level: bullish ? 2352 : 2348,
      candleIndex: 99,
      timestamp: now,
      confirmed: true,
    }],
  };

  const indicators: IndicatorReport = {
    symbol: "XAUUSD",
    timeframe: Timeframe.M15,
    candleCount: 240,
    generatedAt: now,
    config: {
      smaPeriods: [20, 50, 200],
      emaPeriods: [20, 50],
      atrPeriod: 14,
      rsiPeriod: 14,
      macdFastPeriod: 12,
      macdSlowPeriod: 26,
      macdSignalPeriod: 9,
      bollingerPeriod: 20,
      bollingerStandardDeviations: 2,
      stochasticPeriod: 14,
      stochasticSignalPeriod: 3,
      adxPeriod: 14,
      volumeSmaPeriod: 20,
      priceSource: "close",
    },
    series: {
      sma: {},
      ema: {},
      atr: [],
      rsi: [],
      macd: [],
      bollingerBands: [],
      stochastic: [],
      adx: [],
      vwap: [],
      volumeSma: [],
    },
    latest: {
      timestamp: now,
      close,
      sma: {
        "20": bullish ? 2348 : 2352,
        "200": bullish ? 2340 : 2360,
      },
      ema: bullish ? { "20": 2348, "50": 2345 } : { "20": 2352, "50": 2355 },
      atr: 5,
      rsi: bullish ? 61 : 39,
      macd: bullish
        ? { macd: 1.5, signal: 1, histogram: 0.5 }
        : { macd: -1.5, signal: -1, histogram: -0.5 },
      bollingerBands: { middle: 2350, upper: 2360, lower: 2340, bandwidth: 0.85, percentB: 0.5 },
      stochastic: bullish ? { k: 48, d: 42 } : { k: 52, d: 58 },
      adx: bullish
        ? { adx: 30, plusDI: 28, minusDI: 16 }
        : { adx: 30, plusDI: 16, minusDI: 28 },
      vwap: bullish ? 2348 : 2352,
      volumeSma: 1000,
    },
    warmupComplete: true,
  };

  return { analysis, indicators, evaluatedAt: now };
}
