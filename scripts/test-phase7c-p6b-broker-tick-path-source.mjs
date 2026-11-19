import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const requireLiteral = (source, needle, label) => {
  if (!source.includes(needle)) throw new Error(`${label} missing required literal: ${needle}`);
};

const app = read("packages/mt5-broker/bridge/mt5_bridge/app.py");
const ticks = read("packages/mt5-broker/bridge/mt5_bridge/historical_ticks.py");
const brokerTime = read("packages/mt5-broker/bridge/mt5_bridge/broker_time.py");
const evaluator = read("apps/api/src/services/phase7c-counterfactual-evaluator.service.ts");
const evidence = read("apps/api/src/services/phase7c-fastmove-replay-evidence.service.ts");

for (const literal of [
  '@app.get("/v1/history/ticks/{symbol}"',
  "historical_ticks(gateway, symbol, fromMs, toMs)",
  "normalize_ticks(",
]) requireLiteral(app, literal, "BRIDGE_APP");

for (const literal of [
  "copy_ticks_range",
  "COPY_TICKS_ALL",
  "denormalize_timestamp_ms",
  "TICK_RANGE_TOO_LARGE",
  "TICK_RANGE_TICK_LIMIT",
  "7 * 24 * 60 * 60 * 1000",
  "1_000_000",
  '"sequence"',
  '"timestamp"',
  '"bid"',
  '"ask"',
]) requireLiteral(ticks, literal, "HISTORICAL_TICKS");

requireLiteral(brokerTime, "def normalize_ticks(", "BROKER_TIME");

for (const literal of [
  "managementExitSideSamples",
  "brokerExitSideTicks",
  "exactFastMovePathEvidenceComplete",
  "MANAGEMENT_SAMPLES_PLUS_BROKER_TICKS_COMPLETE",
]) requireLiteral(evaluator, literal, "EVALUATOR");

for (const literal of [
  "MANAGEMENT_OBSERVED_WINDOW_INCOMPLETE",
  "MANAGEMENT_SAMPLE_NOT_IN_BROKER_TICKS",
  'verdict: "EXACT_PATH"',
  'verdict: "UNAVAILABLE"',
]) requireLiteral(evidence, literal, "P6B_EVIDENCE");

if (/\b(?:post|put|patch|delete)\b/i.test(app.split('@app.get("/v1/history/ticks/{symbol}"')[1]?.split("@app.")[0] ?? "")) {
  throw new Error("P6B tick-history route must remain GET-only.");
}
if (evaluator.includes('sources: ["ORDERED_EXIT_SIDE_PRICES_COMPLETE"]')) {
  throw new Error("Legacy ordered-price-only EXACT source must be removed.");
}

console.log("P6B_BROKER_TICK_PATH_SOURCE_CONTRACT=PASS");
console.log("P6B_HTTP_METHODS=GET_ONLY");
console.log("P6B_TRADING_MUTATION=NONE");
console.log("P6B_LEGACY_FALSE_EXACT=REJECTED");
