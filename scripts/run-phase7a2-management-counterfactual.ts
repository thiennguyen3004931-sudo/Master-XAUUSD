import fs from "node:fs";
import {
  Phase7A2ManagementCounterfactualService,
  Phase7TrendRiderService,
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
const fixedVolume = Number(process.env.ZIQ_FIXED_VOLUME ?? "0.03");

const m15 = readJson<any[]>(m15Path);
const m5 = readJson<any[]>(m5Path);
const meta = readJson<Record<string, unknown>>(metaPath);
const tickSize = Number(meta.tickSize);
const tickValuePerLot = Number(meta.effectiveTickValuePerLot);
const minVolume = Number(meta.minVolume ?? 0.01);
const volumeStep = Number(meta.volumeStep ?? minVolume);

if (!Array.isArray(m15) || !Array.isArray(m5)) {
  throw new Error("Phase 7A2 inputs must be JSON arrays.");
}
if (![tickSize, tickValuePerLot, minVolume, volumeStep, fixedVolume]
  .every((value) => Number.isFinite(value) && value > 0)) {
  throw new Error("Phase 7A2 metadata/fixed-volume inputs are invalid.");
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
const diagnostics = new Phase7A2ManagementCounterfactualService().analyze(phase7Result, request);

for (const line of diagnostics.lines) console.log(line);
console.log(`PHASE7A2_FIXED_VOLUME=${fixedVolume}`);
console.log(`PHASE7A2_INPUT_M15=${m15Path}`);
console.log(`PHASE7A2_INPUT_M5=${m5Path}`);
console.log("PHASE7A2_DRIVER=STANDALONE");
