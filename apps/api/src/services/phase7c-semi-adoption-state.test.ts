import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SqliteExecutionRepository } from "./sqlite-execution.repository";
import {
  Phase7CSemiAdoptionStateRepository,
  type DurableSemiAdoptionState,
} from "./phase7c-semi-adoption-state.service";

function state(overrides: Partial<DurableSemiAdoptionState> = {}): DurableSemiAdoptionState {
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
    fixedTakeProfit: {
      enabled: false,
      targetPrice: null,
    },
    updatedAt: 1_789_000_002_500,
    ...overrides,
  };
}

test("SEMI adoption is durable and never fabricates an execution record", async () => {
  const directory = mkdtempSync(join(tmpdir(), "phase7c-semi-adoption-"));
  const databasePath = join(directory, "execution-state.sqlite");
  const executionRepository = new SqliteExecutionRepository(databasePath);
  const repository = new Phase7CSemiAdoptionStateRepository(databasePath);

  try {
    await repository.save(state());

    assert.deepEqual(await repository.findByTicket("99001"), state());
    assert.deepEqual(await repository.listActive(), [state()]);
    assert.deepEqual(await executionRepository.listAll(), []);
  } finally {
    repository.close();
    executionRepository.close();
  }
});

test("one broker ticket cannot be rebound to a different SEMI ownership epoch/account", async () => {
  const directory = mkdtempSync(join(tmpdir(), "phase7c-semi-owner-"));
  const databasePath = join(directory, "execution-state.sqlite");
  const repository = new Phase7CSemiAdoptionStateRepository(databasePath);

  try {
    await repository.save(state());

    await assert.rejects(
      repository.save(state({
        ownershipId: "semi:99001:1789000010000",
        activationEpochMs: 1_789_000_010_000,
        manualOpenedAt: 1_789_000_012_000,
        managementStartedAt: 1_789_000_012_500,
        updatedAt: 1_789_000_012_500,
      })),
      /ownership/i,
    );
    await assert.rejects(
      repository.save(state({ accountLogin: "OTHER" })),
      /account/i,
    );
  } finally {
    repository.close();
  }
});

test("protection transitions are fail-closed and restart-safe", async () => {
  const directory = mkdtempSync(join(tmpdir(), "phase7c-semi-transition-"));
  const databasePath = join(directory, "execution-state.sqlite");
  const repository = new Phase7CSemiAdoptionStateRepository(databasePath);

  await repository.save(state());
  await repository.save(state({
    protectionStatus: "PROTECTION_BLOCKED",
    protectionReason: "BROKER_REJECTED",
    updatedAt: 1_789_000_003_000,
  }));
  await repository.save(state({
    protectionStatus: "PROTECTED",
    protectionReason: "BROKER_CONFIRMED",
    tightestStopLoss: 3595,
    updatedAt: 1_789_000_004_000,
  }));
  repository.close();

  const restarted = new Phase7CSemiAdoptionStateRepository(databasePath);
  try {
    const persisted = await restarted.findByTicket("99001");
    assert.equal(persisted?.protectionStatus, "PROTECTED");
    assert.equal(persisted?.tightestStopLoss, 3595);

    await assert.rejects(
      restarted.save(state({
        protectionStatus: "PENDING",
        updatedAt: 1_789_000_005_000,
      })),
      /transition/i,
    );
  } finally {
    restarted.close();
  }
});

test("manual close creates a tombstone so the same ownership cannot be re-adopted", async () => {
  const directory = mkdtempSync(join(tmpdir(), "phase7c-semi-close-"));
  const databasePath = join(directory, "execution-state.sqlite");
  const repository = new Phase7CSemiAdoptionStateRepository(databasePath);

  try {
    await repository.save(state());
    await repository.markClosed("99001", 1_789_000_020_000, "MANUAL_CLOSE");

    assert.equal(await repository.findByTicket("99001"), null);
    assert.equal(
      await repository.isOwnershipClosed("semi:99001:1789000000000"),
      true,
    );
    await assert.rejects(repository.save(state()), /closed/i);
  } finally {
    repository.close();
  }
});
