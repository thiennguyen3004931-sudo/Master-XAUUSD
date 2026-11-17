import type { Phase7Bar, Phase7RunRequest, Phase7RunResult, Phase7Side, Phase7TradeResult } from "../models";

type StopBucket = "FLOOR_6" | "STRUCT_6_TO_8" | "STRUCT_8_TO_10" | "CAP_10";
type ManagementStage = "PRE_PLUS6" | "PLUS6_ONLY" | "PLUS10_TRAIL";

export interface Phase7ADiagnosticRow {
  tradeId: string;
  side: Phase7Side;
  signalTimestamp: number;
  filled: boolean;
  pnl: number;
  rMultiple: number;
  stopBucket: StopBucket;
  structuralStopDistance: number;
  stopDistance: number;
  exitReason: Phase7TradeResult["exitReason"];
  managementStage: ManagementStage;
  mfePrice: number;
  maePrice: number;
  mfeR: number;
  maeR: number;
  ma20Ma50GapPct: number;
  ma50Ma200GapPct: number;
  fvgAgeBars: number | null;
  fvgWidth: number | null;
  realUtcHour: number;
  partialVsFullSameExitPnlDelta: number;
}

interface GroupSummary {
  cases: number;
  filled: number;
  winRatePercent: number;
  netPnl: number;
  profitFactor: number | null;
  expectancy: number;
  averageR: number;
  averageMfeR: number;
  averageMaeR: number;
  partialVsFullSameExitDelta: number;
}

export interface Phase7ADiagnosticsResult {
  rows: Phase7ADiagnosticRow[];
  lines: string[];
}

export class Phase7ADiagnosticsService {
  analyze(
    result: Phase7RunResult,
    request: Phase7RunRequest,
    datasetOffsetMs = 0,
  ): Phase7ADiagnosticsResult {
    const m15 = [...request.m15Bars].sort((a, b) => a.openTime - b.openTime);
    const m5 = [...request.m5Bars].sort((a, b) => a.openTime - b.openTime);
    const rows = result.trades.map((trade) => buildRow(trade, m15, m5, request, datasetOffsetMs));

    const lines: string[] = [
      "PHASE7A_MODE=DIAGNOSTIC_ONLY",
      "PHASE7A_STRATEGY_MUTATION=false",
      `PHASE7A_ROWS=${rows.length}`,
      formatGroup("PHASE7A_ALL", rows),
      formatGroup("PHASE7A_BUY", rows.filter((row) => row.side === "BUY")),
      formatGroup("PHASE7A_SELL", rows.filter((row) => row.side === "SELL")),
    ];

    for (const bucket of ["FLOOR_6", "STRUCT_6_TO_8", "STRUCT_8_TO_10", "CAP_10"] as const) {
      lines.push(formatGroup(`PHASE7A_STOP_${bucket}`, rows.filter((row) => row.stopBucket === bucket)));
      lines.push(formatGroup(`PHASE7A_STOP_${bucket}_BUY`, rows.filter((row) => row.stopBucket === bucket && row.side === "BUY")));
      lines.push(formatGroup(`PHASE7A_STOP_${bucket}_SELL`, rows.filter((row) => row.stopBucket === bucket && row.side === "SELL")));
    }

    for (const stage of ["PRE_PLUS6", "PLUS6_ONLY", "PLUS10_TRAIL"] as const) {
      lines.push(formatGroup(`PHASE7A_MGMT_${stage}`, rows.filter((row) => row.managementStage === stage)));
      lines.push(formatGroup(`PHASE7A_MGMT_${stage}_BUY`, rows.filter((row) => row.managementStage === stage && row.side === "BUY")));
      lines.push(formatGroup(`PHASE7A_MGMT_${stage}_SELL`, rows.filter((row) => row.managementStage === stage && row.side === "SELL")));
    }

    for (const reason of ["STOP", "TREND_MA20", "END_OF_DATA", "ENTRY_NOT_FILLED"] as const) {
      lines.push(formatGroup(`PHASE7A_EXIT_${reason}`, rows.filter((row) => row.exitReason === reason)));
    }

    for (const [name, start, end] of [
      ["UTC_00_07", 0, 8],
      ["UTC_08_12", 8, 13],
      ["UTC_13_17", 13, 18],
      ["UTC_18_23", 18, 24],
    ] as const) {
      lines.push(formatGroup(`PHASE7A_TIME_${name}`, rows.filter((row) => row.realUtcHour >= start && row.realUtcHour < end)));
    }

    const filled = rows.filter((row) => row.filled);
    const wins = filled.filter((row) => row.pnl > 0);
    const losses = filled.filter((row) => row.pnl < 0);
    lines.push(formatShape("PHASE7A_SHAPE_ALL", filled));
    lines.push(formatShape("PHASE7A_SHAPE_WIN", wins));
    lines.push(formatShape("PHASE7A_SHAPE_LOSS", losses));
    lines.push(formatShape("PHASE7A_SHAPE_BUY", filled.filter((row) => row.side === "BUY")));
    lines.push(formatShape("PHASE7A_SHAPE_SELL", filled.filter((row) => row.side === "SELL")));

    const partialDelta = round(filled.reduce((sum, row) => sum + row.partialVsFullSameExitPnlDelta, 0), 4);
    const partialHelped = filled.filter((row) => row.partialVsFullSameExitPnlDelta > 1e-9).length;
    const partialHurt = filled.filter((row) => row.partialVsFullSameExitPnlDelta < -1e-9).length;
    const partialNeutral = filled.length - partialHelped - partialHurt;
    lines.push(`PHASE7A_PARTIAL_COUNTERFACTUAL=SAME_EXIT_PATH|NET_DELTA=${partialDelta}|HELPED=${partialHelped}|HURT=${partialHurt}|NEUTRAL=${partialNeutral}`);
    lines.push("PHASE7A_NO_RETUNE=PASS");
    lines.push("PHASE7A_RESEARCH_ONLY=PASS");
    lines.push("PHASE7A_PRODUCTION_MUTATION=false");

    return { rows, lines };
  }
}

