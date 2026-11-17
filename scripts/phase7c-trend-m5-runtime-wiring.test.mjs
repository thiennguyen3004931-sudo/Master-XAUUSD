import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { evaluateM5StructuralTrail } from "./phase7c-m5-structural-trailing.mjs";
import { transformPhase7CTrendM5TrailingSource } from "./phase7c-m5-structural-trailing-source-adapter.mjs";
import { transformPhase7CTrendM5PreStructureProfitLockSource } from "./phase7c-m5-prestructure-profit-lock-source-adapter.mjs";
import { transformPhase7CSemiTrendRuntimeSource } from "./phase7c-semi-trend-runtime-source-adapter.mjs";

const legacyTrendSource = fs.readFileSync(
  new URL("./run-phase7b-demo-controller.ts", import.meta.url),
  "utf8",
);
const canonicalRunnerSource = fs.readFileSync(
  new URL("./run-phase7c-trend-controller.mjs", import.meta.url),
  "utf8",
);

function transformTrendM5(source = legacyTrendSource) {
  return transformPhase7CTrendM5PreStructureProfitLockSource(
    transformPhase7CTrendM5TrailingSource(source),
  );
}

const buyBars = [
  { closeTime: 1_000, low: 106, high: 112 },
  { closeTime: 2_000, low: 105, high: 111 },
  { closeTime: 3_000, low: 107, high: 113 },
  { closeTime: 4_000, low: 108, high: 114 },
  { closeTime: 5_000, low: 109, high: 115 },
];

const sellBars = [
  { closeTime: 1_000, low: 98, high: 104 },
  { closeTime: 2_000, low: 97, high: 105 },
  { closeTime: 3_000, low: 96, high: 103 },
];

test("canonical Trend runner applies M5 structural and FastMove handoff adapters", () => {
  assert.match(
    canonicalRunnerSource,
    /import \{ transformPhase7CTrendM5TrailingSource \} from "\.\/phase7c-m5-structural-trailing-source-adapter\.mjs";/,
  );
  assert.match(
    canonicalRunnerSource,
    /import \{ transformPhase7CTrendM5PreStructureProfitLockSource \} from "\.\/phase7c-m5-prestructure-profit-lock-source-adapter\.mjs";/,
  );
  assert.match(
    canonicalRunnerSource,
    /source = transformPhase7CTrendM5TrailingSource\(source\);[\s\S]*?source = transformPhase7CTrendM5PreStructureProfitLockSource\(source\);/,
    "M5 structural wiring must be applied before the FastMove handoff adapter.",
  );
});

test("Trend managed and recovered positions receive m15 and m5", () => {
  const source = transformTrendM5();
  assert.match(source, /await managePosition\(managedPosition, quote, spec, m15, m5\);/);
  assert.match(
    source,
    /async function managePosition\(position: Position, quote: Quote, spec: SymbolSpec, m15: Phase7Bar\[\], m5: Phase7Bar\[\]\): Promise<void>/,
  );
});

test("SEMI adopted position inherits Trend M5 management", () => {
  const source = transformPhase7CSemiTrendRuntimeSource(transformTrendM5());
  assert.match(
    source,
    /await managePosition\(semiAdoption\.position, quote, spec, m15, m5\);/,
    "SEMI manual adoption must pass the same M5 snapshot used by Trend management.",
  );
});

test("null/equal/worse M5 candidates cannot take ownership", () => {
  const noStructure = evaluateM5StructuralTrail({
    side: "BUY",
    bars: buyBars,
    afterTimestamp: 10_000,
    atOrBefore: 10_000,
    currentStop: 104,
    lastStructuralStop: 104,
    bid: 112,
    ask: 112.2,
    digits: 2,
    point: 0.01,
    stopsLevelTicks: 10,
    freezeLevelTicks: 5,
  });
  assert.equal(noStructure.allowed, false);

  const equal = evaluateM5StructuralTrail({
    side: "BUY",
    bars: buyBars,
    afterTimestamp: 0,
    atOrBefore: 5_000,
    currentStop: 104,
    lastStructuralStop: 104,
    bid: 112,
    ask: 112.2,
    digits: 2,
    point: 0.01,
    stopsLevelTicks: 10,
    freezeLevelTicks: 5,
  });
  assert.equal(equal.stopLoss, 104);
  assert.equal(equal.allowed, false);
  assert.equal(equal.reason, "NOT_STRICTLY_TIGHTER");

  const worse = evaluateM5StructuralTrail({
    side: "BUY",
    bars: buyBars,
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
  assert.equal(worse.allowed, false);
  assert.equal(worse.reason, "NOT_STRICTLY_TIGHTER");
});

test("broker MODIFY failure cannot persist M5 ownership", () => {
  const source = transformTrendM5();
  assert.doesNotMatch(
    source,
    /if \(m5Trail\.allowed\) \{[\s\S]*?managed\.fastMoveHandedOffToM5 = true;[\s\S]*?const response = await patch/,
    "Handoff must not be persisted before the broker response exists.",
  );
  assert.match(
    source,
    /if \(response\.success\) \{[\s\S]*?managed\.fastMoveHandedOffToM5 = true;[\s\S]*?\} else \{[\s\S]*?M5_STRUCTURAL_SL_REJECTED/,
    "Only the successful MODIFY branch may persist M5 ownership; rejection must leave FastMove ownership unchanged.",
  );
});

test("successful tighter M5 MODIFY starts a new FastMove cycle", () => {
  const source = transformTrendM5();
  assert.match(
    source,
    /if \(response\.success\) \{[\s\S]*?managed\.fastMoveHandedOffToM5 = true;[\s\S]*?managed\.lastStructuralStop = m5Trail\.stopLoss;[\s\S]*?managed\.fastMoveCycleAnchorPrice = exitPrice;[\s\S]*?saveState\(\);/,
    "Accepted M5 tighten must persist the handoff anchor used by the next FastMove cycle.",
  );
  assert.match(
    source,
    /const fastMoveReactivationDistance =[\s\S]*?FAST_MOVE_PROFIT_LOCK_ACTIVATION_PRICE[\s\S]*?managed\.fastMoveHandedOffToM5 = false;[\s\S]*?managed\.fastMoveCycleStartedAt = Number\(quote\.timestamp\);[\s\S]*?FAST_MOVE_REACTIVATED_AFTER_M5/,
    "FastMove must reactivate after a new +10 favorable impulse from the accepted M5 handoff anchor.",
  );
  assert.match(
    source,
    /const fastMoveReferencePrice = Number\(managed\.fastMoveCycleAnchorPrice\) > 0[\s\S]*?entry: fastMoveReferencePrice/,
    "Reactivated FastMove must measure activation/giveback from the latest M5 handoff anchor.",
  );
});

test("M5 structural stop is monotonic for BUY and SELL", () => {
  const buy = evaluateM5StructuralTrail({
    side: "BUY",
    bars: buyBars,
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
  assert.equal(buy.allowed, false);

  const sell = evaluateM5StructuralTrail({
    side: "SELL",
    bars: sellBars,
    afterTimestamp: 0,
    atOrBefore: 3_000,
    currentStop: 105.5,
    lastStructuralStop: 105.5,
    bid: 98.8,
    ask: 99,
    digits: 2,
    point: 0.01,
    stopsLevelTicks: 10,
    freezeLevelTicks: 5,
  });
  assert.equal(sell.stopLoss, 106);
  assert.equal(sell.allowed, false);
  assert.equal(sell.reason, "NOT_STRICTLY_TIGHTER");
});
