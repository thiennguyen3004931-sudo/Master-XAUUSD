import type {
  Phase4M5Bar,
  Phase4ShadowManagementConfig,
  Phase4ShadowReplayMetrics,
  Phase4ShadowReplayResult,
  Phase4ShadowTradeCase,
  Phase4ShadowTradeResult,
} from "../models";

const DEFAULT_MANAGEMENT: Phase4ShadowManagementConfig = {
  breakEvenTriggerPrice: 6,
  breakEvenOffsetPrice: 0.1,
  trailingTriggerPrice: 10,
  trailingDistancePrice: 4,
};

export class Phase4ShadowReplayService {
  constructor(
    private readonly management: Phase4ShadowManagementConfig = DEFAULT_MANAGEMENT,
  ) {}

  run(cases: readonly Phase4ShadowTradeCase[]): Phase4ShadowReplayResult {
    const trades = cases.map((tradeCase) => this.simulate(tradeCase));
    return { metrics: this.metrics(trades), trades };
  }

  formatMetrics(metrics: Phase4ShadowReplayMetrics): string[] {
    return [
      `PHASE4C_TOTAL_CASES=${metrics.totalCases}`,
      `PHASE4C_FILLED_TRADES=${metrics.filledTrades}`,
      `PHASE4C_UNFILLED_TRADES=${metrics.unfilledTrades}`,
      `PHASE4C_WINS=${metrics.wins}`,
      `PHASE4C_LOSSES=${metrics.losses}`,
      `PHASE4C_FLAT=${metrics.flat}`,
      `PHASE4C_WIN_RATE=${metrics.winRatePercent}`,
      `PHASE4C_NET_PNL=${metrics.netPnl}`,
      `PHASE4C_PROFIT_FACTOR=${metrics.profitFactor ?? "INF"}`,
      `PHASE4C_EXPECTANCY=${metrics.expectancy}`,
      `PHASE4C_AVG_R=${metrics.averageRMultiple}`,
      `PHASE4C_AVG_MFE_PRICE=${metrics.averageMfePrice}`,
      `PHASE4C_AVG_MAE_PRICE=${metrics.averageMaePrice}`,
      `PHASE4C_REACHED_PLUS6=${metrics.reachedPlus6}`,
      `PHASE4C_REACHED_PLUS10=${metrics.reachedPlus10}`,
      `PHASE4C_BREAK_EVEN_APPLIED=${metrics.breakEvenApplied}`,
      `PHASE4C_TRAILING_ACTIVATED=${metrics.trailingActivated}`,
    ];
  }

  private simulate(input: Phase4ShadowTradeCase): Phase4ShadowTradeResult {
    const bars = input.m5Bars
      .filter((bar) => bar.closeTime >= input.signalTimestamp)
      .sort((a, b) => a.openTime - b.openTime);

    let entryTime: number | null = null;
    let activeStop = input.stopLoss;
    let mfePrice = 0;
    let maePrice = 0;
    let reachedPlus6 = false;
    let reachedPlus10 = false;
    let breakEvenApplied = false;
    let trailingActivated = false;

    for (const bar of bars) {
      if (entryTime === null) {
        if (bar.openTime > input.entryExpiresAt) break;
        if (!touchesPrice(bar, input.entry)) continue;
        entryTime = Math.max(bar.openTime, input.signalTimestamp);
      }

      const favorable = input.side === "BUY"
        ? bar.high - input.entry
        : input.entry - bar.low;
      const adverse = input.side === "BUY"
        ? input.entry - bar.low
        : bar.high - input.entry;
      mfePrice = Math.max(mfePrice, favorable);
      maePrice = Math.max(maePrice, adverse);

      const stopHit = touchesPrice(bar, activeStop);
      const tpHit = touchesPrice(bar, input.takeProfit);

      // Conservative same-bar ordering: existing stop/TP is honored before
      // any management update generated from the same OHLC bar.
      if (stopHit || tpHit) {
        const stopFirst = stopHit;
        const exit = stopFirst ? activeStop : input.takeProfit;
        return this.closed(
          input,
          entryTime,
          bar.closeTime,
          exit,
          activeStop,
          mfePrice,
          maePrice,
          reachedPlus6,
          reachedPlus10,
          breakEvenApplied,
          trailingActivated,
          stopFirst ? "STOP" : "TAKE_PROFIT",
        );
      }

      if (favorable >= this.management.breakEvenTriggerPrice) {
        reachedPlus6 = true;
        breakEvenApplied = true;
        const be = input.side === "BUY"
          ? input.entry + this.management.breakEvenOffsetPrice
          : input.entry - this.management.breakEvenOffsetPrice;
        activeStop = improveStop(input.side, activeStop, be);
      }

      if (favorable >= this.management.trailingTriggerPrice) {
        reachedPlus10 = true;
        trailingActivated = true;
        const trail = input.side === "BUY"
          ? bar.high - this.management.trailingDistancePrice
          : bar.low + this.management.trailingDistancePrice;
        activeStop = improveStop(input.side, activeStop, trail);
      }
    }

    if (entryTime === null) {
      return {
        id: input.id,
        side: input.side,
        entrySource: input.entrySource ?? "CANONICAL",
        filled: false,
        entryTime: null,
        exitTime: null,
        entry: input.entry,
        exit: null,
        initialStopLoss: input.stopLoss,
        finalStopLoss: input.stopLoss,
        takeProfit: input.takeProfit,
        pnl: 0,
        initialRiskUsd: riskUsd(input, input.entry, input.stopLoss),
        rMultiple: 0,
        mfePrice: 0,
        maePrice: 0,
        reachedPlus6: false,
        reachedPlus10: false,
        breakEvenApplied: false,
        trailingActivated: false,
        exitReason: "ENTRY_NOT_FILLED",
      };
    }

    const last = bars.at(-1)!;
    const exit = last.close;
    return this.closed(
      input,
      entryTime,
      last.closeTime,
      exit,
      activeStop,
      mfePrice,
      maePrice,
      reachedPlus6,
      reachedPlus10,
      breakEvenApplied,
      trailingActivated,
      "END_OF_DATA",
    );
  }

