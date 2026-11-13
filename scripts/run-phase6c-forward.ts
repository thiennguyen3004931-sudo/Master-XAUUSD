import fs from "node:fs";
import {
  Phase6CForwardHoldoutService,
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
  throw new Error("Phase 6C merged inputs must be JSON arrays.");
}
if (![tickSize, tickValuePerLot, minVolume, volumeStep, maxRiskUsd]
  .every((value) => Number.isFinite(value) && value > 0)) {
  throw new Error("Phase 6C metadata/risk inputs are invalid.");
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
console.log(`PHASE6C_BASELINE_M15_BARS=${baseline.metrics.m15Bars}`);
console.log(`PHASE6C_BASELINE_SIGNALS=${baseline.metrics.signals}`);
console.log(`PHASE6C_BASELINE_BUY_SIGNALS=${baseline.metrics.buySignals}`);
console.log(`PHASE6C_BASELINE_SELL_SIGNALS=${baseline.metrics.sellSignals}`);
console.log(`PHASE6C_BASELINE_RISK_BLOCKED=${baseline.metrics.riskBlocked}`);

const holdout = new Phase6CForwardHoldoutService();
const result = holdout.run(baseline);
for (const line of holdout.format(result)) {
  console.log(line);
}
console.log("PHASE6C_DRIVER=STANDALONE");
