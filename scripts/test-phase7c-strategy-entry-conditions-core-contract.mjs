import assert from "node:assert/strict";
import {
  STRATEGY_ENTRY_MANDATORY,
  createVirtualStrategyEntryConditionState,
  validateStrategyEntryConditionState,
  evaluateStrategyEntryConditions,
  compareStrategyEntryConfigVersion,
} from "./phase7c-strategy-entry-conditions.mjs";

const defaults = createVirtualStrategyEntryConditionState();

assert.equal(defaults.version, 0);
assert.equal(defaults.updatedAt, "1970-01-01T00:00:00.000Z");
assert.equal(defaults.updatedBy, "safe-default");
assert.deepEqual(defaults.trend, {
  patternM15: true,
  supertrendM15: true,
  supertrendM5: true,
  validTrendStructure: true,
  ma20Ma50: false,
  fvg: false,
});
assert.deepEqual(defaults.sideway, {
  rangingRegime: true,
  recommendedModeSideway: true,
  minimumRegimeConfidence: true,
  supplyDemandRange: true,
  rangeEdge: true,
  m5Confirmation: true,
});
assert.deepEqual(STRATEGY_ENTRY_MANDATORY, {
  TREND: ["patternM15"],
  SIDEWAY: ["rangeEdge"],
});

assert.equal(
  validateStrategyEntryConditionState(defaults, { allowVirtualVersionZero: true }).valid,
  true,
);

for (const [name, candidate] of [
  ["trend-anchor-disabled", { ...defaults, trend: { ...defaults.trend, patternM15: false } }],
  ["sideway-anchor-disabled", { ...defaults, sideway: { ...defaults.sideway, rangeEdge: false } }],
  ["unknown-root-key", { ...defaults, unknown: true }],
  ["unknown-trend-key", { ...defaults, trend: { ...defaults.trend, unknown: true } }],
  ["unknown-sideway-key", { ...defaults, sideway: { ...defaults.sideway, unknown: true } }],
  ["missing-trend-key", { ...defaults, trend: Object.fromEntries(Object.entries(defaults.trend).filter(([key]) => key !== "supertrendM5")) }],
  ["missing-sideway-key", { ...defaults, sideway: Object.fromEntries(Object.entries(defaults.sideway).filter(([key]) => key !== "m5Confirmation")) }],
  ["non-boolean-condition", { ...defaults, trend: { ...defaults.trend, supertrendM15: "true" } }],
  ["negative-version", { ...defaults, version: -1 }],
  ["zero-enabled-trend", { ...defaults, trend: Object.fromEntries(Object.keys(defaults.trend).map((key) => [key, false])) }],
  ["zero-enabled-sideway", { ...defaults, sideway: Object.fromEntries(Object.keys(defaults.sideway).map((key) => [key, false])) }],
]) {
  const validation = validateStrategyEntryConditionState(candidate, { allowVirtualVersionZero: true });
  assert.equal(validation.valid, false, `${name} must fail validation`);
  assert.equal(validation.reasonCode, "ENTRY_STRATEGY_CONFIG_INVALID");
}

const persistedZero = validateStrategyEntryConditionState(defaults, { allowVirtualVersionZero: false });
assert.equal(persistedZero.valid, false);
assert.equal(persistedZero.reasonCode, "ENTRY_STRATEGY_CONFIG_INVALID");

const trend = evaluateStrategyEntryConditions({
  strategy: "TREND",
  config: defaults,
  side: "BUY",
  observations: {
    patternM15: { passed: true, observed: "BULLISH_ENGULFING" },
    supertrendM15: { passed: true, observed: "BUY" },
    supertrendM5: { passed: false, observed: "SELL" },
    validTrendStructure: { passed: true, observed: "VALID" },
    ma20Ma50: { passed: false, observed: "SELL" },
    fvg: { passed: false, observed: "NONE" },
  },
});

assert.equal(trend.configVersion, 0);
assert.equal(trend.side, "BUY");
assert.equal(trend.anchorCondition, "patternM15");
assert.equal(trend.enabledCount, 4);
assert.equal(trend.allEnabledPassed, false);
assert.deepEqual(trend.failedConditions, ["supertrendM5"]);
assert.equal(trend.conditions.find((row) => row.id === "supertrendM5")?.status, "FAIL");
assert.equal(trend.conditions.find((row) => row.id === "ma20Ma50")?.status, "IGNORED");
assert.equal(trend.conditions.find((row) => row.id === "ma20Ma50")?.observed, "SELL");
assert.equal(trend.conditions.find((row) => row.id === "patternM15")?.mandatory, true);

const sidewayConfig = {
  ...defaults,
  sideway: {
    ...defaults.sideway,
    recommendedModeSideway: false,
    m5Confirmation: false,
  },
};
const sideway = evaluateStrategyEntryConditions({
  strategy: "SIDEWAY",
  config: sidewayConfig,
  side: "SELL",
  observations: {
    rangingRegime: { passed: true, observed: "RANGING" },
    recommendedModeSideway: { passed: false, observed: "TREND" },
    minimumRegimeConfidence: { passed: true, observed: 72 },
    supplyDemandRange: { passed: true, observed: "VALID" },
    rangeEdge: { passed: true, observed: "SUPPLY_EDGE" },
    m5Confirmation: { passed: false, observed: "NONE" },
  },
});
assert.equal(sideway.anchorCondition, "rangeEdge");
assert.equal(sideway.allEnabledPassed, true);
assert.equal(sideway.conditions.find((row) => row.id === "recommendedModeSideway")?.status, "IGNORED");
assert.equal(sideway.conditions.find((row) => row.id === "m5Confirmation")?.status, "IGNORED");
assert.equal(sideway.conditions.find((row) => row.id === "rangeEdge")?.status, "PASS");

assert.deepEqual(
  compareStrategyEntryConfigVersion({ version: 7, valid: true }, { version: 7, valid: true }),
  { ok: true },
);
assert.deepEqual(
  compareStrategyEntryConfigVersion({ version: 7, valid: true }, { version: 8, valid: true }),
  { ok: false, reasonCode: "ENTRY_CONFIG_VERSION_CHANGED" },
);
assert.deepEqual(
  compareStrategyEntryConfigVersion({ version: 7, valid: true }, { version: 7, valid: false }),
  { ok: false, reasonCode: "ENTRY_STRATEGY_CONFIG_INVALID" },
);
assert.deepEqual(
  compareStrategyEntryConfigVersion({ version: 7, valid: false }, { version: 7, valid: true }),
  { ok: false, reasonCode: "ENTRY_STRATEGY_CONFIG_INVALID" },
);

console.log("PHASE7C_STRATEGY_ENTRY_CORE_CONTRACT=PASS");
