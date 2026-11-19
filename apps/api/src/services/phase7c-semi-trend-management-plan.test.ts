import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createPhase7CSemiTrendManagementPlan,
} from "./phase7c-semi-trend-management-plan.service";
import type { DurableSemiAdoptionState } from "./phase7c-semi-adoption-state.service";

function adoption(overrides: Partial<DurableSemiAdoptionState> = {}): DurableSemiAdoptionState {
  return {
    version: 1,
    ownershipId: "semi:99001:1789000000000",
    ticket: "99001",
    openingDealTicket: "88001",
    symbol: "XAUUSD",
    accountLogin: "12345678",
    entrySource: "MANUAL",
    managementStrategy: "TREND",
    side: "LONG",
    entry: 3600,
    initialVolume: 0.12,
    expectedRemainingVolume: 0.12,
    activationEpochMs: 1_789_000_000_000,
    manualOpenedAt: 1_789_000_002_000,
    managementStartedAt: 1_789_000_002_500,
    initialStopDistance: 6,
    targetStopLoss: 3594,
    tightestStopLoss: 3595,
    protectionStatus: "PROTECTED",
    protectionReason: "BROKER_CONFIRMED",
    fixedTakeProfit: { enabled: false, targetPrice: null },
    updatedAt: 1_789_000_004_000,
    ...overrides,
  };
}

test("PROTECTED manual LONG gets a truthful management-only Trend plan", () => {
  const plan = createPhase7CSemiTrendManagementPlan(adoption());

  assert.deepEqual(plan.order, { symbol: "XAUUSD", stopLoss: 3595 });
  assert.equal("selectedStrategy" in plan, false);
  assert.equal("regime" in plan, false);
  assert.equal("session" in plan, false);

  assert.equal(plan.management.partialTargets.length, 1);
  assert.equal(plan.management.partialTargets[0]?.price, 3610);
  assert.equal(plan.management.partialTargets[0]?.closePercent, 100 / 3);
  assert.equal(plan.management.partialTargets[0]?.rewardMultiple, 10 / 6);

  assert.equal(plan.management.trailingStop.mode, "TREND_STRUCTURE");
  assert.equal(plan.management.trailingStop.activateAtProfitPrice, 6);
  assert.equal(plan.management.trailingStop.structureTrailAtProfitPrice, 10);
  assert.equal(plan.management.trailingStop.atrMultiple, 1.5);
  assert.equal(plan.management.trailingStop.positiveLockPrice, 0.5);
  assert.equal(plan.management.trailingStop.swingBufferAtrMultiple, 0.25);
  assert.equal(plan.management.trailingStop.minimumDistanceAtrMultiple, 0.5);

  assert.equal(plan.management.maximumHoldingMinutes, 480);
  assert.equal(
    plan.management.timeStopAt,
    adoption().managementStartedAt + 480 * 60_000,
  );
  assert.equal(plan.management.hardInvalidationPrice, 3595);
  assert.equal(plan.management.trendHoldUntilStructureBreak, true);
});

test("+6 is BE-only; partial close waits for +10 and closes one third", () => {
  const state = adoption();
  const plan = createPhase7CSemiTrendManagementPlan(state);
  const plusSixPrice = state.entry + state.initialStopDistance;

  assert.equal(state.initialStopDistance, 6);
  assert.equal(plan.management.moveStopToBreakEvenAtR, 1);
  assert.equal(plan.management.trailingStop.activateAtProfitPrice, 6);
  assert.notEqual(plan.management.partialTargets[0]?.price, plusSixPrice);
  assert.equal(plan.management.partialTargets[0]?.price, state.entry + 10);
  assert.equal(plan.management.partialTargets[0]?.closePercent, 100 / 3);
});

test("manual SHORT +10 milestone is directional", () => {
  const plan = createPhase7CSemiTrendManagementPlan(adoption({
    side: "SHORT",
    entry: 3600,
    targetStopLoss: 3606,
    tightestStopLoss: 3604,
  }));

  assert.equal(plan.management.partialTargets[0]?.price, 3590);
  assert.equal(plan.order.stopLoss, 3604);
});

test("PENDING or PROTECTION_BLOCKED adoption cannot enter normal Trend management", () => {
  assert.throws(
    () => createPhase7CSemiTrendManagementPlan(adoption({ protectionStatus: "PENDING" })),
    /PROTECTED|MANAGED/,
  );
  assert.throws(
    () => createPhase7CSemiTrendManagementPlan(adoption({ protectionStatus: "PROTECTION_BLOCKED" })),
    /PROTECTED|MANAGED/,
  );
});
