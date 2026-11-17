import {
  AnalysisPipeline,
  type IAnalysisEngine,
} from "@xauusd/analysis-engine";
import {
  IndicatorPipeline,
  type IIndicatorEngine,
  type IndicatorConfig,
} from "@xauusd/indicators";
import type { Candle, Timeframe } from "@xauusd/market-data";
import type { ISignalEngine } from "../contracts";
import type { SignalContext, SignalEngineResult } from "../models";
import { SignalPipeline } from "../pipeline";

export class SignalService {
  constructor(
    private readonly analysisEngine: IAnalysisEngine = new AnalysisPipeline(),
    private readonly indicatorEngine: IIndicatorEngine = new IndicatorPipeline(),
    private readonly signalEngine: ISignalEngine = new SignalPipeline(),
  ) {}

  generateFromCandles(
    symbol: string,
    timeframe: Timeframe,
    candles: readonly Candle[],
    indicatorConfig: Partial<IndicatorConfig> = {},
  ): SignalEngineResult {
    const analysis = this.analysisEngine.analyze(symbol, timeframe, candles);
    const indicators = this.indicatorEngine.calculate(candles, indicatorConfig);
    return this.signalEngine.generate({ analysis, indicators });
  }

  evaluate(context: SignalContext): SignalEngineResult {
    return this.signalEngine.generate(context);
  }
}
