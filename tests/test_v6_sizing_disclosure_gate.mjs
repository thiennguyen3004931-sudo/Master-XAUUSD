import test from "node:test";
import assert from "node:assert/strict";
import { getV6ExecutionSizingDisclosure } from "../scripts/v6-execution-sizing-disclosure.mjs";

test("requesting auto risk lot does not imply it is executable on V6", () => {
  const result = getV6ExecutionSizingDisclosure({
    requestedSizingMode: "AUTO_RISK_PERCENT",
    fixedLot: 0.1,
    configVerified: true,
  });
  assert.equal(result.requestedSizingMode, "AUTO_RISK_PERCENT");
  assert.equal(result.orderSizingMode, "FIXED_LOT");
  assert.equal(result.gatewayExecutionMode, "FIXED_LOT");
  assert.equal(result.automaticCapitalSizingActiveOnV6, false);
  assert.equal(result.uiAutoLotClaimAllowed, false);
  assert.equal(result.autoLotPolicyApprovedForLive, false);
  assert.equal(result.configuredLot, 0.1);
});

test("missing or invalid local lot never becomes a verified broker lot", () => {
  for (const fixedLot of [undefined, null, 0, -0.1, NaN, Infinity, "0.1"]) {
    const result = getV6ExecutionSizingDisclosure({fixedLot,configVerified:true});
    assert.equal(result.configuredLot, null);
    assert.equal(result.brokerVolumeValidatedForNextOrder, false);
  }
  const unverified = getV6ExecutionSizingDisclosure({fixedLot:0.2,configVerified:false});
  assert.equal(unverified.configuredLot,null);
});

test("unrecognized sizing requests fail back to currently disclosed fixed lot", () => {
  const result = getV6ExecutionSizingDisclosure({requestedSizingMode:"UNSUPPORTED"});
  assert.equal(result.requestedSizingMode,"FIXED_LOT");
  assert.equal(result.gatewayExecutionMode,"FIXED_LOT");
  assert.equal(result.phase7cAutoLotComparisonIsShadowOnly,true);
});
