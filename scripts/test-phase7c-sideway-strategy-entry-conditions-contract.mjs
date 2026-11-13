import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createVirtualStrategyEntryConditionState,
  evaluateStrategyEntryConditions,
} from "./phase7c-strategy-entry-conditions.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const controllerPath = path.join(here, "run-phase7c-sideway-controller.mjs");
const source = fs.readFileSync(controllerPath, "utf8");

const defaults = createVirtualStrategyEntryConditionState();
const configurable = {
  ...defaults,
  sideway: {
    ...defaults.sideway,
    rangingRegime: false,
    recommendedModeSideway: false,
    minimumRegimeConfidence: false,
    supplyDemandRange: true,
    rangeEdge: true,
    m5Confirmation: false,
  },
};
const sample = evaluateStrategyEntryConditions({
  strategy: "SIDEWAY",
  config: configurable,
  side: "BUY",
  observations: {
    rangingRegime: { passed: false, observed: "TRENDING" },
    recommendedModeSideway: { passed: false, observed: "TREND" },
    minimumRegimeConfidence: { passed: false, observed: 42 },
    supplyDemandRange: { passed: true, observed: "VALID" },
    rangeEdge: { passed: true, observed: "BUY" },
    m5Confirmation: { passed: false, observed: "NONE" },
  },
});
assert.equal(sample.conditions.find((row) => row.id === "rangeEdge")?.mandatory, true);
assert.equal(sample.conditions.find((row) => row.id === "rangeEdge")?.status, "PASS");
assert.equal(sample.conditions.find((row) => row.id === "rangingRegime")?.status, "IGNORED");
assert.equal(sample.conditions.find((row) => row.id === "recommendedModeSideway")?.status, "IGNORED");
assert.equal(sample.conditions.find((row) => row.id === "minimumRegimeConfidence")?.status, "IGNORED");
assert.equal(sample.conditions.find((row) => row.id === "m5Confirmation")?.status, "IGNORED");
assert.equal(sample.allEnabledPassed, true);

assert.match(
  source,
  /from\s+["']\.\/phase7c-strategy-entry-conditions\.mjs["']/,
  "RED_TARGET_IMPORT: Sideway controller must import the canonical strategy-entry-condition module",
);
assert.match(source, /\bevaluateStrategyEntryConditions\b/);
assert.match(source, /\bcompareStrategyEntryConfigVersion\b/);
assert.match(source, /PHASE7C_STRATEGY_ENTRY_CONDITIONS_FILE/);
assert.match(source, /phase7c-strategy-entry-conditions\.json/);
assert.match(source, /\breadStrategyEntryConfigSnapshot\b/);

assert.match(source, /strategy:\s*["']SIDEWAY["']/);
assert.match(source, /rangingRegime:\s*\{[\s\S]*?regime\?\.regime\s*===\s*["']RANGING["']/);
assert.match(source, /recommendedModeSideway:\s*\{[\s\S]*?regime\?\.recommendedMode\s*===\s*["']SIDEWAY["']/);
assert.match(source, /minimumRegimeConfidence:\s*\{[\s\S]*?minRegimeConfidence/);
assert.match(source, /supplyDemandRange:\s*\{[\s\S]*?Boolean\(regime\?\.supplyDemandRange\)/);
assert.match(source, /rangeEdge:\s*\{[\s\S]*?side\s*!==\s*null/);
assert.match(source, /m5Confirmation:\s*\{[\s\S]*?confirmation/);
assert.match(source, /journal\(["']ENTRY_STRATEGY_CONDITION_BLOCK["'][\s\S]*?entryConditions/);
assert.match(source, /journal\(["']ENTRY_STRATEGY_CONDITIONS_PASS["'][\s\S]*?entryConditions/);

assert.doesNotMatch(
  source,
  /if\s*\(\s*regime\?\.regime\s*!==\s*["']RANGING["'][\s\S]*?journal\(["']ENTRY_REGIME_BLOCK["']/,
  "RED_TARGET_HARD_REGIME_GATE: Sideway regime composition must be controlled by canonical PASS/FAIL/IGNORED evaluation",
);
assert.doesNotMatch(
  source,
  /if\s*\(\s*!side\s*\)\s*\{\s*journal\(["']ENTRY_LOCATION_BLOCK["']/,
  "RED_TARGET_HARD_RANGE_EDGE_GATE: rangeEdge must be evaluated through the canonical mandatory condition",
);
assert.doesNotMatch(
  source,
  /if\s*\(\s*!confirmation[\s\S]*?journal\(["']ENTRY_M5_CONFIRMATION_BLOCK["']/,
  "RED_TARGET_HARD_M5_GATE: M5 confirmation must be configurable through canonical composition",
);

const orderBoundary = source.indexOf('const order = await bridgeRequest("POST", "/v1/orders"');
assert.ok(orderBoundary > 0, "Unable to locate Sideway order boundary.");
const pendingBoundary = source.lastIndexOf("state.pendingEntry = {", orderBoundary);
assert.ok(pendingBoundary > 0, "Unable to locate durable pending entry before Sideway order boundary.");
const beforePending = source.slice(0, pendingBoundary);
const freshReadIndex = beforePending.lastIndexOf("readStrategyEntryConfigSnapshot(");
const versionGuardIndex = beforePending.lastIndexOf("compareStrategyEntryConfigVersion(");
assert.ok(freshReadIndex >= 0, "RED_TARGET_FINAL_REREAD: Sideway final order boundary must re-read strategy config");
assert.ok(versionGuardIndex > freshReadIndex, "RED_TARGET_VERSION_GUARD: Sideway final order boundary must compare cycle/current versions");
assert.match(beforePending.slice(Math.max(0, freshReadIndex - 1000)), /ENTRY_CONFIG_VERSION_CHANGED/);
assert.match(beforePending.slice(Math.max(0, freshReadIndex - 1000)), /ENTRY_STRATEGY_CONFIG_INVALID/);

// Existing independent safety boundaries must remain present and fail closed.
assert.match(source, /ENTRY_QUOTE_FRESHNESS_BLOCK/);
assert.match(source, /ENTRY_SPREAD_BLOCK/);
assert.match(source, /ENTRY_FINAL_GATE_BLOCK/);
assert.match(source, /ENTRY_AUTO_LOT_BLOCK/);
assert.match(source, /state\.pendingEntry\s*=\s*\{/);

console.log("PHASE7C_SIDEWAY_STRATEGY_ENTRY_CONDITIONS_CONTRACT=PASS");
