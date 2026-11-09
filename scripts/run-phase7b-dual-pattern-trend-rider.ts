import fs from "node:fs";
import { Phase7BDualPatternTrendRiderService } from "@xauusd/risk-engine";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env ${name}`);
  return value;
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const m15Path = requiredEnv("ZIQ_M15_JSON");
const m5Path = requiredEnv("ZIQ_M5_JSON");
const metaPath = requiredEnv("ZIQ_META_JSON");
const csvPath = requiredEnv("ZIQ_PHASE7B_CSV");
const fixedVolume = Number(process.env.ZIQ_FIXED_VOLUME ?? "0.03");

const m15 = readJson<any[]>(m15Path);
const m5 = readJson<any[]>(m5Path);
const meta = readJson<Record<string, unknown>>(metaPath);
const tickSize = Number(meta.tickSize);
const tickValuePerLot = Number(meta.effectiveTickValuePerLot);
const minVolume = Number(meta.minVolume ?? 0.01);
const volumeStep = Number(meta.volumeStep ?? minVolume);

if (!Array.isArray(m15) || !Array.isArray(m5)) {
  throw new Error("Phase 7B inputs must be JSON arrays.");
}
if (![fixedVolume, tickSize, tickValuePerLot, minVolume, volumeStep].every((value) => Number.isFinite(value) && value > 0)) {
  throw new Error("Phase 7B metadata/fixed-volume inputs are invalid.");
}

const service = new Phase7BDualPatternTrendRiderService();
const result = service.run({
  m15Bars: m15,
  m5Bars: m5,
  fixedVolume,
  tickSize,
  tickValuePerLot,
  minVolume,
  volumeStep,
});

for (const line of service.format(result)) console.log(line);

const headers = [
  "id", "side", "pattern", "signalTimestamp", "entry", "patternExtreme", "structuralStopDistance",
  "stopDistance", "stopLoss", "volume", "initialRiskUsd", "ma20", "ma50", "ma200", "filled",
  "entryTime", "breakEvenApplied", "partialApplied", "partialVolume", "partialPnl", "structuralTrailUpdates",
  "reversalExitApplied", "finalStopLoss", "exitReason", "exit", "exitTime", "pnl", "rMultiple", "holdHours",
  "remainingVolumeAtExit",
];
const rows = result.trades.map((trade) => headers.map((header) => csvEscape((trade as any)[header])).join(","));
fs.writeFileSync(csvPath, `${headers.join(",")}\n${rows.join("\n")}\n`, "utf8");

console.log(`PHASE7B_FIXED_VOLUME=${fixedVolume}`);
console.log(`PHASE7B_INPUT_M15=${m15Path}`);
console.log(`PHASE7B_INPUT_M5=${m5Path}`);
console.log(`PHASE7B_BROKER_MIN_VOLUME=${minVolume}`);
console.log(`PHASE7B_BROKER_VOLUME_STEP=${volumeStep}`);
console.log(`PHASE7B_CSV=${csvPath}`);
console.log("PHASE7B_VALIDATION_STATUS=RESEARCH_REPLAY_NOT_INDEPENDENT_HOLDOUT");
console.log("PHASE7B_DRIVER=STANDALONE");
