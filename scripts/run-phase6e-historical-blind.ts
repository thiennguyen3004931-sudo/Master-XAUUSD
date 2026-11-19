import fs from "node:fs";
import path from "node:path";
import {
  Phase6EHistoricalBlindService,
  Phase6M15TrendEngulfingService,
  type Phase6EExcursion,
  type Phase6TradeResult,
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
const maxRiskUsd = Number(process.env.ZIQ_MAX_RISK_USD ?? "10");
const auditCsv = process.env.ZIQ_PHASE6E_AUDIT_CSV;

const m15 = readJson<any[]>(m15Path);
const m5 = readJson<any[]>(m5Path);
const meta = readJson<any>(metaPath);
const blindMeta = meta.phase6eHistoricalBlind;
if (!blindMeta) throw new Error("Phase 6E prepared metadata is missing phase6eHistoricalBlind.");

const blindStartTimestamp = Number(
  process.env.ZIQ_PHASE6E_BLIND_START_MS ?? blindMeta.blindStartTimestamp,
);
const blindEndTimestamp = Number(
  process.env.ZIQ_PHASE6E_BLIND_END_MS ?? blindMeta.blindEndTimestamp,
);
const datasetOffsetMs = Number(
  process.env.ZIQ_PHASE6E_DATASET_OFFSET_MS ?? blindMeta.datasetOffsetMs ?? 10_800_000,
);
const tickSize = Number(meta.tickSize);
const tickValuePerLot = Number(meta.effectiveTickValuePerLot);
const minVolume = Number(meta.minVolume ?? 0.01);
const volumeStep = Number(meta.volumeStep ?? minVolume);

if (!Array.isArray(m15) || !Array.isArray(m5)) {
  throw new Error("Phase 6E prepared inputs must be JSON arrays.");
}
if (![tickSize, tickValuePerLot, minVolume, volumeStep, maxRiskUsd, blindStartTimestamp, blindEndTimestamp, datasetOffsetMs]
  .every((value) => Number.isFinite(value)) ||
  [tickSize, tickValuePerLot, minVolume, volumeStep, maxRiskUsd].some((value) => value <= 0)) {
  throw new Error("Phase 6E metadata/risk/boundary inputs are invalid.");
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
console.log(`PHASE6E_BASELINE_M15_BARS=${baseline.metrics.m15Bars}`);
console.log(`PHASE6E_BASELINE_ENGULFING_TRIGGERS=${baseline.metrics.engulfingTriggers}`);
console.log(`PHASE6E_BASELINE_TREND_ALIGNED=${baseline.metrics.trendAligned}`);
console.log(`PHASE6E_BASELINE_CONFLUENCE_PASSED=${baseline.metrics.confluencePassed}`);
console.log(`PHASE6E_BASELINE_RISK_BLOCKED=${baseline.metrics.riskBlocked}`);
console.log(`PHASE6E_BASELINE_SIGNALS=${baseline.metrics.signals}`);
console.log(`PHASE6E_BASELINE_BUY_SIGNALS=${baseline.metrics.buySignals}`);
console.log(`PHASE6E_BASELINE_SELL_SIGNALS=${baseline.metrics.sellSignals}`);
console.log(`PHASE6E_DATASET_OFFSET_MS=${datasetOffsetMs}`);
console.log(`PHASE6E_BLIND_START_REAL_UTC=${new Date(blindStartTimestamp - datasetOffsetMs).toISOString()}`);
console.log(`PHASE6E_BLIND_END_REAL_UTC=${new Date(blindEndTimestamp - datasetOffsetMs).toISOString()}`);

const service = new Phase6EHistoricalBlindService();
const result = service.run(baseline, m5, blindStartTimestamp, blindEndTimestamp);
for (const line of service.format(result)) console.log(line);

if (auditCsv) {
  writeAuditCsv(auditCsv, result.eligibleTrades, result.excursions, datasetOffsetMs);
  console.log(`PHASE6E_TRADE_AUDIT_COUNT=${result.eligibleTrades.length}`);
  console.log(`PHASE6E_TRADE_AUDIT_CSV=${path.resolve(auditCsv)}`);
  console.log("PHASE6E_TRADE_AUDIT=PASS");
}
console.log("PHASE6E_DRIVER=STANDALONE");

function writeAuditCsv(
  file: string,
  trades: readonly Phase6TradeResult[],
  excursions: readonly Phase6EExcursion[],
  offsetMs: number,
): void {
  const excursionById = new Map(excursions.map((item) => [item.id, item]));
  const headers = [
    "Sequence", "Id", "Side", "SignalDataset", "SignalRealUtc",
    "Entry", "StructuralSL", "Volume", "InitialRiskUsd", "InitialRiskPrice",
    "MA20", "MA50", "MA200", "ATR", "ConfluenceScore",
    "MaPullback", "Fvg", "VolumeProfile", "POC", "VAH", "VAL",
    "Filled", "EntryTimeDataset", "EntryTimeRealUtc",
    "ReachedPlus6", "BreakEvenApplied", "ReachedPlus10", "TrailingActivated",
    "FinalSL", "ExitReason", "Exit", "ExitTimeDataset", "ExitTimeRealUtc",
    "PnL", "RMultiple", "HoldHours", "Outcome",
    "MFEPrice", "MAEPrice", "MFER", "MAER",
    "MaxFavorablePrice", "MaxAdversePrice", "DistanceToPlus6",
  ];
  const rows = trades.map((trade, index) => {
    const excursion = excursionById.get(trade.id);
    const outcome = !trade.filled ? "UNFILLED" : trade.pnl > 0 ? "WIN" : trade.pnl < 0 ? "LOSS" : "FLAT";
    return [
      index + 1,
      trade.id,
      trade.side,
      isoOrBlank(trade.signalTimestamp),
      realIsoOrBlank(trade.signalTimestamp, offsetMs),
      trade.entry,
      trade.stopLoss,
      trade.volume,
      trade.initialRiskUsd,
      excursion?.initialRiskPrice ?? "",
      trade.ma20,
      trade.ma50,
      trade.ma200,
      trade.atr,
      trade.confluenceScore,
      passFail(trade.maPullback),
      passFail(trade.fvg),
      passFail(trade.volumeProfile),
      trade.profile?.poc ?? "",
      trade.profile?.vah ?? "",
      trade.profile?.val ?? "",
      passFail(trade.filled),
      isoOrBlank(trade.entryTime),
      realIsoOrBlank(trade.entryTime, offsetMs),
      passFail(trade.reachedPlus6),
      passFail(trade.breakEvenApplied),
      passFail(trade.reachedPlus10),
      passFail(trade.trailingActivated),
      trade.finalStopLoss,
      trade.exitReason,
      trade.exit ?? "",
      isoOrBlank(trade.exitTime),
      realIsoOrBlank(trade.exitTime, offsetMs),
      trade.pnl,
      trade.rMultiple,
      trade.holdHours,
      outcome,
      excursion?.mfePrice ?? "",
      excursion?.maePrice ?? "",
      excursion?.mfeR ?? "",
      excursion?.maeR ?? "",
      excursion?.maxFavorablePrice ?? "",
      excursion?.maxAdversePrice ?? "",
      excursion?.distanceToPlus6 ?? "",
    ];
  });
  const body = [headers, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\n") + "\n";
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(path.resolve(file), body, "utf8");
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
function isoOrBlank(timestamp: number | null): string {
  return timestamp === null ? "" : new Date(timestamp).toISOString();
}
function realIsoOrBlank(timestamp: number | null, offsetMs: number): string {
  return timestamp === null ? "" : new Date(timestamp - offsetMs).toISOString();
}
function passFail(value: boolean): string {
  return value ? "PASS" : "FAIL";
}