function buildRow(
  trade: Phase7TradeResult,
  m15: readonly Phase7Bar[],
  m5: readonly Phase7Bar[],
  request: Phase7RunRequest,
  datasetOffsetMs: number,
): Phase7ADiagnosticRow {
  const stopBucket = bucketStop(trade.structuralStopDistance);
  const managementStage: ManagementStage = trade.trailingActivated
    ? "PLUS10_TRAIL"
    : trade.protectedStopApplied
      ? "PLUS6_ONLY"
      : "PRE_PLUS6";

  const signalIndex = findSignalIndex(m15, trade.signalTimestamp);
  const current = signalIndex >= 0 ? m15[signalIndex]! : null;
  const fvg = current && signalIndex >= 2 ? findRelevantFvg(m15, signalIndex, trade.side, 12) : null;
  const ma20Ma50GapPct = trade.entry !== 0 ? Math.abs(trade.ma20 - trade.ma50) / Math.abs(trade.entry) * 100 : 0;
  const ma50Ma200GapPct = trade.entry !== 0 ? Math.abs(trade.ma50 - trade.ma200) / Math.abs(trade.entry) * 100 : 0;

  let mfePrice = 0;
  let maePrice = 0;
  if (trade.filled && trade.entryTime !== null) {
    const endTime = trade.exitTime ?? Number.POSITIVE_INFINITY;
    const active = m5.filter((bar) => bar.openTime >= trade.entryTime! && bar.openTime <= endTime);
    for (const bar of active) {
      const favorable = trade.side === "BUY" ? bar.high - trade.entry : trade.entry - bar.low;
      const adverse = trade.side === "BUY" ? trade.entry - bar.low : bar.high - trade.entry;
      mfePrice = Math.max(mfePrice, favorable);
      maePrice = Math.max(maePrice, adverse);
    }
  }

  const initialRiskPrice = trade.stopDistance > 0 ? trade.stopDistance : 1;
  const fullSameExitPnl = trade.filled && trade.exit !== null
    ? pnlUsd(trade.side, trade.entry, trade.exit, trade.volume, request.tickSize, request.tickValuePerLot)
    : 0;

  return {
    tradeId: trade.id,
    side: trade.side,
    signalTimestamp: trade.signalTimestamp,
    filled: trade.filled,
    pnl: trade.pnl,
    rMultiple: trade.rMultiple,
    stopBucket,
    structuralStopDistance: trade.structuralStopDistance,
    stopDistance: trade.stopDistance,
    exitReason: trade.exitReason,
    managementStage,
    mfePrice: round(mfePrice, 5),
    maePrice: round(maePrice, 5),
    mfeR: round(mfePrice / initialRiskPrice, 5),
    maeR: round(maePrice / initialRiskPrice, 5),
    ma20Ma50GapPct: round(ma20Ma50GapPct, 6),
    ma50Ma200GapPct: round(ma50Ma200GapPct, 6),
    fvgAgeBars: fvg?.ageBars ?? null,
    fvgWidth: fvg ? round(fvg.width, 5) : null,
    realUtcHour: new Date(trade.signalTimestamp - datasetOffsetMs).getUTCHours(),
    partialVsFullSameExitPnlDelta: round(trade.pnl - fullSameExitPnl, 4),
  };
}

