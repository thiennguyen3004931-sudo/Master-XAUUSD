import fs from "node:fs";
import { Phase7ADiagnosticsService, Phase7TrendRiderService } from "@xauusd/risk-engine";

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
const csvPath = requiredEnv("ZIQ_PHASE7A_CSV");
const fixedVolume = Number(process.env.ZIQ_FIXED_VOLUME ?? "0.03");

const m15 = readJson<any[]>(m15Path);
const m5 = readJson<any[]>(m5Path);
const meta = readJson<Record<string, unknown>>(metaPath);
const tickSize = Number(meta.tickSize);
const tickValuePerLot = Number(meta.effectiveTickValuePerLot);
const minVolume = Number(meta.minVolume ?? 0.01);
const volumeStep = Number(meta.volumeStep ?? minVolume);
const datasetOffsetMs = Number(meta.datasetOffsetMs ?? meta.brokerHostOffsetMs ?? 10_800_000);

if (!Array.isArray(m15) || !Array.isArray(m5)) throw new Error("Phase 7A inputs must be JSON arrays.");
if (![tickSize, tickValuePerLot, minVolume, volumeStep, fixedVolume].every((value) => Number.isFinite(value) && value > 0)) {
  throw new Error("Phase 7A metadata/fixed-volume inputs are invalid.");
}

const request = {
  m15Bars: m15,
  m5Bars: m5,
  fixedVolume,
  tickSize,
  tickValuePerLot,
  minVolume,
  volumeStep,
};

const phase7 = new Phase7TrendRiderService();
const phase7Result = phase7.run(request);
const diagnostics = new Phase7ADiagnosticsService().analyze(phase7Result, request, datasetOffsetMs);

for (const line of diagnostics.lines) console.log(line);

const headers = [
  "tradeId", "side", "signalTimestamp", "filled", "pnl", "rMultiple", "stopBucket",
  "structuralStopDistance", "stopDistance", "exitReason", "managementStage", "mfePrice", "maePrice",
  "mfeR", "maeR", "ma20Ma50GapPct", "ma50Ma200GapPct", "fvgAgeBars", "fvgWidth", "realUtcHour",
  "partialVsFullSameExitPnlDelta",
];
const rows = diagnostics.rows.map((row) => headers.map((header) => csvEscape((row as any)[header])).join(","));
fs.writeFileSync(csvPath, `${headers.join(",")}\n${rows.join("\n")}\n`, "utf8");

console.log(`PHASE7A_CSV=${csvPath}`);
console.log(`PHASE7A_FIXED_VOLUME=${fixedVolume}`);
console.log(`PHASE7A_DATASET_OFFSET_MS=${datasetOffsetMs}`);
console.log("PHASE7A_DRIVER=STANDALONE");
