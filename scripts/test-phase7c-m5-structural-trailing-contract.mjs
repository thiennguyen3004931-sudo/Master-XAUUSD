import assert from "node:assert/strict";
import fs from "node:fs";

import {
  evaluateM5StructuralTrail,
  latestConfirmedM5Structure,
} from "./phase7c-m5-structural-trailing.mjs";
import {
  transformPhase7CSidewayM5TrailingSource,
  transformPhase7CTrendM5TrailingSource,
} from "./phase7c-m5-structural-trailing-source-adapter.mjs";

const bars = [
  { closeTime: 1_000, low: 106, high: 112 },
  { closeTime: 2_000, low: 105, high: 111 },
  { closeTime: 3_000, low: 107, high: 113 },
  { closeTime: 4_000, low: 108, high: 114 },
  { closeTime: 5_000, low: 109, high: 115 },
];

assert.equal(
  latestConfirmedM5Structure({
    side: "BUY",
    bars,
    afterTimestamp: 0,
    atOrBefore: 2_000,
  }),
  null,
  "A swing must not be usable until the right-side M5 candle has closed.",
);
assert.deepEqual(
  latestConfirmedM5Structure({
    side: "BUY",
    bars,
    afterTimestamp: 0,
    atOrBefore: 3_000,
  }),
  { price: 105, confirmedAt: 3_000, pivotCloseTime: 2_000 },
  "BUY trailing must use the latest confirmed M5 swing low.",
);

const buyTrail = evaluateM5StructuralTrail({
  side: "BUY",
  bars,
  afterTimestamp: 0,
  atOrBefore: 5_000,
  currentStop: 100,
  lastStructuralStop: 100,
  bid: 112,
  ask: 112.2,
  digits: 2,
  point: 0.01,
  stopsLevelTicks: 10,
  freezeLevelTicks: 5,
});
assert.equal(buyTrail.allowed, true);
assert.equal(buyTrail.stopLoss, 104, "BUY must trail 1.0 below the confirmed M5 swing low.");
assert.equal(buyTrail.structurePrice, 105);

const neverLoosen = evaluateM5StructuralTrail({
  side: "BUY",
  bars,
  afterTimestamp: 0,
  atOrBefore: 5_000,
  currentStop: 104.5,
  lastStructuralStop: 104.5,
  bid: 112,
  ask: 112.2,
  digits: 2,
  point: 0.01,
  stopsLevelTicks: 10,
  freezeLevelTicks: 5,
});
assert.equal(neverLoosen.allowed, false);
assert.equal(neverLoosen.reason, "NOT_STRICTLY_TIGHTER");
assert.equal(
  neverLoosen.confirmedAt,
  3_000,
  "Confirmed M5 structure ownership must remain observable even when its candidate cannot tighten the current Fast-Move floor.",
);

const sellBars = [
  { closeTime: 1_000, low: 98, high: 104 },
  { closeTime: 2_000, low: 97, high: 105 },
  { closeTime: 3_000, low: 96, high: 103 },
];
const sellTrail = evaluateM5StructuralTrail({
  side: "SELL",
  bars: sellBars,
  afterTimestamp: 0,
  atOrBefore: 3_000,
  currentStop: 110,
  lastStructuralStop: 110,
  bid: 98.8,
  ask: 99,
  digits: 2,
  point: 0.01,
  stopsLevelTicks: 10,
  freezeLevelTicks: 5,
});
assert.equal(sellTrail.allowed, true);
assert.equal(sellTrail.stopLoss, 106, "SELL must trail 1.0 above the confirmed M5 swing high.");

