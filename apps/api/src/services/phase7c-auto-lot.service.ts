import {
  getPhase7CAccountRisk,
  runPhase7CCanonicalBacktest,
  type Phase7CBacktestRequest,
} from "./phase7c.service";

export type Phase7CAutoLotBacktestRequest = Phase7CBacktestRequest & {
  riskPercent?: number;
  maxAutoLot?: number;
  startingBalance?: number;
};

type ShadowTrade = {
  entryTime: number;
  side: "BUY" | "SELL";
  pattern: string;
  stopDistance: number;
  fixedLot: number;
  fixedPnl: number;
  balanceBefore: number;
  targetRiskUsd: number;
  rawLot: number;
  autoLot: number;
  autoRiskUsd: number;
  autoRiskPercent: number;
  autoPnl: number;
  balanceAfter: number;
  status: "EXECUTE" | "BLOCK";
  reason: string;
};

type FixedScheduleTrade = {
  pnl: number;
  volume: number;
};

type DecisionCriterion = {
  key: string;
  label: string;
  pass: boolean;
  score: number;
  maxScore: number;
  detail: string;
};

export async function runPhase7CAutoLotBacktestComparison(input: Phase7CAutoLotBacktestRequest) {
  const fixedVolume = Number(input.fixedVolume ?? 0.03);
  const riskPercent = Number(input.riskPercent ?? 0.25);
  const maxAutoLot = Number(input.maxAutoLot ?? 0.03);

  if (!Number.isFinite(riskPercent) || riskPercent <= 0 || riskPercent > 5) {
    throw new Error("riskPercent must be > 0 and <= 5.");
  }
  if (!Number.isFinite(maxAutoLot) || maxAutoLot <= 0) {
    throw new Error("maxAutoLot must be positive.");
  }

  const [backtest, accountRisk] = await Promise.all([
    runPhase7CCanonicalBacktest({ from: input.from, to: input.to, fixedVolume }),
    getPhase7CAccountRisk(riskPercent, maxAutoLot),
  ]);

  const currentBalance = Number(accountRisk.account.accountBalance ?? 0);
  const requestedStartingBalance = Number(input.startingBalance ?? 0);
  const startingBalance = requestedStartingBalance > 0 ? requestedStartingBalance : currentBalance;
  if (!Number.isFinite(startingBalance) || startingBalance <= 0) {
    throw new Error("Auto Lot comparison requires a positive starting balance or a valid MT5 account balance.");
  }

  const step = Number(accountRisk.spec.volumeStep);
  const minVolume = Number(accountRisk.spec.minVolume);
  const brokerMaxVolume = Number(accountRisk.spec.maxVolume);
  const cashPerPriceUnitPerLot = Number(accountRisk.spec.cashPerPriceUnitPerLot);
  if (![step, minVolume, brokerMaxVolume, cashPerPriceUnitPerLot].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("Broker volume/risk specification is invalid for Auto Lot comparison.");
  }

  const fixedCompatible = canonicalCompatibleLot(fixedVolume, minVolume, step);
  if (Math.abs(fixedCompatible - fixedVolume) > step / 100) {
    throw new Error(
      `Fixed volume ${fixedVolume} does not preserve exact one-third partial management at broker volumeStep ${step}. Use a compatible volume such as 0.03, 0.06, 0.09...`,
    );
  }

  // Canonical backtest intentionally limits the returned journal to the latest
  // 500 selected trades. Both sizing lanes below use exactly that same schedule
  // so the comparison is apples-to-apples even when the full-period metrics
  // contain more historical trades.
  const chronological = [...backtest.trades].sort((left, right) => left.entryTime - right.entryTime);
  const shadowTrades: ShadowTrade[] = [];
  let balance = startingBalance;

  for (const trade of chronological) {
    const balanceBefore = balance;
    const targetRiskUsd = balanceBefore * riskPercent / 100;
    const oneLotRisk = trade.stopDistance * cashPerPriceUnitPerLot;
    const rawLot = oneLotRisk > 0 ? targetRiskUsd / oneLotRisk : 0;
    const cap = Math.min(rawLot, maxAutoLot, brokerMaxVolume);
    const autoLot = canonicalCompatibleLot(cap, minVolume, step);

    if (autoLot <= 0) {
      shadowTrades.push({
        entryTime: trade.entryTime,
        side: trade.side,
        pattern: trade.pattern,
        stopDistance: round(trade.stopDistance, 4),
        fixedLot: round(trade.volume, 4),
        fixedPnl: round(trade.pnl, 2),
        balanceBefore: round(balanceBefore, 2),
        targetRiskUsd: round(targetRiskUsd, 2),
        rawLot: round(rawLot, 4),
        autoLot: 0,
        autoRiskUsd: 0,
        autoRiskPercent: 0,
        autoPnl: 0,
        balanceAfter: round(balanceBefore, 2),
        status: "BLOCK",
        reason: "Risk/cap cannot support a broker-step lot that preserves exact +10 one-third partial management.",
      });
      continue;
    }

    const scale = trade.volume > 0 ? autoLot / trade.volume : 0;
    const autoRiskUsd = oneLotRisk * autoLot;
    const autoPnl = trade.pnl * scale;
    balance += autoPnl;

    shadowTrades.push({
      entryTime: trade.entryTime,
      side: trade.side,
      pattern: trade.pattern,
      stopDistance: round(trade.stopDistance, 4),
      fixedLot: round(trade.volume, 4),
      fixedPnl: round(trade.pnl, 2),
      balanceBefore: round(balanceBefore, 2),
      targetRiskUsd: round(targetRiskUsd, 2),
      rawLot: round(rawLot, 4),
      autoLot: round(autoLot, 4),
      autoRiskUsd: round(autoRiskUsd, 2),
      autoRiskPercent: round(balanceBefore > 0 ? autoRiskUsd / balanceBefore * 100 : 0, 4),
      autoPnl: round(autoPnl, 2),
      balanceAfter: round(balance, 2),
      status: "EXECUTE",
      reason: "Canonical-compatible sizing overlay; execution remains SHADOW only.",
    });
  }

  const executed = shadowTrades.filter((trade) => trade.status === "EXECUTE");
  const autoMetrics = summarizeShadow(executed, startingBalance);
  const fixedMetrics = summarizeFixedSchedule(chronological, startingBalance);
  const blockRatePercent = shadowTrades.length > 0
    ? (shadowTrades.length - executed.length) / shadowTrades.length * 100
    : 0;
  const riskStdDevPercent = stdDev(executed.map((trade) => trade.autoRiskPercent));
  const decision = buildDecision({
    sampleTrades: shadowTrades.length,
    blockRatePercent,
    riskPercent,
    riskStdDevPercent,
    fixed: fixedMetrics,
    auto: autoMetrics,
  });

  return {
    source: "PHASE7C_AUTO_LOT_SHADOW_COMPARISON",
    generatedAt: Date.now(),
    safety: {
      mode: "AUTO_LOT_SHADOW_BACKTEST",
      executionMutation: false,
      phase7bFixedVolumeUnchanged: true,
      liveUnlockAvailable: false,
      strategyRuleMutation: false,
    },
    configuration: {
      riskPercent,
      maxAutoLot,
      fixedVolume,
      startingBalance: round(startingBalance, 2),
      startingBalanceSource: requestedStartingBalance > 0 ? "USER_RESEARCH_INPUT" : "CURRENT_MT5_BALANCE",
      volumeStep: step,
      minVolume,
      managementCompatibility: "EXACT_ONE_THIRD_PARTIAL_ONLY",
      comparedTradeSchedule: chronological.length,
      fullPeriodCanonicalTrades: backtest.metrics.trades,
      journalTradeLimitApplied: backtest.metrics.trades > chronological.length,
    },
    fixed: fixedMetrics,
    autoLot: {
      ...autoMetrics,
      attemptedTrades: shadowTrades.length,
      executedTrades: executed.length,
      blockedTrades: shadowTrades.length - executed.length,
      blockRatePercent: round(blockRatePercent, 2),
      averageTargetRiskUsd: round(avg(shadowTrades.map((trade) => trade.targetRiskUsd)), 2),
      averageRiskUsd: round(avg(executed.map((trade) => trade.autoRiskUsd)), 2),
      averageRiskPercent: round(avg(executed.map((trade) => trade.autoRiskPercent)), 4),
      riskStdDevPercent: round(riskStdDevPercent, 4),
      minLot: executed.length ? round(Math.min(...executed.map((trade) => trade.autoLot)), 4) : 0,
      maxLot: executed.length ? round(Math.max(...executed.map((trade) => trade.autoLot)), 4) : 0,
      averageLot: round(avg(executed.map((trade) => trade.autoLot)), 4),
    },
    deltaAutoMinusFixed: {
      trades: executed.length - fixedMetrics.trades,
      netPnl: round(autoMetrics.netPnl - fixedMetrics.netPnl, 2),
      winRatePercent: round(autoMetrics.winRatePercent - fixedMetrics.winRatePercent, 2),
      profitFactor: autoMetrics.profitFactor !== null && fixedMetrics.profitFactor !== null
        ? round(autoMetrics.profitFactor - fixedMetrics.profitFactor, 4)
        : null,
      expectancy: round(autoMetrics.expectancy - fixedMetrics.expectancy, 4),
      maxDrawdownUsd: round(autoMetrics.maxDrawdownUsd - fixedMetrics.maxDrawdownUsd, 2),
      endingBalance: round(autoMetrics.endingBalance - fixedMetrics.endingBalance, 2),
    },
    decision,
    backtest,
    shadowTrades: shadowTrades.slice().reverse(),
    notes: [
      "Auto Lot is a SHADOW sizing overlay only. It never changes Phase 7B DEMO orders.",
      "Only lot sizes that preserve exact one-third partial management at broker volumeStep are allowed; otherwise the shadow trade is BLOCKED.",
      "Fixed and Auto metrics are computed on the same returned canonical trade schedule. If the full-period canonical run exceeds the journal limit, the comparison explicitly reports that limitation.",
      "Decision Score is a conservative research heuristic, not permission to activate Auto Lot execution. Samples below 30 compared trades always remain INSUFFICIENT_SAMPLE.",
      "BLOCKED trades do not re-open signal contention; this is a sizing study, not production-equivalent execution replay.",
      "Balance compounds only from shadow executed P/L. Commission, swap and tick-level slippage remain outside the Phase 7C replay.",
    ],
  };
}

