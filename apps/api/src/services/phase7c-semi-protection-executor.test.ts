import assert from "node:assert/strict";
import { test } from "node:test";
import type { Position } from "@xauusd/types";

import {
  createPhase7CSemiProtectionExecutor,
  type Phase7CSemiProtectionExecutorDependencies,
} from "./phase7c-semi-protection-executor.service";
import type { DurableSemiAdoptionState } from "./phase7c-semi-adoption-state.service";

const NOW = 1_789_000_100_000;

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
    tightestStopLoss: 3594,
    protectionStatus: "PENDING",
    protectionReason: "PROTECTION_REQUIRED",
    fixedTakeProfit: { enabled: false, targetPrice: null },
    updatedAt: 1_789_000_002_500,
    ...overrides,
  };
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    ticket: "99001",
    symbol: "XAUUSD",
    side: "LONG" as Position["side"],
    volume: 0.12,
    entry: 3600,
    stopLoss: 0,
    takeProfit: 0,
    profit: 0,
    swap: 0,
    commission: 0,
    openedAt: 1_789_000_002_000,
    ...overrides,
  };
}

function harness(input: {
  state?: DurableSemiAdoptionState | null;
  positions?: Position[][];
  modifyResult?: { success: boolean; message: string };
  modifyThrows?: Error;
}) {
  let currentState = input.state === undefined ? adoption() : input.state;
  const saves: DurableSemiAdoptionState[] = [];
  const modifyCalls: Array<{
    ticket: string;
    stopLoss: number;
    takeProfit: number | undefined;
    commandId: string;
  }> = [];
  let readIndex = 0;
  const positionReads = input.positions ?? [[position()], [position({ stopLoss: 3594 })]];

  const dependencies: Phase7CSemiProtectionExecutorDependencies = {
    now: () => NOW,
    adoptionRepository: {
      findByTicket: async () => currentState,
      save: async (next) => {
        saves.push(structuredClone(next));
        currentState = structuredClone(next);
      },
    },
    adapter: {
      getOpenPositions: async () => {
        const snapshot = positionReads[Math.min(readIndex, positionReads.length - 1)] ?? [];
        readIndex += 1;
        return structuredClone(snapshot);
      },
      modifyPosition: async (ticket, stopLoss, takeProfit, commandId) => {
        modifyCalls.push({ ticket, stopLoss, takeProfit, commandId });
        if (input.modifyThrows) throw input.modifyThrows;
        return {
          commandId,
          success: input.modifyResult?.success ?? true,
          message: input.modifyResult?.message ?? "ok",
          executedAt: NOW,
        };
      },
    },
  };

  return {
    execute: createPhase7CSemiProtectionExecutor(dependencies),
    saves,
    modifyCalls,
  };
}

test("already canonical broker protection promotes to PROTECTED without mutation", async () => {
  const h = harness({ positions: [[position({ stopLoss: 3594 })]] });
  const result = await h.execute("99001");

  assert.equal(result.status, "PROTECTED");
  assert.equal(result.brokerMutationAttempted, false);
  assert.equal(h.modifyCalls.length, 0);
  assert.equal(h.saves.at(-1)?.protectionStatus, "PROTECTED");
  assert.equal(h.saves.at(-1)?.protectionReason, "BROKER_CONFIRMED");
});

test("bounded SL mutation requires fresh broker confirmation before PROTECTED", async () => {
  const h = harness({
    positions: [[position()], [position({ stopLoss: 3594 })]],
  });
  const result = await h.execute("99001");

  assert.equal(result.status, "PROTECTED");
  assert.equal(result.brokerMutationAttempted, true);
  assert.deepEqual(h.modifyCalls, [{
    ticket: "99001",
    stopLoss: 3594,
    takeProfit: undefined,
    commandId: "semi-protect:semi:99001:1789000000000",
  }]);
  assert.equal(h.saves.at(-1)?.protectionStatus, "PROTECTED");
});

test("broker success without exact reread confirmation remains fail-closed", async () => {
  const h = harness({
    positions: [[position()], [position({ stopLoss: 3593 })]],
  });
  const result = await h.execute("99001");

  assert.equal(result.status, "PROTECTION_BLOCKED");
  assert.equal(result.brokerMutationAttempted, true);
  assert.equal(h.saves.at(-1)?.protectionStatus, "PROTECTION_BLOCKED");
  assert.equal(h.saves.at(-1)?.protectionReason, "BROKER_CONFIRMATION_MISMATCH");
});

test("Fixed TP is mutated and confirmed together with the canonical stop", async () => {
  const h = harness({
    state: adoption({
      fixedTakeProfit: { enabled: true, targetPrice: 3625.01 },
    }),
    positions: [
      [position({ takeProfit: 3610 })],
      [position({ stopLoss: 3594, takeProfit: 3625.01 })],
    ],
  });
  const result = await h.execute("99001");

  assert.equal(result.status, "PROTECTED");
  assert.equal(h.modifyCalls[0]?.takeProfit, 3625.01);
});

test("missing broker ticket blocks with zero mutation", async () => {
  const h = harness({ positions: [[]] });
  const result = await h.execute("99001");

  assert.equal(result.status, "PROTECTION_BLOCKED");
  assert.equal(result.brokerMutationAttempted, false);
  assert.equal(h.modifyCalls.length, 0);
  assert.equal(h.saves.at(-1)?.protectionReason, "BROKER_POSITION_MISSING");
});

test("thrown mutation outcome is reconciled by broker reread, never guessed", async () => {
  const h = harness({
    positions: [[position()], [position({ stopLoss: 3594 })]],
    modifyThrows: new Error("transport lost after send"),
  });
  const result = await h.execute("99001");

  assert.equal(result.status, "PROTECTED");
  assert.equal(result.brokerMutationAttempted, true);
  assert.equal(h.saves.at(-1)?.protectionReason, "BROKER_CONFIRMED");
});

test("PROTECTED adoption is idempotent and cannot replay mutation", async () => {
  const h = harness({ state: adoption({ protectionStatus: "PROTECTED", protectionReason: "BROKER_CONFIRMED" }) });
  const result = await h.execute("99001");

  assert.equal(result.status, "PROTECTED");
  assert.equal(result.brokerMutationAttempted, false);
  assert.equal(h.modifyCalls.length, 0);
});
