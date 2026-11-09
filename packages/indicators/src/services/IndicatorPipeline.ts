import type { Candle } from "@xauusd/market-data";
import { defaultIndicatorConfig } from "../config";
import type { IIndicatorEngine } from "../contracts";
import {
  AverageDirectionalIndex,
  AverageTrueRange,
  BollingerBands,
  ExponentialMovingAverage,
  MovingAverageConvergenceDivergence,
  RelativeStrengthIndex,
  SimpleMovingAverage,
  StochasticOscillator,
  VolumeMovingAverage,
  VolumeWeightedAveragePrice,
} from "../indicators";
import type {
  IndicatorConfig,
  IndicatorReport,
  IndicatorSeriesSet,
  NullableNumber,
} from "../models";
import {
  IndicatorConfigValidator,
  IndicatorInputValidator,
} from "../validators";

export class IndicatorPipeline implements IIndicatorEngine {
  constructor(
    private readonly inputValidator = new IndicatorInputValidator(),
    private readonly configValidator = new IndicatorConfigValidator(),
  ) {}

  calculate(
    candles: readonly Candle[],
    config: Partial<IndicatorConfig> = {},
  ): IndicatorReport {
    this.inputValidator.validate(candles);
    const effectiveConfig = this.mergeConfig(config);
    this.configValidator.validate(effectiveConfig);

    const sma = this.calculateMovingAverages(
      effectiveConfig.smaPeriods,
      (period) => new SimpleMovingAverage(period, effectiveConfig.priceSource)
        .calculate(candles),
    );
    const ema = this.calculateMovingAverages(
      effectiveConfig.emaPeriods,
      (period) => new ExponentialMovingAverage(period, effectiveConfig.priceSource)
        .calculate(candles),
    );
    const series: IndicatorSeriesSet = {
      sma,
      ema,
      atr: new AverageTrueRange(effectiveConfig.atrPeriod).calculate(candles),
      rsi: new RelativeStrengthIndex(
        effectiveConfig.rsiPeriod,
        effectiveConfig.priceSource,
      ).calculate(candles),
      macd: new MovingAverageConvergenceDivergence(
        effectiveConfig.macdFastPeriod,
        effectiveConfig.macdSlowPeriod,
        effectiveConfig.macdSignalPeriod,
        effectiveConfig.priceSource,
      ).calculate(candles),
      bollingerBands: new BollingerBands(
        effectiveConfig.bollingerPeriod,
        effectiveConfig.bollingerStandardDeviations,
        effectiveConfig.priceSource,
      ).calculate(candles),
      stochastic: new StochasticOscillator(
        effectiveConfig.stochasticPeriod,
        effectiveConfig.stochasticSignalPeriod,
      ).calculate(candles),
      adx: new AverageDirectionalIndex(effectiveConfig.adxPeriod)
        .calculate(candles),
      vwap: new VolumeWeightedAveragePrice().calculate(candles),
      volumeSma: new VolumeMovingAverage(effectiveConfig.volumeSmaPeriod)
        .calculate(candles),
    };

    const lastCandle = candles.at(-1)!;
    const latestSma = this.latestRecord(series.sma);
    const latestEma = this.latestRecord(series.ema);
    const latest = {
      timestamp: lastCandle.closeTime,
      close: lastCandle.close,
      sma: latestSma,
      ema: latestEma,
      atr: series.atr.at(-1) ?? null,
      rsi: series.rsi.at(-1) ?? null,
      macd: series.macd.at(-1)!,
      bollingerBands: series.bollingerBands.at(-1)!,
      stochastic: series.stochastic.at(-1)!,
      adx: series.adx.at(-1)!,
      vwap: series.vwap.at(-1) ?? null,
      volumeSma: series.volumeSma.at(-1) ?? null,
    };

    return {
      symbol: lastCandle.symbol.trim().toUpperCase(),
      timeframe: lastCandle.timeframe,
      candleCount: candles.length,
      generatedAt: Date.now(),
      config: effectiveConfig,
      series,
      latest,
      warmupComplete: this.isWarmupComplete(latestSma, latestEma, latest),
    };
  }

  private mergeConfig(config: Partial<IndicatorConfig>): IndicatorConfig {
    return {
      ...defaultIndicatorConfig,
      ...config,
      smaPeriods: [...(config.smaPeriods ?? defaultIndicatorConfig.smaPeriods)],
      emaPeriods: [...(config.emaPeriods ?? defaultIndicatorConfig.emaPeriods)],
    };
  }

  private calculateMovingAverages(
    periods: readonly number[],
    calculate: (period: number) => NullableNumber[],
  ): Record<string, NullableNumber[]> {
    return Object.fromEntries(
      periods.map((period) => [String(period), calculate(period)]),
    );
  }

  private latestRecord(
    series: Record<string, NullableNumber[]>,
  ): Record<string, NullableNumber> {
    return Object.fromEntries(
      Object.entries(series).map(([period, values]) => [
        period,
        values.at(-1) ?? null,
      ]),
    );
  }

  private isWarmupComplete(
    sma: Record<string, NullableNumber>,
    ema: Record<string, NullableNumber>,
    latest: IndicatorReport["latest"],
  ): boolean {
    const scalarValues = [
      ...Object.values(sma),
      ...Object.values(ema),
      latest.atr,
      latest.rsi,
      latest.macd.macd,
      latest.macd.signal,
      latest.macd.histogram,
      latest.bollingerBands.middle,
      latest.bollingerBands.upper,
      latest.bollingerBands.lower,
      latest.stochastic.k,
      latest.stochastic.d,
      latest.adx.adx,
      latest.adx.plusDI,
      latest.adx.minusDI,
      latest.vwap,
      latest.volumeSma,
    ];

    return scalarValues.every((value) => value !== null);
  }
}