function bucketStop(structural: number): StopBucket {
  if (structural < 6) return "FLOOR_6";
  if (structural < 8) return "STRUCT_6_TO_8";
  if (structural <= 10) return "STRUCT_8_TO_10";
  return "CAP_10";
}

function findSignalIndex(bars: readonly Phase7Bar[], signalTimestamp: number): number {
  return bars.findIndex((bar) => bar.closeTime === signalTimestamp);
}

function findRelevantFvg(
  bars: readonly Phase7Bar[],
  index: number,
  side: Phase7Side,
  lookback: number,
): { ageBars: number; width: number } | null {
  const start = Math.max(2, index - lookback);
  const current = bars[index]!;
  for (let i = index - 1; i >= start; i -= 1) {
    const first = bars[i - 2]!;
    const third = bars[i]!;
    if (side === "BUY" && third.low > first.high && current.low <= third.low && current.high >= first.high) {
      return { ageBars: index - i, width: third.low - first.high };
    }
    if (side === "SELL" && third.high < first.low && current.high >= third.high && current.low <= first.low) {
      return { ageBars: index - i, width: first.low - third.high };
    }
  }
  return null;
}

function formatGroup(name: string, rows: readonly Phase7ADiagnosticRow[]): string {
  const s = summarize(rows);
  return `${name}=CASES=${s.cases}|FILLED=${s.filled}|WR=${s.winRatePercent}|NET=${s.netPnl}|PF=${s.profitFactor ?? "INF"}|EXP=${s.expectancy}|AVG_R=${s.averageR}|MFE_R=${s.averageMfeR}|MAE_R=${s.averageMaeR}|PARTIAL_DELTA=${s.partialVsFullSameExitDelta}`;
}

function summarize(rows: readonly Phase7ADiagnosticRow[]): GroupSummary {
  const filled = rows.filter((row) => row.filled);
  const wins = filled.filter((row) => row.pnl > 0);
  const grossProfit = filled.reduce((sum, row) => sum + Math.max(0, row.pnl), 0);
  const grossLoss = Math.abs(filled.reduce((sum, row) => sum + Math.min(0, row.pnl), 0));
  const netPnl = filled.reduce((sum, row) => sum + row.pnl, 0);
  return {
    cases: rows.length,
    filled: filled.length,
    winRatePercent: round(filled.length ? wins.length / filled.length * 100 : 0, 2),
    netPnl: round(netPnl, 2),
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : null,
    expectancy: round(filled.length ? netPnl / filled.length : 0, 4),
    averageR: round(avg(filled.map((row) => row.rMultiple)), 4),
    averageMfeR: round(avg(filled.map((row) => row.mfeR)), 4),
    averageMaeR: round(avg(filled.map((row) => row.maeR)), 4),
    partialVsFullSameExitDelta: round(filled.reduce((sum, row) => sum + row.partialVsFullSameExitPnlDelta, 0), 2),
  };
}

function formatShape(name: string, rows: readonly Phase7ADiagnosticRow[]): string {
  const fvgAges = rows.map((row) => row.fvgAgeBars).filter((value): value is number => value !== null);
  const fvgWidths = rows.map((row) => row.fvgWidth).filter((value): value is number => value !== null);
  return `${name}=FILLED=${rows.length}|MA20_50_GAP_PCT=${round(avg(rows.map((row) => row.ma20Ma50GapPct)), 6)}|MA50_200_GAP_PCT=${round(avg(rows.map((row) => row.ma50Ma200GapPct)), 6)}|FVG_AGE_BARS=${round(avg(fvgAges), 3)}|FVG_WIDTH=${round(avg(fvgWidths), 5)}|MFE_R=${round(avg(rows.map((row) => row.mfeR)), 4)}|MAE_R=${round(avg(rows.map((row) => row.maeR)), 4)}`;
}

function pnlUsd(
  side: Phase7Side,
  entry: number,
  exit: number,
  volume: number,
  tickSize: number,
  tickValuePerLot: number,
): number {
  const move = side === "BUY" ? exit - entry : entry - exit;
  return move / tickSize * tickValuePerLot * volume;
}

function avg(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