const trendSource = fs.readFileSync(new URL("./run-phase7b-demo-controller.ts", import.meta.url), "utf8");
const transformedTrend = transformPhase7CTrendM5TrailingSource(trendSource);
assert.match(transformedTrend, /PHASE7B_DEMO_RUNNER_SL=M5_CONFIRMED_STRUCTURE_TRAILING/);
assert.match(transformedTrend, /PHASE7B_DEMO_POST_PLUS10_SL=M5_CONFIRMED_SWING_STRUCTURE_PLUS_1_BUFFER_ONLY_TIGHTEN/);
assert.match(transformedTrend, /evaluateM5StructuralTrail/);
assert.match(transformedTrend, /m5CloseTime/);
assert.doesNotMatch(transformedTrend, /const structure = latestConfirmedStructureStop\(managed\.side, m15/);
assert.match(
  transformedTrend,
  /const fastMoveStructure = managed\.partialApplied && latestM5[\s\S]*?latestConfirmedM5Structure\([\s\S]*?if \(fastMoveStructure === null\) \{[\s\S]*?fastMoveProfitLockCandidate/,
  "RED_TARGET: canonical Trend Fast-Move must hand off to confirmed M5 structure, not M15 structure.",
);
assert.doesNotMatch(
  transformedTrend,
  /const fastMoveStructure = managed\.partialApplied && latestM15[\s\S]*?latestConfirmedStructureStop/,
  "Canonical Trend source must not retain the old M15 Fast-Move ownership signal.",
);
assert.match(
  transformedTrend,
  /fastMoveHandedOffToM5[\s\S]*?saveState\(\)[\s\S]*?if \(fastMoveStructure === null\)/,
  "Trend M5 handoff must be durably persisted so Fast-Move cannot resume after M5 data later becomes stale or rolls out of the candle window.",
);

const sidewaySource = fs.readFileSync(new URL("./run-phase7c-sideway-controller.mjs", import.meta.url), "utf8");
const transformedSideway = transformPhase7CSidewayM5TrailingSource(sidewaySource);
assert.match(transformedSideway, /PHASE7C_SIDEWAY_MANAGEMENT=BROKER_TP_SL_PLUS_MONOTONIC_STOP_TIGHTENING_PLUS_M5_STRUCTURE/);
assert.match(transformedSideway, /SIDEWAY_M5_STRUCTURAL_SL_TIGHTEN/);
assert.match(transformedSideway, /managed\.partialApplied/);
assert.match(transformedSideway, /evaluateM5StructuralTrail/);
assert.match(
  transformedSideway,
  /const fastMoveStructure = managed\.partialApplied[\s\S]*?latestConfirmedM5Structure\([\s\S]*?if \(fastMoveStructure === null\) \{[\s\S]*?fastMoveProfitLockCandidate/,
  "RED_TARGET: canonical Sideway Fast-Move must stop advancing once confirmed M5 structure owns trailing.",
);
assert.match(
  transformedSideway,
  /fastMoveHandedOffToM5[\s\S]*?saveState\(\)[\s\S]*?if \(fastMoveStructure === null\)/,
  "Sideway M5 handoff must be durably persisted so Fast-Move cannot resume after handoff.",
);
assert.match(
  transformedSideway,
  /lastStructuralStop:\s*tightestKnownStop\([\s\S]*?managed\.lastStructuralStop[\s\S]*?managed\.fastMoveStop[\s\S]*?\)/,
  "Sideway M5 structural evaluation must include the Fast-Move floor in its same-cycle monotonic baseline.",
);

const legacySidewaySource = sidewaySource.replace(
  'console.log("PHASE7C_SIDEWAY_MANAGEMENT=BROKER_TP_SL_PLUS_MONOTONIC_STOP_TIGHTENING");',
  'console.log("PHASE7C_SIDEWAY_MANAGEMENT=PLUS6_BREAK_EVEN_PLUS10_ONE_THIRD_NO_TRAILING");',
);
assert.notEqual(legacySidewaySource, sidewaySource, "Fast-Move Sideway declaration must exist in the source fixture.");
const transformedLegacySideway = transformPhase7CSidewayM5TrailingSource(legacySidewaySource);
assert.match(
  transformedLegacySideway,
  /PHASE7C_SIDEWAY_MANAGEMENT=PLUS6_BREAK_EVEN_PLUS10_ONE_THIRD_M5_CONFIRMED_STRUCTURE_TRAILING/,
  "M5 adapter must remain backward-compatible with the pre-Fast-Move Sideway declaration.",
);

const recoveryIndex = transformedSideway.indexOf('if (managed.dailyMode === "RECOVERY_TP")');
const fastMoveHandoffIndex = transformedSideway.indexOf("const fastMoveStructure = managed.partialApplied");
const fastMoveIndex = transformedSideway.indexOf("fastMoveProfitLockCandidate({", fastMoveHandoffIndex);
const trailingIndex = transformedSideway.indexOf("SIDEWAY_M5_STRUCTURAL_SL_TIGHTEN");
assert.ok(recoveryIndex >= 0 && fastMoveHandoffIndex > recoveryIndex, "Sideway Recovery must return before M5/Fast-Move management.");
assert.ok(fastMoveHandoffIndex >= 0 && fastMoveIndex > fastMoveHandoffIndex, "Sideway M5 ownership check must run before Fast-Move advancement.");
assert.ok(trailingIndex > fastMoveIndex, "Sideway confirmed M5 structural trailing must remain available after Fast-Move handoff.");

const trendAccountModeSource = fs.readFileSync(new URL("./run-phase7c-trend-account-mode.mjs", import.meta.url), "utf8");
const trendCanonicalIndex = trendAccountModeSource.indexOf("transformPhase7CTrendCanonicalDailyRecoverySource(accountAdapted)");
assert.ok(
  trendCanonicalIndex >= 0,
  "Trend account-mode runtime must keep canonical Daily Recovery adaptation.",
);
assert.doesNotMatch(
  trendAccountModeSource,
  /transformPhase7CTrendM5TrailingSource|transformPhase7CTrendM5PreStructureProfitLockSource/,
  "Trend account-mode runtime must leave M5 structural/FastMove transforms to the canonical Trend runner.",
);
const trendCanonicalRunnerSource = fs.readFileSync(new URL("./run-phase7c-trend-controller.mjs", import.meta.url), "utf8");
const trendRunnerM5Index = trendCanonicalRunnerSource.indexOf("source = transformPhase7CTrendM5TrailingSource(source)");
const trendRunnerFastMoveIndex = trendCanonicalRunnerSource.indexOf("source = transformPhase7CTrendM5PreStructureProfitLockSource(source)");
assert.ok(
  trendRunnerM5Index >= 0 && trendRunnerFastMoveIndex > trendRunnerM5Index,
  "Canonical Trend runner must apply M5 structural before M5 pre-structure/FastMove transforms.",
);

const sidewayAccountModeSource = fs.readFileSync(new URL("./run-phase7c-sideway-account-mode.mjs", import.meta.url), "utf8");
const sidewayCanonicalIndex = sidewayAccountModeSource.indexOf("transformPhase7CSidewayCanonicalDailyRecoverySource(accountAdapted)");
const sidewayM5Index = sidewayAccountModeSource.indexOf("transformPhase7CSidewayM5TrailingSource(canonicalOutput)");
assert.ok(
  sidewayCanonicalIndex >= 0 && sidewayM5Index > sidewayCanonicalIndex,
  "Sideway account-mode runtime must apply canonical Daily Recovery before M5 trailing.",
);

console.log("PHASE7C_M5_STRUCTURAL_TRAILING_CONTRACT=PASS");
