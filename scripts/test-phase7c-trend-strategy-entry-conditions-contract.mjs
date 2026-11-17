import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createVirtualStrategyEntryConditionState,
  evaluateStrategyEntryConditions,
} from "./phase7c-strategy-entry-conditions.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const controllerPath = path.join(here, "run-phase7b-demo-controller.ts");
const source = fs.readFileSync(controllerPath, "utf8");

const defaults = createVirtualStrategyEntryConditionState();
const configurable = {
  ...defaults,
  trend: {
    ...defaults.trend,
    supertrendM15: false,
    supertrendM5: false,
    ma20Ma50: true,
    fvg: true,
  },
};
const sample = evaluateStrategyEntryConditions({
  strategy: "TREND",
  config: configurable,
  side: "BUY",
  observations: {
    patternM15: { passed: true, observed: "BUY:ENGULFING" },
    supertrendM15: { passed: false, observed: "SELL" },
    supertrendM5: { passed: false, observed: "SELL" },
    validTrendStructure: { passed: true, observed: "VALID" },
    ma20Ma50: { passed: false, observed: "SELL" },
    fvg: { passed: false, observed: "NONE" },
  },
});
assert.equal(sample.side, "BUY");
assert.equal(sample.conditions.find((row) => row.id === "patternM15")?.mandatory, true);
assert.equal(sample.conditions.find((row) => row.id === "patternM15")?.status, "PASS");
assert.equal(sample.conditions.find((row) => row.id === "supertrendM15")?.status, "IGNORED");
assert.equal(sample.conditions.find((row) => row.id === "supertrendM5")?.status, "IGNORED");
assert.equal(sample.conditions.find((row) => row.id === "ma20Ma50")?.status, "FAIL");
assert.equal(sample.conditions.find((row) => row.id === "fvg")?.status, "FAIL");

assert.match(
  source,
  /from\s+["']\.\/phase7c-strategy-entry-conditions\.mjs["']/,
  "RED_TARGET_IMPORT: Trend controller must import the canonical strategy-entry-condition module",
);
assert.match(source, /\bevaluateStrategyEntryConditions\b/);
assert.match(source, /\bcompareStrategyEntryConfigVersion\b/);
assert.match(source, /PHASE7C_STRATEGY_ENTRY_CONDITIONS_FILE/);
assert.match(source, /phase7c-strategy-entry-conditions\.json/);
assert.match(source, /\breadStrategyEntryConfigSnapshot\b/);

const latestSignalStart = source.indexOf("function latestSignal(");
const detectPatternStart = source.indexOf("function detectEntryPattern(", latestSignalStart);
assert.ok(latestSignalStart >= 0 && detectPatternStart > latestSignalStart, "Unable to isolate latestSignal().");
const latestSignalBlock = source.slice(latestSignalStart, detectPatternStart);
assert.match(latestSignalBlock, /detectEntryPattern\(m15, index\)/);
assert.match(latestSignalBlock, /evaluateStrategyEntryConditions\s*\(\s*\{/s);
assert.match(latestSignalBlock, /strategy:\s*["']TREND["']/);
assert.match(latestSignalBlock, /side:\s*trigger\.side/);
assert.match(latestSignalBlock, /patternM15:\s*\{[\s\S]*?passed:\s*true[\s\S]*?trigger\.side[\s\S]*?trigger\.pattern/);
assert.match(latestSignalBlock, /supertrendM15:\s*\{[\s\S]*?m15Direction\s*===\s*trigger\.side/);
assert.match(latestSignalBlock, /supertrendM5:\s*\{[\s\S]*?m5Direction\s*===\s*trigger\.side/);
assert.match(latestSignalBlock, /validTrendStructure:\s*\{[\s\S]*?structuralStopDistance\s*>\s*0/);
assert.match(latestSignalBlock, /ma20Ma50:\s*\{[\s\S]*?ma20[\s\S]*?ma50/);
assert.match(latestSignalBlock, /fvg:\s*\{[\s\S]*?fvgConfirmed/);
assert.doesNotMatch(
  latestSignalBlock,
  /if\s*\(\s*m15Direction\s*!==\s*trigger\.side\s*\|\|\s*m5Direction\s*!==\s*trigger\.side\s*\)\s*return\s+null/,
  "RED_TARGET_HARD_ST_GATE: Supertrend must be evaluated through configurable PASS/FAIL/IGNORED composition",
);

assert.match(source, /journal\(["']ENTRY_STRATEGY_CONDITION_BLOCK["'][\s\S]*?entryConditions/);
assert.match(source, /journal\(["']ENTRY_STRATEGY_CONDITIONS_PASS["'][\s\S]*?entryConditions/);

const pendingStart = source.indexOf("if (state.pendingPullback)");
const freshM15Start = source.indexOf("if (latestM15.closeTime <= state.lastEvaluatedM15Close)", pendingStart);
assert.ok(pendingStart >= 0 && freshM15Start > pendingStart, "Unable to isolate pending-pullback branch.");
const pendingBlock = source.slice(pendingStart, freshM15Start);
assert.match(pendingBlock, /readStrategyEntryConfigSnapshot\s*\(/);
assert.match(pendingBlock, /evaluateStrategyEntryConditions\s*\(\s*\{/s);
assert.match(pendingBlock, /patternM15:[\s\S]*?pending\.side[\s\S]*?pending\.pattern/);
assert.match(pendingBlock, /supertrendM15:[\s\S]*?m15Direction\s*===\s*pending\.side/);
assert.match(pendingBlock, /supertrendM5:[\s\S]*?m5Direction\s*===\s*pending\.side/);
assert.match(pendingBlock, /ma20Ma50:[\s\S]*?ma20[\s\S]*?ma50/);
assert.match(pendingBlock, /fvg:[\s\S]*?(?:hasRelevantFvg|fvgConfirmed)/);

const freshEntryBlock = source.slice(freshM15Start, source.indexOf("async function submitTrendEntry", freshM15Start));
assert.match(freshEntryBlock, /readStrategyEntryConfigSnapshot\s*\(/);
assert.match(freshEntryBlock, /latestSignal\([\s\S]*?strategy/);

const submitStart = source.indexOf("async function submitTrendEntry(");
const orderSubmitIndex = source.indexOf('const order = await post<OrderResponse>("/v1/orders"', submitStart);
assert.ok(submitStart >= 0 && orderSubmitIndex > submitStart, "Unable to locate Trend order boundary.");
const pendingDeclarationIndex = source.lastIndexOf("const pendingEntry: PendingTrendEntry", orderSubmitIndex);
assert.ok(pendingDeclarationIndex > submitStart, "Unable to locate durable pending entry before order boundary.");
const submitBeforePending = source.slice(submitStart, pendingDeclarationIndex);
const freshReadIndex = submitBeforePending.lastIndexOf("readStrategyEntryConfigSnapshot(");
const versionGuardIndex = submitBeforePending.lastIndexOf("compareStrategyEntryConfigVersion(");
assert.ok(freshReadIndex >= 0, "RED_TARGET_FINAL_REREAD: final order boundary must re-read current strategy config");
assert.ok(versionGuardIndex > freshReadIndex, "RED_TARGET_VERSION_GUARD: final order boundary must compare cycle/current config versions");
assert.match(submitBeforePending, /ENTRY_CONFIG_VERSION_CHANGED/);
assert.match(submitBeforePending, /ENTRY_STRATEGY_CONFIG_INVALID/);
assert.match(submitBeforePending, /return\s+["']REJECTED["']/);

console.log("PHASE7C_TREND_STRATEGY_ENTRY_CONDITIONS_CONTRACT=PASS");
