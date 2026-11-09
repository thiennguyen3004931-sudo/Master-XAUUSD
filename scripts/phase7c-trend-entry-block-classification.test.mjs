import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { classifyPhase7CTrendEntryBlock } from "./phase7c-trend-entry-block.mjs";

const canonicalPayload = {
  error: "PHASE7C_TREND_ENTRY_BLOCKED",
  accepted: false,
  status: "blocked_by_phase7c_mode_gate",
  message: "AUTO_REGIME_RECOMMENDS_PAUSE",
  activeMode: "AUTO",
  recommendedMode: "PAUSE",
  detail: "Regime=UNCERTAIN; no canonical REVERSAL exception applies.",
};

const expectedClassification = {
  status: "blocked_by_phase7c_mode_gate",
  bridgeError: "PHASE7C_TREND_ENTRY_BLOCKED",
  reasonCode: "AUTO_REGIME_RECOMMENDS_PAUSE",
  reason: "Regime=UNCERTAIN; no canonical REVERSAL exception applies.",
  activeMode: "AUTO",
  recommendedMode: "PAUSE",
};

test("classifies the canonical Phase 7C Trend 423 mode-gate response as an expected entry block", () => {
  const result = classifyPhase7CTrendEntryBlock({
    bridgeStatus: 423,
    bridgeMethod: "POST",
    bridgeEndpoint: "/v1/orders",
    bridgePayload: canonicalPayload,
  });

  assert.deepEqual(result, expectedClassification);
});

test("classifies the exact legacy bridge error emitted by the LIVE Trend runtime", () => {
  const error = new Error(
    `MT5 bridge POST /v1/orders failed 423: ${JSON.stringify(canonicalPayload)}`,
  );

  assert.deepEqual(
    classifyPhase7CTrendEntryBlock(error),
    expectedClassification,
  );
});

test("does not downgrade unrelated bridge failures into expected entry blocks", () => {
  assert.equal(classifyPhase7CTrendEntryBlock({
    bridgeStatus: 500,
    bridgeMethod: "POST",
    bridgeEndpoint: "/v1/orders",
    bridgePayload: canonicalPayload,
  }), null);

  assert.equal(classifyPhase7CTrendEntryBlock({
    bridgeStatus: 423,
    bridgeMethod: "GET",
    bridgeEndpoint: "/v1/orders",
    bridgePayload: canonicalPayload,
  }), null);

  assert.equal(classifyPhase7CTrendEntryBlock({
    bridgeStatus: 423,
    bridgeMethod: "POST",
    bridgeEndpoint: "/v1/positions",
    bridgePayload: canonicalPayload,
  }), null);

  assert.equal(classifyPhase7CTrendEntryBlock({
    bridgeStatus: 423,
    bridgeMethod: "POST",
    bridgeEndpoint: "/v1/orders",
    bridgePayload: {
      ...canonicalPayload,
      error: "SOME_OTHER_BLOCK",
    },
  }), null);

  assert.equal(classifyPhase7CTrendEntryBlock(
    new Error("MT5 bridge POST /v1/orders failed 500: internal error"),
  ), null);
});

test("Phase 7C Trend runtime canonicalizes expected policy blocks to ENTRY_MODE_BLOCKED", () => {
  const source = fs.readFileSync(new URL("./run-phase7c-trend-controller.mjs", import.meta.url), "utf8");

  assert.match(source, /phase7c-trend-entry-block\.mjs/);
  assert.match(source, /classifyPhase7CTrendEntryBlock/);
  assert.match(source, /journal\("ENTRY_MODE_BLOCKED"/);
  assert.match(source, /PHASE7C_TREND_EXPECTED_MODE_BLOCK_CLASSIFICATION=ENABLED/);
  assert.match(source, /Any other bridge\/network error remains CYCLE_ERROR/);
});
