import {
AnalysisPipeline } from "@xauusd/analysis-engine";
import { DeterministicHeuristicProvider, AiDecisionEngine } from "@xauusd/ai-engine";
import { IndicatorPipeline } from "@xauusd/indicators";
import { Timeframe, SessionService } from "@xauusd/market-data";
import { RiskPipeline } from "@xauusd/risk-engine";
import { SignalPipeline } from "@xauusd/signal-engine";
import { StrategyPipeline } from "@xauusd/strategy-engine";
import type { Account } from "@xauusd/types";
import type { DashboardSnapshot } from "../types/dashboard";
import { round } from "../utils/number";
import { getControlState } from "./control.service";
import { getMt5RealMarketData, getMt5AllPositions,
} from "./mt5-market.service";
import { buildMt5OpenRiskPositions } from "./mt5-portfolio-risk.service";
import { getMt5RiskHistorySnapshot } from "./mt5-risk-history.service";
import { getMt5SystemService } from "./mt5.service";

const analysisEngine = new AnalysisPipeline();
const indicatorEngine = new IndicatorPipeline();
const signalEngine = new SignalPipeline();
const riskEngine = new RiskPipeline();
const strategyEngine = new StrategyPipeline();
const aiEngine = new AiDecisionEngine([
  new DeterministicHeuristicProvider(),
]);
const sessionService = new SessionService();


function timed<T>(work: () => T): { value: T; latencyMs: number } {
  const start = performance.now();
  const value = work();
  return { value, latencyMs: Math.max(0, Math.round(performance.now() - start)) };
}

async function timedAsync<T>(work: () => Promise<T>): Promise<{ value: T; latencyMs: number }> {
  const start = performance.now();
  const value = await work();
  return { value, latencyMs: Math.max(0, Math.round(performance.now() - start)) };
}