function buildDecision(input: {
  sampleTrades: number;
  blockRatePercent: number;
  riskPercent: number;
  riskStdDevPercent: number;
  fixed: ReturnType<typeof summarizeFixedSchedule>;
  auto: ReturnType<typeof summarizeShadow>;
}) {
  const criteria: DecisionCriterion[] = [];

  const pnlRatio = ratioVsBaseline(input.auto.netPnl, input.fixed.netPnl);
  const pnlScore = input.auto.netPnl > 0 && pnlRatio >= 1 ? 25 : input.auto.netPnl > 0 && pnlRatio >= 0.9 ? 15 : 0;
  criteria.push({
    key: "NET_PNL",
    label: "Net P/L không suy giảm đáng kể",
    pass: pnlScore >= 15,
    score: pnlScore,
    maxScore: 25,
    detail: `Auto ${moneyText(input.auto.netPnl)} vs Fixed ${moneyText(input.fixed.netPnl)}.`,
  });

  const ddRatio = input.fixed.maxDrawdownUsd > 0
    ? input.auto.maxDrawdownUsd / input.fixed.maxDrawdownUsd
    : input.auto.maxDrawdownUsd <= 0 ? 0 : Number.POSITIVE_INFINITY;
  const ddScore = ddRatio <= 0.9 ? 20 : ddRatio <= 1 ? 16 : ddRatio <= 1.1 ? 8 : 0;
  criteria.push({
    key: "DRAWDOWN",
    label: "Drawdown không xấu hơn Fixed quá 10%",
    pass: ddRatio <= 1.1,
    score: ddScore,
    maxScore: 20,
    detail: `Auto $${input.auto.maxDrawdownUsd.toFixed(2)} vs Fixed $${input.fixed.maxDrawdownUsd.toFixed(2)}.`,
  });

  const fixedPf = finitePf(input.fixed.profitFactor);
  const autoPf = finitePf(input.auto.profitFactor);
  const pfDelta = autoPf - fixedPf;
  const pfScore = autoPf >= 1 && pfDelta >= 0 ? 20 : autoPf >= 1 && pfDelta >= -0.1 ? 12 : 0;
  criteria.push({
    key: "PROFIT_FACTOR",
    label: "Profit Factor giữ trên 1 và gần/nhỉnh hơn Fixed",
    pass: pfScore >= 12,
    score: pfScore,
    maxScore: 20,
    detail: `Auto ${pfText(input.auto.profitFactor)} vs Fixed ${pfText(input.fixed.profitFactor)}.`,
  });

  const expectancyRatio = ratioVsBaseline(input.auto.expectancy, input.fixed.expectancy);
  const expectancyScore = input.auto.expectancy > 0 && expectancyRatio >= 1
    ? 15
    : input.auto.expectancy > 0 && expectancyRatio >= 0.9
      ? 8
      : 0;
  criteria.push({
    key: "EXPECTANCY",
    label: "Expectancy dương và không suy giảm đáng kể",
    pass: expectancyScore >= 8,
    score: expectancyScore,
    maxScore: 15,
    detail: `Auto ${moneyText(input.auto.expectancy)}/trade vs Fixed ${moneyText(input.fixed.expectancy)}/trade.`,
  });

  const blockScore = input.blockRatePercent === 0 ? 10 : input.blockRatePercent <= 5 ? 6 : 0;
  criteria.push({
    key: "BLOCK_RATE",
    label: "Sizing BLOCK rate thấp",
    pass: input.blockRatePercent <= 5,
    score: blockScore,
    maxScore: 10,
    detail: `${input.blockRatePercent.toFixed(2)}% attempted trades bị BLOCK.`,
  });

  const riskTolerance = Math.max(0.01, input.riskPercent * 0.2);
  const riskScore = input.riskStdDevPercent <= riskTolerance ? 10 : input.riskStdDevPercent <= riskTolerance * 2 ? 5 : 0;
  criteria.push({
    key: "RISK_STABILITY",
    label: "Risk % thực tế ổn định quanh target",
    pass: riskScore >= 5,
    score: riskScore,
    maxScore: 10,
    detail: `StdDev risk ${input.riskStdDevPercent.toFixed(4)}pp; tolerance ${riskTolerance.toFixed(4)}pp.`,
  });

  const score = criteria.reduce((sum, criterion) => sum + criterion.score, 0);
  const hardReject = input.auto.netPnl <= 0 || autoPf < 1 || input.blockRatePercent > 10 || ddRatio > 1.25;
  let verdict: "INSUFFICIENT_SAMPLE" | "REJECT_AUTO_LOT" | "KEEP_FIXED" | "NEEDS_MORE_DATA" | "SHADOW_PROMISING";
  let reason: string;

  if (input.sampleTrades < 30) {
    verdict = "INSUFFICIENT_SAMPLE";
    reason = `Mới có ${input.sampleTrades} compared trades; cần ít nhất 30 trước khi đánh giá sizing.`;
  } else if (hardReject) {
    verdict = "REJECT_AUTO_LOT";
    reason = "Auto Lot fail một hard guard: Net/PF/BLOCK/DD chưa đủ chất lượng để xem xét tiếp.";
  } else if (score >= 75) {
    verdict = "SHADOW_PROMISING";
    reason = "Auto Lot đạt ngưỡng research tốt; tiếp tục SHADOW/forward validation, chưa bật execution.";
  } else if (score >= 60) {
    verdict = "NEEDS_MORE_DATA";
    reason = "Kết quả chưa đủ mạnh để thay Fixed; tiếp tục thu mẫu và kiểm tra nhiều khoảng thời gian.";
  } else {
    verdict = "KEEP_FIXED";
    reason = "Fixed sizing hiện có hồ sơ risk/return tốt hơn theo tiêu chí research này.";
  }

  return {
    score,
    maxScore: 100,
    verdict,
    reason,
    minimumSampleTrades: 30,
    sampleTrades: input.sampleTrades,
    executionEligible: false,
    criteria,
  };
}