  private closed(
    input: Phase4ShadowTradeCase,
    entryTime: number,
    exitTime: number,
    exit: number,
    finalStop: number,
    mfePrice: number,
    maePrice: number,
    reachedPlus6: boolean,
    reachedPlus10: boolean,
    breakEvenApplied: boolean,
    trailingActivated: boolean,
    exitReason: string,
  ): Phase4ShadowTradeResult {
    const pnl = pnlUsd(input, exit);
    const initialRiskUsd = riskUsd(input, input.entry, input.stopLoss);
    return {
      id: input.id,
      side: input.side,
      entrySource: input.entrySource ?? "CANONICAL",
      filled: true,
      entryTime,
      exitTime,
      entry: input.entry,
      exit,
      initialStopLoss: input.stopLoss,
      finalStopLoss: finalStop,
      takeProfit: input.takeProfit,
      pnl: round(pnl),
      initialRiskUsd: round(initialRiskUsd),
      rMultiple: initialRiskUsd > 0 ? round(pnl / initialRiskUsd, 4) : 0,
      mfePrice: round(mfePrice, 4),
      maePrice: round(maePrice, 4),
      reachedPlus6,
      reachedPlus10,
      breakEvenApplied,
      trailingActivated,
      exitReason,
    };
  }

  private metrics(trades: readonly Phase4ShadowTradeResult[]): Phase4ShadowReplayMetrics {
    const filled = trades.filter((trade) => trade.filled);
    const wins = filled.filter((trade) => trade.pnl > 0);
    const losses = filled.filter((trade) => trade.pnl < 0);
    const flat = filled.length - wins.length - losses.length;
    const grossProfit = wins.reduce((sum, trade) => sum + trade.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0));
    const netPnl = filled.reduce((sum, trade) => sum + trade.pnl, 0);

    return {
      totalCases: trades.length,
      filledTrades: filled.length,
      unfilledTrades: trades.length - filled.length,
      wins: wins.length,
      losses: losses.length,
      flat,
      winRatePercent: round(filled.length ? (wins.length / filled.length) * 100 : 0),
      netPnl: round(netPnl),
      grossProfit: round(grossProfit),
      grossLoss: round(grossLoss),
      profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : null,
      expectancy: round(filled.length ? netPnl / filled.length : 0, 4),
      averageRMultiple: round(avg(filled.map((trade) => trade.rMultiple)), 4),
      averageMfePrice: round(avg(filled.map((trade) => trade.mfePrice)), 4),
      averageMaePrice: round(avg(filled.map((trade) => trade.maePrice)), 4),
      reachedPlus6: filled.filter((trade) => trade.reachedPlus6).length,
      reachedPlus10: filled.filter((trade) => trade.reachedPlus10).length,
      breakEvenApplied: filled.filter((trade) => trade.breakEvenApplied).length,
      trailingActivated: filled.filter((trade) => trade.trailingActivated).length,
    };
  }
}

function touchesPrice(bar: Phase4M5Bar, price: number): boolean {
  return bar.low <= price && price <= bar.high;
}

function improveStop(side: "BUY" | "SELL", current: number, candidate: number): number {
  return side === "BUY" ? Math.max(current, candidate) : Math.min(current, candidate);
}

function riskUsd(input: Phase4ShadowTradeCase, entry: number, stop: number): number {
  const ticks = Math.abs(entry - stop) / input.tickSize;
  return ticks * input.tickValuePerLot * input.volume;
}

function pnlUsd(input: Phase4ShadowTradeCase, exit: number): number {
  const priceMove = input.side === "BUY" ? exit - input.entry : input.entry - exit;
  return (priceMove / input.tickSize) * input.tickValuePerLot * input.volume;
}

function avg(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}
