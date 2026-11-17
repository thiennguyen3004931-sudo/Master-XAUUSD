import { AnalysisPipeline } from "@xauusd/analysis-engine";
import { IndicatorPipeline } from "@xauusd/indicators";
import { Timeframe, type Candle } from "@xauusd/market-data";
import {
  MarketRegimeClassifier,
  RangeBoundaryUtils,
  defaultStrategyEngineConfig,
  type BotMode,
  type StrategyContext,
} from "@xauusd/strategy-engine";
import { phase7CBotModeService } from "./phase7c-bot-mode.service";
import { assessReversalTrendFilter } from "./phase7c-reversal-trend-filter";

interface BridgeBar {
  openTime?: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  tickVolume?: number;
  spread?: number;
}

const analysisPipeline = new AnalysisPipeline();
const indicatorPipeline = new IndicatorPipeline();
const regimeClassifier = new MarketRegimeClassifier();

function bridgeBaseUrl(): string {
  return (process.env.MT5_BRIDGE_BASE_URL ?? "http://127.0.0.1:8765")
    .trim()
    .replace(/\/$/, "");
}

function bridgeApiKey(): string {
  return (
    process.env.MT5_BRIDGE_API_KEY?.trim() ||
    process.env.MT5_API_KEY?.trim() ||
    ""
  );
}

function recommendMode(regime: string): BotMode {
  if (regime === "RANGING") return "SIDEWAY";
  if (regime === "TRENDING" || regime === "BREAKOUT") return "TREND";
  return "PAUSE";
}

async function loadM15Candles(symbol: string, count: number): Promise<Candle[]> {
  const apiKey = bridgeApiKey();
  if (!apiKey) {
    throw new Error("MT5_BRIDGE_API_KEY or MT5_API_KEY is required for Phase 7C live candles.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(
      `${bridgeBaseUrl()}/v1/candles/${encodeURIComponent(symbol)}?timeframe=M15&count=${count}`,
      {
        headers: { "x-mt5-api-key": apiKey },
        signal: controller.signal,
      },
    );
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`MT5 bridge candles failed ${response.status}: ${text}`);
    }

    const bars = JSON.parse(text) as BridgeBar[];
    if (!Array.isArray(bars) || bars.length < 2) {
      throw new Error(`Phase 7C M15 candles require at least 2 bars; received ${Array.isArray(bars) ? bars.length : 0}.`);
    }

    return bars.map((bar) => ({
      symbol,
      timeframe: Timeframe.M15,
      openTime: Number(bar.openTime ?? (bar.closeTime - 15 * 60_000)),
      closeTime: Number(bar.closeTime),
      open: Number(bar.open),
      high: Number(bar.high),
      low: Number(bar.low),
      close: Number(bar.close),
      volume: Math.max(0, Number(bar.volume ?? bar.tickVolume ?? 0)),
      spread: bar.spread === undefined ? undefined : Number(bar.spread),
    }));
  } finally {
    clearTimeout(timeout);
  }
}

export async function getPhase7CM15Candles(symbol = "XAUUSD", count = 240) {
  const normalizedSymbol = symbol.trim().toUpperCase() || "XAUUSD";
  const candleCount = Math.min(1_000, Math.max(2, Math.trunc(count)));
  const candles = await loadM15Candles(normalizedSymbol, candleCount);
  return {
    symbol: normalizedSymbol,
    timeframe: Timeframe.M15,
    count: candles.length,
    candles,
    checkedAt: Date.now(),
  };
}

export async function getPhase7CLiveRegime(symbol = "XAUUSD", count = 320) {
  const normalizedSymbol = symbol.trim().toUpperCase() || "XAUUSD";
  const candleCount = Math.min(1_000, Math.max(220, Math.trunc(count)));
  const candles = await loadM15Candles(normalizedSymbol, candleCount);
  if (candles.length < 220) {
    throw new Error(`Phase 7C regime detection requires at least 220 M15 candles; received ${candles.length}.`);
  }

  const analysis = analysisPipeline.analyze(normalizedSymbol, Timeframe.M15, candles);
  const indicators = indicatorPipeline.calculate(candles);
  const assessment = regimeClassifier.classify(
    { analysis, indicators } as StrategyContext,
    defaultStrategyEngineConfig,
  );
  const close = indicators.latest.close;
  const range = RangeBoundaryUtils.find(close, analysis.supplyDemandZones);
  const activeMode = phase7CBotModeService.get();
  const recommendedMode = recommendMode(assessment.regime);
  const latestConfirmedChoch = [...analysis.structureEvents]
    .filter((event) => event.confirmed && event.type === "CHOCH")
    .sort((a, b) => b.timestamp - a.timestamp)[0] ?? null;
  const reversalSide = latestConfirmedChoch?.direction === "BULLISH"
    ? "BUY"
    : latestConfirmedChoch?.direction === "BEARISH"
      ? "SELL"
      : null;
  const reversal = assessment.regime === "REVERSAL" && latestConfirmedChoch && reversalSide
    ? {
        direction: latestConfirmedChoch.direction,
        side: reversalSide,
        timestamp: latestConfirmedChoch.timestamp,
        level: latestConfirmedChoch.level,
      }
    : null;

  const reversalTrendFilter = assessReversalTrendFilter(candles, reversal?.side ?? null);

  return {
    symbol: normalizedSymbol,
    timeframe: Timeframe.M15,
    regime: assessment.regime,
    confidence: assessment.confidence,
    recommendedMode,
    activeMode: activeMode.mode,
    modeMatchesRecommendation: activeMode.mode === recommendedMode || activeMode.mode === "AUTO",
    reversal,
    reversalTrendFilter,
    reasons: assessment.reasons,
    metrics: {
      ...assessment.metrics,
      atr: indicators.latest.atr,
      close,
      bollingerBandwidth: indicators.latest.bollingerBands.bandwidth,
    },
    supplyDemandRange: range
      ? {
          demand: {
            low: range.demand.low,
            high: range.demand.high,
            strength: range.demand.strength,
          },
          supply: {
            low: range.supply.low,
            high: range.supply.high,
            strength: range.supply.strength,
          },
          width: range.width,
          position: range.position,
          quality: range.quality,
        }
      : null,
    lastCandleCloseTime: candles.at(-1)!.closeTime,
    checkedAt: Date.now(),
  };
}
