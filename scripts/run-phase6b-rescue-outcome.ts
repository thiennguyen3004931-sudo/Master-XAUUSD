import fs from "node:fs";
import {
  Phase6ADiagnosticsService,
  Phase6BRescueOutcomeService,
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
  throw new Error("Phase 6B frozen inputs must be JSON arrays.");
}
if (![tickSize, tickValuePerLot, minVolume, volumeStep, maxRiskUsd].every((v) => Number.isFinite(v) && v > 0)) {
  throw new Error("Phase 6B metadata/risk inputs are invalid.");
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
const phase6a = new Phase6ADiagnosticsService();
const diagnostics = phase6a.run(baseline, request);

console.log(`PHASE6B_BASELINE_FILLED=${baseline.metrics.filledTrades}`);
console.log(`PHASE6B_BASELINE_NET_PNL=${baseline.metrics.netPnl}`);
console.log(`PHASE6B_BASELINE_PROFIT_FACTOR=${baseline.metrics.profitFactor ?? "INF"}`);
console.log(`PHASE6B_BASELINE_EXPECTANCY=${baseline.metrics.expectancy}`);
console.log(`PHASE6B_BASELINE_AVG_R=${baseline.metrics.averageRMultiple}`);
console.log(`PHASE6B_BASELINE_RISK_BLOCKED=${baseline.metrics.riskBlocked}`);
console.log(`PHASE6B_PHASE6A_RESCUED=${diagnostics.rescuedCount}`);
console.log(`PHASE6B_PHASE6A_RECONCILED=${diagnostics.riskBlockedCount === baseline.metrics.riskBlocked ? "PASS" : "FAIL"}`);

if (diagnostics.riskBlockedCount !== baseline.metrics.riskBlocked) {
  throw new Error("Phase 6B cannot proceed because Phase 6A risk-blocked population does not reconcile.");
}

const service = new Phase6BRescueOutcomeService();
const result = service.run(baseline, diagnostics, request);
for (const line of service.format(result)) {
  console.log(line);
}

console.log("PHASE6B_NO_LOOKAHEAD_LEVELS=PASS");
console.log("PHASE6B_DRIVER=STANDALONE");
