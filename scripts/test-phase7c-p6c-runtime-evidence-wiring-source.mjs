import assert from "node:assert/strict";
import fs from "node:fs";

function read(path) {
  assert.equal(fs.existsSync(path), true, "Missing required P6C source file: " + path);
  return fs.readFileSync(path, "utf8");
}

const marketClient = read("packages/mt5-broker/src/market/Mt5MarketDataClient.ts");
const marketService = read("apps/api/src/services/mt5-market.service.ts");
const counterfactual = read("apps/api/src/services/phase7c-counterfactual-intelligence.service.ts");
const recommendation = read("apps/api/src/services/phase7c-recommendation-intelligence.service.ts");
const workflow = read(".github/workflows/phase7c-counterfactual-intelligence-ci.yml");

assert.match(marketClient, /getHistoricalTicks\s*\(/);
assert.match(marketClient, /\/v1\/history\/ticks\//);
assert.match(marketClient, /method:\s*"GET"/);
assert.doesNotMatch(marketClient, /history\/ticks[\s\S]{0,300}method:\s*"(POST|PUT|PATCH|DELETE)"/i);

assert.match(marketService, /getMt5HistoricalTicks/);
assert.match(marketService, /getClient\(\)\.getHistoricalTicks/);

for (const literal of [
  "getPhase7COrderedExitSideEvidence",
  "buildPhase7CFastMoveReplayEvidence",
  "getMt5HistoricalTicks",
  "buildPhase7CCounterfactualSnapshotFromRowsWithEvidence",
  "runtimeFastMoveEvidenceProvider",
  "managementExitSideSamples:",
  "brokerExitSideTicks:",
  "exactFastMovePathEvidenceComplete:",
]) {
  assert.equal(counterfactual.includes(literal), true, "P6C counterfactual wiring missing " + literal);
}
assert.doesNotMatch(counterfactual, /\bfetch\s*\(/);

assert.match(recommendation, /buildPhase7CCounterfactualSnapshotFromRowsWithEvidence/);
assert.match(recommendation, /runtimeFastMoveEvidenceProvider/);
assert.match(
  recommendation,
  /const counterfactual\s*=\s*await buildPhase7CCounterfactualSnapshotFromRowsWithEvidence\(\{/,
);
assert.match(recommendation, /rows:\s*effectiveness\.rows/);
assert.match(recommendation, /evidenceProvider:\s*runtimeFastMoveEvidenceProvider/);
assert.doesNotMatch(
  recommendation,
  /getPhase7CCounterfactualIntelligence\(query\)/,
);

for (const literal of [
  "scripts/phase7c-counterfactual-runtime-evidence.test.ts",
  "scripts/test-phase7c-p6c-runtime-evidence-wiring-source.mjs",
  "P6C runtime evidence wiring contract",
  "P6C runtime source wiring contract",
]) {
  assert.equal(workflow.includes(literal), true, "P6C workflow missing " + literal);
}

for (const forbidden of [
  "AUTO_APPLY=TRUE",
  "AUTO_RETUNE=TRUE",
  "PRODUCTION_MUTATION=TRUE",
  "LIVE_TEST_ORDER=TRUE",
]) {
  assert.equal(counterfactual.includes(forbidden), false);
  assert.equal(recommendation.includes(forbidden), false);
}

console.log("P6C_RUNTIME_EVIDENCE_SOURCE_CONTRACT=PASS");
console.log("P6C_TICKS_THROUGH_CANONICAL_MARKET_CLIENT=PASS");
console.log("P6C_P5_CONSUMES_EVIDENCE_AWARE_P4=PASS");
console.log("P6C_RUNTIME_MUTATION=NONE");
