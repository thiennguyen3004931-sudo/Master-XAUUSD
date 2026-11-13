import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { __test } from "./phase7c-decision-audit.mjs";

const entryConditions = {
  configVersion: 3,
  side: "BUY",
  anchorCondition: "patternM15",
  enabledCount: 4,
  allEnabledPassed: false,
  failedConditions: ["supertrendM5"],
  conditions: [
    { id: "patternM15", enabled: true, mandatory: true, status: "PASS", observed: "BUY:BULLISH_ENGULFING" },
    { id: "supertrendM5", enabled: true, mandatory: false, status: "FAIL", observed: "SELL" },
    { id: "ma20Ma50", enabled: false, mandatory: false, status: "IGNORED", observed: "BUY" },
  ],
};

const blocked = __test.normalizeRecord(
  "TREND",
  "XAUUSD",
  {},
  "ENTRY_STRATEGY_CONDITION_BLOCK",
  {
    timestamp: 1_777_000_000_000,
    side: "BUY",
    reason: "supertrendM5",
    entryConditions,
  },
);
assert.equal(blocked.reasonCode, "ENTRY_STRATEGY_CONDITION_BLOCK");
assert.deepEqual(blocked.entryConditions, entryConditions);
assert.equal(blocked.entryConditions.configVersion, 3);
assert.deepEqual(blocked.entryConditions.failedConditions, ["supertrendM5"]);
assert.equal(blocked.entryConditions.conditions[2].status, "IGNORED");

const passed = __test.normalizeRecord(
  "TREND",
  "XAUUSD",
  {},
  "ENTRY_STRATEGY_CONDITIONS_PASS",
  {
    timestamp: 1_777_000_000_001,
    side: "BUY",
    entryConditions: { ...entryConditions, allEnabledPassed: true, failedConditions: [] },
  },
);
assert.equal(passed.reasonCode, "ENTRY_STRATEGY_CONDITIONS_PASS");
assert.equal(passed.entryConditions.allEnabledPassed, true);

const laterSafetyBlock = __test.normalizeRecord(
  "TREND",
  "XAUUSD",
  {},
  "ENTRY_SPREAD_BLOCK",
  {
    timestamp: 1_777_000_000_002,
    side: "BUY",
    reason: "SPREAD_TOO_WIDE",
  },
);
assert.equal(laterSafetyBlock.reasonCode, "ENTRY_SPREAD_BLOCK");
assert.match(laterSafetyBlock.reason, /SPREAD_TOO_WIDE/);
assert.equal(laterSafetyBlock.entryConditions, null);

const here = path.dirname(fileURLToPath(import.meta.url));
const monitorSource = fs.readFileSync(
  path.resolve(here, "../apps/api/src/services/phase7c-decision-monitor.service.ts"),
  "utf8",
);
assert.match(monitorSource, /interface EntryConditionsDecision/);
assert.match(monitorSource, /entryConditions\?:\s*EntryConditionsDecision\s*\|\s*null/);
assert.match(monitorSource, /strategyEntryConditions:\s*\{/);
assert.match(
  monitorSource,
  /trend:\s*input\.audit\.find\(\(row\)\s*=>\s*row\.strategy\s*===\s*"TREND"\s*&&\s*row\.entryConditions\)\?\.entryConditions\s*\?\?\s*null/,
);
assert.match(
  monitorSource,
  /sideway:\s*input\.audit\.find\(\(row\)\s*=>\s*row\.strategy\s*===\s*"SIDEWAY"\s*&&\s*row\.entryConditions\)\?\.entryConditions\s*\?\?\s*null/,
);
assert.match(monitorSource, /recentDecisions:\s*input\.audit\.slice\(0,\s*40\)/);

console.log("PHASE7C_STRATEGY_ENTRY_AUDIT_CONTRACT=PASS");
