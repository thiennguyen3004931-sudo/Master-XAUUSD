import assert from "node:assert/strict";
import { test } from "node:test";

import { Timeframe } from "@xauusd/market-data";

import {
  createTrendManagementRuntimeEvaluator,
} from "./trend-management-runtime.service";
import type { DurableSemiAdoptionState } from "./phase7c-semi-adoption-state.service";
import { resolveTrendManagementOwner } from "./trend-management-owner.service";

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

test("ownership resolver accepts only durable protected SEMI ownership", () => {
  const selected = resolveTrendManagementOwner({
    symbol: "XAUUSD",
    openExecutionRecords: [],
    semiAdoptions: [adoption()],
  });
  assert.equal(selected.status, "SELECTED");
  assert.equal(selected.owner?.kind, "MANUAL_SEMI");
  assert.equal(selected.owner?.ownerId, adoption().ownershipId);
  assert.equal(selected.owner?.ticket, "99001");

  for (const protectionStatus of ["PENDING", "PROTECTION_BLOCKED"] as const) {
    const blocked = resolveTrendManagementOwner({
      symbol: "XAUUSD",
      openExecutionRecords: [],
      semiAdoptions: [adoption({ protectionStatus })],
    });
    assert.equal(blocked.status, "NONE");
  }
});

test("multiple protected SEMI owners fail closed", () => {
  const resolution = resolveTrendManagementOwner({
    symbol: "XAUUSD",
    openExecutionRecords: [],
    semiAdoptions: [
      adoption(),
      adoption({
        ownershipId: "semi:99002:1789000000000",
        ticket: "99002",
        openingDealTicket: "88002",
      }),
    ],
  });

  assert.equal(resolution.status, "BLOCKED");
  assert.match(resolution.reason, /exactly one/i);
});

test("runtime reaches broker validation for a protected SEMI owner even without a system execution record", async () => {
  const evaluator = createTrendManagementRuntimeEvaluator({
    now: () => 1_789_000_010_000,
    getControlState: (() => ({
      mode: "DEMO",
      tradingEnabled: true,
      liveUnlockAvailable: false,
    })) as any,
    getExecutionRepository: (() => ({
      listOpen: async () => [],
    })) as any,
    getSemiAdoptionStateRepository: (() => ({
      listActive: async () => [adoption()],
      save: async () => undefined,
    })) as any,
    getMt5RealMarketData: (async () => {
      throw new Error("SEMI_OWNER_REACHED_BROKER_VALIDATION");
    }) as any,
    getMt5AllPositions: (async () => []) as any,
  } as any);

  await assert.rejects(
    evaluator({
      enabled: true,
      executionEnabled: false,
      symbol: "XAUUSD",
      timeframe: Timeframe.M15,
      candleCount: 320,
    }),
    /SEMI_OWNER_REACHED_BROKER_VALIDATION/,
  );
});

test("runtime still ignores arbitrary unmanaged broker positions with no durable owner", async () => {
  let marketRead = false;
  const evaluator = createTrendManagementRuntimeEvaluator({
    now: () => 1_789_000_010_000,
    getControlState: (() => ({
      mode: "DEMO",
      tradingEnabled: true,
      liveUnlockAvailable: false,
    })) as any,
    getExecutionRepository: (() => ({
      listOpen: async () => [],
    })) as any,
    getSemiAdoptionStateRepository: (() => ({
      listActive: async () => [],
      save: async () => undefined,
    })) as any,
    getMt5RealMarketData: (async () => {
      marketRead = true;
      throw new Error("should not read market without durable owner");
    }) as any,
    getMt5AllPositions: (async () => [{ ticket: "UNMANAGED" }]) as any,
  } as any);

  const result = await evaluator({
    enabled: true,
    executionEnabled: false,
    symbol: "XAUUSD",
    timeframe: Timeframe.M15,
    candleCount: 320,
  });

  assert.equal(result.action, "NO_POSITION");
  assert.equal(marketRead, false);
});