export async function getCanonicalDecisionBundle() {
  const now = Date.now();
  const timeframe = Timeframe.M15;

  // Phase 3B: real, read-only MT5 market input.
  // 320 fully closed M15 candles feed Analysis -> Indicators -> Signal -> Risk -> Strategy -> AI.
  // Live bid/ask comes from the same MT5 Bridge. No order endpoint is exposed by apps/api.
  const marketTimed = await timedAsync(() =>
    getMt5RealMarketData("XAUUSD", timeframe, 320),
  );

  const {
    candles,
    quote: liveQuote,
    spec,
    account: brokerAccount,
  } = marketTimed.value;

  const account: Account = {
    id: "MT5-DEMO",
    broker: brokerAccount.server,
    balance: brokerAccount.balance,
    equity: brokerAccount.equity,
    margin: brokerAccount.margin,
    freeMargin: brokerAccount.freeMargin,
    leverage: brokerAccount.leverage,
    currency: brokerAccount.currency,
  };
  const last = candles.at(-1)!;
  const recentCandles = candles.slice(-32);

  const quote = {
    bid: round(liveQuote.bid),
    ask: round(liveQuote.ask),
    spread: liveQuote.spread,
    high: round(
      Math.max(
        liveQuote.ask,
        ...recentCandles.map((candle) => candle.high),
      ),
    ),
    low: round(
      Math.min(
        liveQuote.bid,
        ...recentCandles.map((candle) => candle.low),
      ),
    ),
  };

  const analysisTimed = timed(() => analysisEngine.analyze("XAUUSD", timeframe, candles));
  const indicatorTimed = timed(() => indicatorEngine.calculate(candles));
  const signalTimed = timed(() =>
    signalEngine.generate({
      analysis: analysisTimed.value,
      indicators: indicatorTimed.value,
    }),
  );

  const riskHistoryTimed = await timedAsync(() =>
    getMt5RiskHistorySnapshot(account, now),
  );
  const riskHistory = riskHistoryTimed.value;

  const brokerPositions = await getMt5AllPositions();

  const openRiskPositions = buildMt5OpenRiskPositions(

    brokerPositions,

    spec,

    quote.bid,

    quote.ask,

    account.equity,

  );


  const riskTimed = timed(() =>
    riskEngine.evaluate({
      signalResult: signalTimed.value,
      account,
      portfolio: {
        openPositions: openRiskPositions,
        dailyRealizedPnl: riskHistory.dailyRealizedPnl,
        dailyUnrealizedPnl: brokerAccount.profit,
        peakEquity: riskHistory.peakEquity,
        consecutiveLosses: riskHistory.consecutiveLosses,
        spread: quote.spread,
      },
      instrument: {
        symbol: "XAUUSD",
        tickSize: spec.tickSize,
        tickValuePerLot: spec.effectiveTickValuePerLot,
        contractSize: spec.contractSize,
        minVolume: spec.minVolume,
        maxVolume: spec.maxVolume,
        volumeStep: spec.volumeStep,
        maxSpread: spec.maxSpread,
        priceDigits: spec.digits,
      },
      evaluatedAt: now,
    }),
  );

  const session = sessionService.getSession(new Date(now));
  const strategyTimed = timed(() =>
    strategyEngine.evaluate({
      analysis: analysisTimed.value,
      indicators: indicatorTimed.value,
      signalResult: signalTimed.value,
      riskAssessment: riskTimed.value,
      session,
      evaluatedAt: now,
    }),
  );

  const aiTimed = await timedAsync(() =>
    aiEngine.review({
      analysis: analysisTimed.value,
      indicators: indicatorTimed.value,
      signalResult: signalTimed.value,
      riskAssessment: riskTimed.value,
      strategyEvaluation: strategyTimed.value,
      evaluatedAt: now,
    }),
  );

  const signal = signalTimed.value.signal;
  const risk = riskTimed.value;
  const strategy = strategyTimed.value;
  const ai = aiTimed.value;
  const control = getControlState();
  const mt5SystemService = await getMt5SystemService(control.mode, now);
  // Phase 3C.4: persisted REAL MT5 balance/equity observations.
  const equityCurve = riskHistory.equityCurve.map((sample) => ({
    timestamp: sample.timestamp,
    balance: round(sample.balance),
    equity: round(sample.equity),
  }));

  const snapshot: DashboardSnapshot = {
    source: "UPSTREAM",
    generatedAt: now,
    market: {
      symbol: last.symbol,
      timeframe: String(last.timeframe),
      bid: quote.bid,
      ask: quote.ask,
      spread: quote.spread,
      open: last.open,
      high: quote.high,
      low: quote.low,
      changePercent: round(
        ((last.close - candles.at(-33)!.close) / candles.at(-33)!.close) * 100,
        3,
      ),
      atr: indicatorTimed.value.latest.atr ?? analysisTimed.value.metrics.averageTrueRange,
      volatility: analysisTimed.value.metrics.volatilityPercent >= 2 ? "HIGH" : analysisTimed.value.metrics.volatilityPercent < 0.3 ? "LOW" : "NORMAL",
      session,
      timestamp: last.closeTime,
    },
    analysis: {
      trend: String(analysisTimed.value.trend),
      structure: String(analysisTimed.value.structure),
      score: analysisTimed.value.score,
      dataQuality: analysisTimed.value.metrics.dataQuality,
      volatilityPercent: analysisTimed.value.metrics.volatilityPercent,
    },
    signal: {
      direction: signalTimed.value.decision,
      strength: signal ? String(signal.strength) : "NONE",
      confidence: signal?.confidence ?? signalTimed.value.score.confidence,
      entry: signal?.entry ?? signalTimed.value.levels?.entry ?? null,
      stopLoss: signal?.stopLoss ?? signalTimed.value.levels?.stopLoss ?? null,
      takeProfit: signal?.takeProfit ?? signalTimed.value.levels?.takeProfit ?? null,
      riskReward: signalTimed.value.levels?.riskReward ?? null,
      reasons: signal?.reasons ?? signalTimed.value.diagnostics.notes.slice(0, 6),
      rejectionCodes: [...signalTimed.value.diagnostics.rejectionCodes],
    },
    risk: {
      approved: risk.approved,
      riskPercent: risk.sizing?.actualRiskPercent ?? risk.budget?.approvedRiskPercent ?? 0,
      riskAmount: risk.sizing?.actualRiskAmount ?? risk.budget?.approvedRiskAmount ?? 0,
      positionSize: risk.sizing?.volume ?? 0,
      dailyLossPercent: 0,
      drawdownPercent: 0,
      openRiskPercent: risk.exposure?.projectedOpenRiskPercent ?? 0,
      marginUsagePercent: risk.margin?.projectedMarginUsagePercent ?? 0,
      maxDailyLossPercent: 3,
      maxDrawdownPercent: 10,
      maxOpenRiskPercent: 4,
      rejectionCodes: [...risk.diagnostics.rejectionCodes],
    },
    strategy: {
      action: strategy.action,
      strategyId: strategy.selection.selected?.strategyId ?? null,
      confidence: strategy.selection.selected?.score ?? strategy.commonResult.confidence,
      regime: strategy.regime.regime,
      regimeConfidence: strategy.regime.confidence,
      rejectionCodes: [...strategy.diagnostics.rejectionCodes],
    },
    ai: {
      action: ai.policy.action,
      executable: ai.executable,
      confidence: ai.consensus?.confidence ?? ai.policy.adjustedConfidence,
      agreementRatio: ai.consensus?.agreementRatio ?? 0,
      providerCount: ai.consensus?.providerCount ?? 0,
      reasons: ai.policy.policyReasons,
      warnings: [...ai.policy.policyWarnings, ...ai.diagnostics.warnings],
    },
    account: {
      id: account.id,
      broker: account.broker,
      currency: account.currency,
      balance: round(account.balance),
      equity: round(account.equity),
      freeMargin: round(account.freeMargin),
      margin: round(account.margin),
      floatingPnl: round(brokerAccount.profit),
      dailyPnl: round(riskHistory.dailyRealizedPnl + brokerAccount.profit),
      accountType: "DEMO",
    },
    equityCurve,
    recentTrades: riskHistory.recentTrades,
    services: [
      {
        id: "market",
        name: "Market Data",
        status: "HEALTHY",
        latencyMs: 1,
        message: "MT5 real closed candles mapped to canonical @xauusd/market-data Candle[].",
        checkedAt: now,
      },
      {
        id: "analysis",
        name: "Analysis Engine",
        status: "HEALTHY",
        latencyMs: analysisTimed.latencyMs,
        message: `score ${analysisTimed.value.score.toFixed(1)}`,
        checkedAt: now,
      },
      {
        id: "indicators",
        name: "Indicators",
        status: indicatorTimed.value.warmupComplete ? "HEALTHY" : "DEGRADED",
        latencyMs: indicatorTimed.latencyMs,
        message: indicatorTimed.value.warmupComplete
          ? "Warm-up complete."
          : "Warm-up incomplete.",
        checkedAt: now,
      },

      // Trading decisions are NOT infrastructure failures.
      // WAIT / REJECT / BLOCKED are valid fail-closed outcomes, so the engine
      // remains HEALTHY as long as it completed its evaluation successfully.
      {
        id: "signal",
        name: "Signal Engine",
        status: "HEALTHY",
        latencyMs: signalTimed.latencyMs,
        message: signalTimed.value.diagnostics.accepted
          ? `${signalTimed.value.decision} · signal accepted.`
          : `${signalTimed.value.decision} · ${
              signalTimed.value.diagnostics.rejectionCodes.join(", ") ||
              "no eligible signal"
            }`,
        checkedAt: now,
      },
      {
        id: "risk",
        name: "Risk Engine",
        status: "HEALTHY",
        latencyMs: riskTimed.latencyMs,
        message: risk.approved
          ? "APPROVED · risk accepted."
          : `REJECT · ${
              risk.diagnostics.rejectionCodes.join(", ") ||
              "risk conditions not satisfied"
            }`,
        checkedAt: now,
      },
      {
        id: "strategy",
        name: "Strategy Engine",
        status: "HEALTHY",
        latencyMs: strategyTimed.latencyMs,
        message: `${strategy.action} · ${
          strategy.selection.selected?.strategyId ?? "no candidate"
        }`,
        checkedAt: now,
      },
      {
        id: "ai",
        name: "AI Engine",
        status: "HEALTHY",
        latencyMs: aiTimed.latencyMs,
        message: `${ai.policy.action} · deterministic reviewer`,
        checkedAt: now,
      },
      mt5SystemService,
    ],
    control,
  };

  return {
    snapshot,
    strategyEvaluation: strategy,
    aiDecision: ai,
    riskAssessment: risk,
    signalResult: signalTimed.value,
    marketTimestamp: last.closeTime,
  };
}

export type CanonicalDecisionBundle =
  Awaited<ReturnType<typeof getCanonicalDecisionBundle>>;

export async function getDashboardSnapshot():
  Promise<DashboardSnapshot> {
  return (await getCanonicalDecisionBundle()).snapshot;
}