import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evaluateSemiManualAdoption,
  type SemiManualAdoptionInput,
} from "./phase7c-semi-manual-adoption.service";

const activationEpochMs = 1_789_000_000_000;

function baseInput(overrides: Partial<SemiManualAdoptionInput> = {}): SemiManualAdoptionInput {
  return {
    mode: "SEMI",
    activationEpochMs,
    symbol: "XAUUSD",
    systemMagicNumber: 7654321,
    position: {
      ticket: "99001",
      symbol: "XAUUSD",
      side: "LONG",
      entry: 3600,
      stopLoss: 0,
      takeProfit: 0,
      openedAt: activationEpochMs + 2_000,
    },
    openingDeal: {
      ticket: "88001",
      positionId: "99001",
      symbol: "XAUUSD",
      side: "BUY",
      entry: "IN",
      magic: 0,
      comment: "",
      timestamp: activationEpochMs + 2_000,
    },
    quote: { bid: 3601, ask: 3601.2 },
    spec: {
      tickSize: 0.01,
      stopsLevelTicks: 0,
      freezeLevelTicks: 0,
    },
    fixedTakeProfit: { enabled: false, price: null },
    ...overrides,
  };
}

test("rejects adoption outside SEMI mode", () => {
  const result = evaluateSemiManualAdoption(baseInput({ mode: "AUTO" }));
  assert.deepEqual(result, {
    status: "REJECTED",
    reason: "MODE_NOT_SEMI",
    targetStopLoss: null,
    targetTakeProfit: null,
  });
});

test("never retro-adopts a position that existed at SEMI activation", () => {
  const result = evaluateSemiManualAdoption(baseInput({
    position: { ...baseInput().position, openedAt: activationEpochMs },
  }));
  assert.equal(result.status, "REJECTED");
  assert.equal(result.reason, "POSITION_NOT_AFTER_ACTIVATION");
});

test("requires an opening deal correlated to the broker position", () => {
  assert.equal(
    evaluateSemiManualAdoption(baseInput({ openingDeal: null })).reason,
    "OPENING_DEAL_REQUIRED",
  );
  assert.equal(
    evaluateSemiManualAdoption(baseInput({
      openingDeal: { ...baseInput().openingDeal!, positionId: "OTHER" },
    })).reason,
    "OPENING_DEAL_POSITION_MISMATCH",
  );
});

test("rejects system-owned and unknown EA provenance", () => {
  const systemOwned = evaluateSemiManualAdoption(baseInput({
    openingDeal: {
      ...baseInput().openingDeal!,
      magic: 7654321,
      comment: "xau:entry-1",
    },
  }));
  assert.equal(systemOwned.reason, "SYSTEM_OWNED_POSITION");

  const foreignEa = evaluateSemiManualAdoption(baseInput({
    openingDeal: {
      ...baseInput().openingDeal!,
      magic: 42,
      comment: "foreign-ea",
    },
  }));
  assert.equal(foreignEa.reason, "MANUAL_PROVENANCE_NOT_PROVEN");
});

test("manual LONG receives exact 6.0-price-unit initial SL normalized to broker tick", () => {
  const result = evaluateSemiManualAdoption(baseInput({
    position: { ...baseInput().position, entry: 3600.003 },
  }));
  assert.equal(result.status, "PENDING");
  assert.equal(result.reason, "PROTECTION_REQUIRED");
  assert.equal(result.targetStopLoss, 3594);
  assert.equal(result.targetTakeProfit, null);
});

test("manual SHORT receives exact directional 6.0-price-unit initial SL", () => {
  const result = evaluateSemiManualAdoption(baseInput({
    position: { ...baseInput().position, side: "SHORT", entry: 3600 },
    openingDeal: { ...baseInput().openingDeal!, side: "SELL" },
    quote: { bid: 3598.8, ask: 3599 },
  }));
  assert.equal(result.status, "PENDING");
  assert.equal(result.targetStopLoss, 3606);
});

test("preserves an existing tighter LONG stop instead of loosening it to 6 price units", () => {
  const result = evaluateSemiManualAdoption(baseInput({
    position: { ...baseInput().position, stopLoss: 3596.27 },
  }));
  assert.equal(result.status, "PENDING");
  assert.equal(result.reason, "PROTECTION_REQUIRED");
  assert.equal(result.targetStopLoss, 3596.27);
});

test("preserves an existing tighter SHORT stop instead of loosening it to 6 price units", () => {
  const result = evaluateSemiManualAdoption(baseInput({
    position: {
      ...baseInput().position,
      side: "SHORT",
      entry: 3600,
      stopLoss: 3603.25,
    },
    openingDeal: { ...baseInput().openingDeal!, side: "SELL" },
    quote: { bid: 3598.8, ask: 3599 },
  }));
  assert.equal(result.status, "PENDING");
  assert.equal(result.targetStopLoss, 3603.25);
});

test("does not block an already tighter stop merely because the canonical 6-price stop is inside freeze distance", () => {
  const result = evaluateSemiManualAdoption(baseInput({
    position: { ...baseInput().position, stopLoss: 3594.03 },
    quote: { bid: 3594.04, ask: 3594.06 },
    spec: {
      tickSize: 0.01,
      stopsLevelTicks: 10,
      freezeLevelTicks: 20,
    },
  }));
  assert.equal(result.status, "PENDING");
  assert.equal(result.targetStopLoss, 3594.03);
});

test("broker stops/freeze constraints block protection fail-closed", () => {
  const result = evaluateSemiManualAdoption(baseInput({
    quote: { bid: 3594.04, ask: 3594.06 },
    spec: {
      tickSize: 0.01,
      stopsLevelTicks: 10,
      freezeLevelTicks: 20,
    },
  }));
  assert.equal(result.status, "PROTECTION_BLOCKED");
  assert.equal(result.reason, "INITIAL_SL_INSIDE_BROKER_PROTECTION_DISTANCE");
  assert.equal(result.targetStopLoss, 3594);
});

test("Trend Fixed TP is canonical when enabled even if manual TP differs", () => {
  const result = evaluateSemiManualAdoption(baseInput({
    position: { ...baseInput().position, takeProfit: 3610 },
    fixedTakeProfit: { enabled: true, price: 3625.007 },
  }));
  assert.equal(result.status, "PENDING");
  assert.equal(result.targetStopLoss, 3594);
  assert.equal(result.targetTakeProfit, 3625.01);
  assert.equal(result.reason, "PROTECTION_REQUIRED");
});
