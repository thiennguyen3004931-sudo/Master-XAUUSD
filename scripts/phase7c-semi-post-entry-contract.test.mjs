import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { transformPhase7CSemiTrendRuntimeSource } from "./phase7c-semi-trend-runtime-source-adapter.mjs";
import { assertPhase7CSemiPostEntryContract } from "./phase7c-semi-post-entry-contract.mjs";

function read(relativePath) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("SEMI post-entry source chain preserves the canonical Trend management contract", () => {
  const legacyTrendSource = read("./run-phase7b-demo-controller.ts");
  const transformedTrendSource = transformPhase7CSemiTrendRuntimeSource(legacyTrendSource);
  const semiAdoptionRuntimeSource = read("./phase7c-semi-trend-adoption-runtime.mjs");
  const trendWrapperSource = read("./run-phase7c-trend-controller.mjs");

  const result = assertPhase7CSemiPostEntryContract({
    legacyTrendSource,
    transformedTrendSource,
    semiAdoptionRuntimeSource,
    trendWrapperSource,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.contract, {
    entryPolicy: "MANUAL_ONLY",
    initialStopDistance: 6,
    fixedTakeProfitPolicy: "TREND_RUNTIME_CONFIG",
    plus6Action: "SL_TO_ENTRY_ONLY",
    plus6PartialClose: "NONE",
    plus10Action: "PARTIAL_ONE_THIRD",
    managementStrategy: "TREND",
    fixedTakeProfitInherited: true,
    fastMoveInherited: true,
    structuralTrailingInherited: true,
    reversalExitInherited: true,
    runnerTrendExitInherited: true,
    holdReasonInherited: true,
  });
});
