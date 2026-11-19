import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  transformPhase7CSidewayM5PreStructureProfitLockSource,
  transformPhase7CTrendM5PreStructureProfitLockSource,
} from "./phase7c-m5-prestructure-profit-lock-source-adapter.mjs";
import {
  transformPhase7CSidewayM5TrailingSource,
  transformPhase7CTrendM5TrailingSource,
} from "./phase7c-m5-structural-trailing-source-adapter.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const trendRawSource = fs.readFileSync(path.join(here, "run-phase7b-demo-controller.ts"), "utf8");
const sidewayRawSource = fs.readFileSync(path.join(here, "run-phase7c-sideway-controller.mjs"), "utf8");
const preStructureAdapterSource = fs.readFileSync(
  path.join(here, "phase7c-m5-prestructure-profit-lock-source-adapter.mjs"),
  "utf8",
);

for (const [strategy, source] of [
  ["TREND", trendRawSource],
  ["SIDEWAY", sidewayRawSource],
]) {
  assert.match(
    source,
    /const FAST_MOVE_PROFIT_LOCK_ACTIVATION_PRICE\s*=\s*10;/,
    `${strategy} canonical raw source must activate FastMove at +10 price units.`,
  );
  assert.match(
    source,
    /const FAST_MOVE_PROFIT_LOCK_GIVEBACK_PRICE\s*=\s*10;/,
    `${strategy} canonical raw source must keep the stop 10 price units behind the favorable peak.`,
  );
}

assert.doesNotMatch(
  trendRawSource,
  /FAST_MOVE_PROFIT_LOCK_GIVEBACK_PRICE\s*=\s*6;/,
  "Trend canonical source must not retain the old 6-price FastMove giveback.",
);
assert.doesNotMatch(
  sidewayRawSource,
  /FAST_MOVE_PROFIT_LOCK_GIVEBACK_PRICE\s*=\s*4;/,
  "Sideway canonical source must not retain the old 4-price FastMove giveback.",
);

assert.doesNotMatch(
  preStructureAdapterSource,
  /"const FAST_MOVE_PROFIT_LOCK_GIVEBACK_PRICE = (?:4|6);"/,
  "The pre-structure adapter must not hide a non-canonical raw giveback by rewriting 4/6 to 10.",
);

const trendRuntimeSource = transformPhase7CTrendM5PreStructureProfitLockSource(
  transformPhase7CTrendM5TrailingSource(trendRawSource),
);
const sidewayRuntimeSource = transformPhase7CSidewayM5PreStructureProfitLockSource(
  transformPhase7CSidewayM5TrailingSource(sidewayRawSource),
);

const trendCrlfRuntimeSource = transformPhase7CTrendM5PreStructureProfitLockSource(
  transformPhase7CTrendM5TrailingSource(trendRawSource.replace(/\r?\n/g, "\r\n")),
);
const sidewayCrlfRuntimeSource = transformPhase7CSidewayM5PreStructureProfitLockSource(
  transformPhase7CSidewayM5TrailingSource(sidewayRawSource.replace(/\r?\n/g, "\r\n")),
);
for (const [strategy, source] of [
  ["TREND_CRLF", trendCrlfRuntimeSource],
  ["SIDEWAY_CRLF", sidewayCrlfRuntimeSource],
]) {
  assert.match(source, /FAST_MOVE_HANDOFF_M5_STRUCTURE/, `${strategy} transform must be CRLF-safe.`);
  assert.match(source, /fastMoveHandedOffToM5/, `${strategy} durable handoff state must survive CRLF input.`);
}

for (const [strategy, source] of [
  ["TREND", trendRuntimeSource],
  ["SIDEWAY", sidewayRuntimeSource],
]) {
  assert.match(source, /FAST_MOVE_PROFIT_LOCK_GIVEBACK_PRICE\s*=\s*10;/);
  assert.match(source, /FAST_MOVE_HANDOFF_M5_STRUCTURE/);
  assert.match(source, /fastMoveHandedOffToM5/);
  assert.match(
    source,
    /if \(fastMove\.active && fastMoveEligible\)/,
    `${strategy} FastMove may mutate SL only after BE-or-better protection is already present.`,
  );
}

assert.match(
  trendRuntimeSource,
  /evaluateM5StructuralTrail\([\s\S]*?currentStop:\s*Number\(position\.stopLoss\)/,
  "Trend M5 handoff must compare a structural candidate against the current broker stop.",
);
assert.match(
  sidewayRuntimeSource,
  /evaluateM5StructuralTrail\([\s\S]*?currentStop:\s*Number\(position\.stopLoss\)/,
  "Sideway M5 handoff must compare a structural candidate against the current broker stop.",
);

console.log("FASTMOVE_CANONICAL_RAW_10_10=PASS");
console.log("FASTMOVE_ADAPTER_NO_CONSTANT_MASKING=PASS");
console.log("FASTMOVE_M5_HANDOFF_DURABLE=PASS");
console.log("FASTMOVE_M5_HANDOFF_NEVER_LOOSENS=PASS");
console.log("P3=ACTIVATION_10_GIVEBACK_10");