function canonicalCompatibleLot(cap: number, minVolume: number, step: number): number {
  if (!(cap > 0) || !(minVolume > 0) || !(step > 0)) return 0;
  const minUnits = Math.max(1, Math.ceil((minVolume - 1e-12) / step));
  let units = Math.floor((cap + 1e-12) / step);
  while (units >= minUnits * 3) {
    if (units % 3 === 0 && units / 3 >= minUnits && (units * 2) / 3 >= minUnits) {
      return round(units * step, 8);
    }
    units -= 1;
  }
  return 0;
}

function summarizeFixedSchedule(trades: FixedScheduleTrade[], startingBalance: number) {
  const wins = trades.filter((trade) => trade.pnl > 0).length;
  const grossProfit = trades.reduce((sum, trade) => sum + Math.max(0, trade.pnl), 0);
  const grossLoss = Math.abs(trades.reduce((sum, trade) => sum + Math.min(0, trade.pnl), 0));
  const netPnl = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  let equity = startingBalance;
  let peak = startingBalance;
  let maxDrawdownUsd = 0;
  for (const trade of trades) {
    equity += trade.pnl;
    peak = Math.max(peak, equity);
    maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - equity);
  }
  return {
    trades: trades.length,
    winRatePercent: round(trades.length ? wins / trades.length * 100 : 0, 2),
    netPnl: round(netPnl, 2),
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : grossProfit > 0 ? null : 0,
    expectancy: round(trades.length ? netPnl / trades.length : 0, 4),
    maxDrawdownUsd: round(maxDrawdownUsd, 2),
    endingBalance: round(startingBalance + netPnl, 2),
    averageLot: round(avg(trades.map((trade) => trade.volume)), 4),
  };
}

