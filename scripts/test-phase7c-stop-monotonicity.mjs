import assert from "node:assert/strict";

import {
  STRUCTURAL_STOP_BUFFER_PRICE,
  stopIsAtLeastAsTight,
  stopStrictlyTightens,
  structuralStopWithBuffer,
  tightestKnownStop,
} from "./phase7c-stop-monotonicity.mjs";

assert.equal(STRUCTURAL_STOP_BUFFER_PRICE, 1);
assert.equal(structuralStopWithBuffer("BUY", 105), 104, "BUY structural stop must sit 1.0 below structure.");
assert.equal(structuralStopWithBuffer("SELL", 105), 106, "SELL structural stop must sit 1.0 above structure.");

assert.equal(stopStrictlyTightens("BUY", 100, 101), true);
assert.equal(stopStrictlyTightens("BUY", 100, 100), false);
assert.equal(stopStrictlyTightens("BUY", 100, 99), false, "BUY stop must never loosen downward.");
assert.equal(stopStrictlyTightens("SELL", 110, 109), true);
assert.equal(stopStrictlyTightens("SELL", 110, 110), false);
assert.equal(stopStrictlyTightens("SELL", 110, 111), false, "SELL stop must never loosen upward.");

assert.equal(stopIsAtLeastAsTight("BUY", 105, 104), true);
assert.equal(stopIsAtLeastAsTight("BUY", 103, 104), false);
assert.equal(stopIsAtLeastAsTight("SELL", 105, 106), true);
assert.equal(stopIsAtLeastAsTight("SELL", 107, 106), false);

assert.equal(tightestKnownStop("BUY", 100, 104, 102), 104);
assert.equal(tightestKnownStop("SELL", 110, 106, 108), 106);

console.log("PHASE7C_STOP_MONOTONICITY_CONTRACT=PASS");
