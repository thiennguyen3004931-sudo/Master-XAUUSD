import fs from "node:fs";
import {
  Phase6ADiagnosticsService,
  Phase6DForwardHoldoutService,
  Phase6M15TrendEngulfingService,
  resolvePhase6DDatasetCutoffTimestamp,
} from "@xauusd/risk-engine";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env ${name}`);
  return value;
}
function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

const m15Path = requiredEnv("ZIQ_M15_JSON");
const m5Path = requiredEnv("ZIQ_M5_JSON");
const metaPath = requiredEnv("ZIQ_META_JSON");
const tradeAuditCsvPath = process.env.ZIQ_PHASE6D_TRADE_AUDIT_CSV?.trim() || null;
const maxRiskUsd = Number(process.env.ZIQ_MAX_RISK_USD ?? "10");

const m15 = readJson<any[]>(m15Path);
const m5 = readJson<any[]>(m5Path);
const meta = readJson<Record<string, unknown>>(metaPath);
const tickSize = Number(meta.tickSize);
const tickValuePerLot = Number(meta.effectiveTickValuePerLot);
const minVolume = Number(meta.minVolume ?? 0.01);
const volumeStep = Number(meta.volumeStep ?? minVolume);

if (!Array.isArray(m15) || !Array.isArray(m5)) {
  throw new Error("Phase 6D merged inputs must be JSON arrays.");
}
if (![tickSize, tickValuePerLot, minVolume, volumeStep, maxRiskUsd]
  .every((value) => Number.isFinite(value) && value > 0)) {
  throw new Error("Phase 6D metadata/risk inputs are invalid.");
}

const request = {
  m15Bars: m15,
  m5Bars: m5,
  riskCapUsd: maxRiskUsd,
  tickSize,
  tickValuePerLot,
  minVolume,
  volumeStep,
};

const phase6 = new Phase6M15TrendEngulfingService();
const baseline = phase6.run(request);
console.log(`PHASE6D_BASELINE_M15_BARS=${baseline.metrics.m15Bars}`);
console.log(`PHASE6D_BASELINE_SIGNALS=${baseline.metrics.signals}`);
console.log(`PHASE6D_BASELINE_BUY_SIGNALS=${baseline.metrics.buySignals}`);
console.log(`PHASE6D_BASELINE_SELL_SIGNALS=${baseline.metrics.sellSignals}`);
console.log(`PHASE6D_BASELINE_RISK_BLOCKED=${baseline.metrics.riskBlocked}`);

const cutoffTimestamp = resolvePhase6DDatasetCutoffTimestamp();
const diagnostics = new Phase6ADiagnosticsService().run(baseline, request);
const postCutoffRiskBlocked = diagnostics.riskBlockedSetups.filter(
  (setup) => setup.signalTimestamp > cutoffTimestamp,
);
const postCutoffRiskBlockedBuy = postCutoffRiskBlocked.filter(
  (setup) => setup.side === "BUY",
).length;
const postCutoffRiskBlockedSell = postCutoffRiskBlocked.filter(
  (setup) => setup.side === "SELL",
).length;
const postCutoffRiskFeasible = baseline.trades.filter(
  (trade) => trade.signalTimestamp > cutoffTimestamp,
);
const postCutoffRiskFeasibleBuy = postCutoffRiskFeasible.filter(
  (trade) => trade.side === "BUY",
).length;
const postCutoffRiskFeasibleSell = postCutoffRiskFeasible.filter(
  (trade) => trade.side === "SELL",
).length;

console.log(`PHASE6D_POST_CUTOFF_CONFLUENCE_PASSED=${postCutoffRiskBlocked.length + postCutoffRiskFeasible.length}`);
console.log(`PHASE6D_POST_CUTOFF_CONFLUENCE_BUY=${postCutoffRiskBlockedBuy + postCutoffRiskFeasibleBuy}`);
console.log(`PHASE6D_POST_CUTOFF_CONFLUENCE_SELL=${postCutoffRiskBlockedSell + postCutoffRiskFeasibleSell}`);
console.log(`PHASE6D_POST_CUTOFF_RISK_BLOCKED=${postCutoffRiskBlocked.length}`);
console.log(`PHASE6D_POST_CUTOFF_RISK_BLOCKED_BUY=${postCutoffRiskBlockedBuy}`);
console.log(`PHASE6D_POST_CUTOFF_RISK_BLOCKED_SELL=${postCutoffRiskBlockedSell}`);
console.log(`PHASE6D_POST_CUTOFF_RISK_FEASIBLE=${postCutoffRiskFeasible.length}`);
console.log(`PHASE6D_POST_CUTOFF_RISK_FEASIBLE_BUY=${postCutoffRiskFeasibleBuy}`);
console.log(`PHASE6D_POST_CUTOFF_RISK_FEASIBLE_SELL=${postCutoffRiskFeasibleSell}`);
console.log("PHASE6D_POST_CUTOFF_RISK_FUNNEL=PASS");

const holdout = new Phase6DForwardHoldoutService();
const result = holdout.run(baseline);
for (const line of holdout.format(result)) {
  console.log(line);
}

console.log(`PHASE6D_TRADE_AUDIT_COUNT=${result.eligibleTrades.length}`);
result.eligibleTrades.forEach((trade, index) => {
  console.log(formatTradeAuditLine(trade, index + 1, result.datasetOffsetMs));
});
if (tradeAuditCsvPath) {
  writeTradeAuditCsv(tradeAuditCsvPath, result.eligibleTrades, result.datasetOffsetMs);
  console.log(`PHASE6D_TRADE_AUDIT_CSV=${tradeAuditCsvPath}`);
}
console.log("PHASE6D_TRADE_AUDIT=PASS");
console.log("PHASE6D_DRIVER=STANDALONE");

function formatTradeAuditLine(
  trade: (typeof result.eligibleTrades)[number],
  sequence: number,
  datasetOffsetMs: number,
): string {
  const profile = trade.profile
    ? `POC:${trade.profile.poc},VAH:${trade.profile.vah},VAL:${trade.profile.val}`
    : "NONE";
  return [
    `PHASE6D_TRADE_AUDIT_${sequence}`,
    `ID=${trade.id}`,
    `SIDE=${trade.side}`,
    `SIGNAL_DATASET=${isoOrNone(trade.signalTimestamp)}`,
    `SIGNAL_REAL_UTC=${realIsoOrNone(trade.signalTimestamp, datasetOffsetMs)}`,
    `ENTRY=${trade.entry}`,
    `STRUCTURAL_SL=${trade.stopLoss}`,
    `VOLUME=${trade.volume}`,
    `INITIAL_RISK_USD=${trade.initialRiskUsd}`,
    `MA20=${trade.ma20}`,
    `MA50=${trade.ma50}`,
    `MA200=${trade.ma200}`,
    `ATR=${trade.atr}`,
    `CONFLUENCE=${trade.confluenceScore}/3`,
    `MA_PULLBACK=${passFail(trade.maPullback)}`,
    `FVG=${passFail(trade.fvg)}`,
    `VOLUME_PROFILE=${passFail(trade.volumeProfile)}`,
    `PROFILE=${profile}`,
    `FILLED=${passFail(trade.filled)}`,
    `ENTRY_TIME_DATASET=${isoOrNone(trade.entryTime)}`,
    `ENTRY_TIME_REAL_UTC=${realIsoOrNone(trade.entryTime, datasetOffsetMs)}`,
    `PLUS6=${passFail(trade.reachedPlus6)}`,
    `BREAK_EVEN=${passFail(trade.breakEvenApplied)}`,
    `PLUS10=${passFail(trade.reachedPlus10)}`,
    `TRAILING=${passFail(trade.trailingActivated)}`,
    `FINAL_SL=${trade.finalStopLoss}`,
    `EXIT_REASON=${trade.exitReason}`,
    `EXIT=${trade.exit ?? "NONE"}`,
    `EXIT_TIME_DATASET=${isoOrNone(trade.exitTime)}`,
    `EXIT_TIME_REAL_UTC=${realIsoOrNone(trade.exitTime, datasetOffsetMs)}`,
    `PNL=${trade.pnl}`,
    `R=${trade.rMultiple}`,
    `HOLD_H=${trade.holdHours}`,
    `OUTCOME=${outcome(trade.pnl, trade.filled)}`,
  ].join("|");
}

function writeTradeAuditCsv(
  file: string,
  trades: readonly (typeof result.eligibleTrades)[number][],
  datasetOffsetMs: number,
): void {
  const headers = [
    "Sequence", "Id", "Side", "SignalDataset", "SignalRealUtc", "Entry",
    "StructuralSL", "Volume", "InitialRiskUsd", "MA20", "MA50", "MA200",
    "ATR", "ConfluenceScore", "MAPullback", "FVG", "VolumeProfile", "POC",
    "VAH", "VAL", "Filled", "EntryTimeDataset", "EntryTimeRealUtc",
    "ReachedPlus6", "BreakEvenApplied", "ReachedPlus10", "TrailingActivated",
    "FinalSL", "ExitReason", "Exit", "ExitTimeDataset", "ExitTimeRealUtc",
    "PnL", "RMultiple", "HoldHours", "Outcome",
  ];
  const rows = trades.map((trade, index) => [
    index + 1,
    trade.id,
    trade.side,
    isoOrNone(trade.signalTimestamp),
    realIsoOrNone(trade.signalTimestamp, datasetOffsetMs),
    trade.entry,
    trade.stopLoss,
    trade.volume,
    trade.initialRiskUsd,
    trade.ma20,
    trade.ma50,
    trade.ma200,
    trade.atr,
    trade.confluenceScore,
    trade.maPullback,
    trade.fvg,
    trade.volumeProfile,
    trade.profile?.poc ?? "",
    trade.profile?.vah ?? "",
    trade.profile?.val ?? "",
    trade.filled,
    isoOrNone(trade.entryTime),
    realIsoOrNone(trade.entryTime, datasetOffsetMs),
    trade.reachedPlus6,
    trade.breakEvenApplied,
    trade.reachedPlus10,
    trade.trailingActivated,
    trade.finalStopLoss,
    trade.exitReason,
    trade.exit ?? "",
    isoOrNone(trade.exitTime),
    realIsoOrNone(trade.exitTime, datasetOffsetMs),
    trade.pnl,
    trade.rMultiple,
    trade.holdHours,
    outcome(trade.pnl, trade.filled),
  ]);
  const csv = [headers, ...rows]
    .map((row) => row.map(csvValue).join(","))
    .join("\n") + "\n";
  fs.writeFileSync(file, csv, "utf8");
}

function csvValue(value: unknown): string {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function passFail(value: boolean): "PASS" | "FAIL" {
  return value ? "PASS" : "FAIL";
}

function outcome(pnl: number, filled: boolean): "WIN" | "LOSS" | "FLAT" | "UNFILLED" {
  if (!filled) return "UNFILLED";
  if (pnl > 0) return "WIN";
  if (pnl < 0) return "LOSS";
  return "FLAT";
}

function isoOrNone(timestamp: number | null): string {
  return timestamp === null ? "NONE" : new Date(timestamp).toISOString();
}

function realIsoOrNone(timestamp: number | null, datasetOffsetMs: number): string {
  return timestamp === null ? "NONE" : new Date(timestamp - datasetOffsetMs).toISOString();
}