function summarizeShadow(trades: ShadowTrade[], startingBalance: number) {
  const wins = trades.filter((trade) => trade.autoPnl > 0).length;
  const grossProfit = trades.reduce((sum, trade) => sum + Math.max(0, trade.autoPnl), 0);
  const grossLoss = Math.abs(trades.reduce((sum, trade) => sum + Math.min(0, trade.autoPnl), 0));
  const netPnl = trades.reduce((sum, trade) => sum + trade.autoPnl, 0);
  let equity = startingBalance;
  let peak = startingBalance;
  let maxDrawdownUsd = 0;
  for (const trade of trades) {
    equity += trade.autoPnl;
    peak = Math.max(peak, equity);
    maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - equity);
  }
  return {
    trades: trades.length,
    winRatePercent: round(trades.length ? wins / trades.length * 100 : 0, 2),
    netPnl: round(netPnl, 2),
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : grossProfit > 0 ? null : 0,
    expectancy: round(trades.length ? netPnl / trades.length : 0, 4),
    maxDrawdownUsd: round(maxDrawdownUsd, 2),
    endingBalance: round(startingBalance + netPnl, 2),
  };
}

function finitePf(value: number | null): number {
  return value === null ? 99 : Number.isFinite(value) ? value : 0;
}

function pfText(value: number | null): string {
  return value === null ? "∞" : value.toFixed(2);
}

function moneyText(value: number): string {
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`;
}

function ratioVsBaseline(value: number, baseline: number): number {
  if (baseline > 0) return value / baseline;
  if (value > baseline) return 1;
  return 0;
}

function avg(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = avg(values);
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
