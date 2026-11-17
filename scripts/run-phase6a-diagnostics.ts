import fs from "node:fs";
import {
  Phase6ADiagnosticsService,
  Phase6M15TrendEngulfingService,
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

const m15 = readJson<any[]>(m15Path);
const m5 = readJson<any[]>(m5Path);
const meta = readJson<Record<string, unknown>>(metaPath);

const tickSize = Number(meta.tickSize);
const tickValuePerLot = Number(meta.effectiveTickValuePerLot);
const minVolume = Number(meta.minVolume ?? 0.01);
const volumeStep = Number(meta.volumeStep ?? minVolume);

if (!Array.isArray(m15) || !Array.isArray(m5)) {
  throw new Error("Phase 6A frozen inputs must be JSON arrays.");
}
if (![tickSize, tickValuePerLot, minVolume, volumeStep, maxRiskUsd].every((v) => Number.isFinite(v) && v > 0)) {
  throw new Error("Phase 6A metadata/risk inputs are invalid.");
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

console.log(`PHASE6A_BASELINE_FILLED=${baseline.metrics.filledTrades}`);
console.log(`PHASE6A_BASELINE_NET_PNL=${baseline.metrics.netPnl}`);
console.log(`PHASE6A_BASELINE_PROFIT_FACTOR=${baseline.metrics.profitFactor ?? "INF"}`);
console.log(`PHASE6A_BASELINE_EXPECTANCY=${baseline.metrics.expectancy}`);
console.log(`PHASE6A_BASELINE_AVG_R=${baseline.metrics.averageRMultiple}`);
console.log(`PHASE6A_BASELINE_RISK_BLOCKED=${baseline.metrics.riskBlocked}`);

const service = new Phase6ADiagnosticsService();
const result = service.run(baseline, request);
for (const line of service.format(result)) {
  console.log(line);
}

console.log("PHASE6A_DRIVER=STANDALONE");
