import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createTransactionStore } = require("../transaction-store.cjs");
const { createM4ActionBroker } = require("../m4-action-broker.cjs");

function harness({ now = () => 1_000, preflightExpiresAt = 46_000 } = {}) {
  const calls = [];
  const canonical = {
    getArmCapability: async () => {
      calls.push(["capability"]);
      return { canArm: true, canDisarm: true, bridgeSessionId: "session-1" };
    },
    createArmPreflight: async (action) => {
      calls.push(["preflight", action]);
      return {
        approved: true,
        action,
        bridgeSessionId: "session-1",
        preflightToken: "SECRET-CANONICAL-TOKEN",
        expiresAt: preflightExpiresAt,
        checks: { botPaused: true },
        blockedBy: [],
      };
    },
    executeArm: async (action, token) => {
      calls.push(["execute", action, token]);
      return { accepted: true, requestId: "req-1", action, status: "RUNNING", message: "accepted" };
    },
    getArmStatus: async (requestId) => {
      calls.push(["status", requestId]);
      return { requestId, action: "ARM_LIVE", status: "PASS", phase: "DONE", message: "ok", finalArmStatus: "ARMED" };
    },
  };
  const store = createTransactionStore({ now, randomUUID: () => "tx-1" });
  const broker = createM4ActionBroker({
    canonical,
    transactions: store,
    audit: { before: async () => {}, after: async () => {} },
    now,
  });
  return { broker, store, calls };
}

test("ARM preflight keeps canonical token server-side", async () => {
  const { broker, store, calls } = harness();
  const result = await broker.handleAction("operator@example.com", {
    action: "ARM_LIVE",
    phase: "PREFLIGHT",
  });

  assert.deepEqual(calls, [["capability"], ["preflight", "ARM_LIVE"]]);
  assert.equal(result.approved, true);
  assert.equal(result.transactionId, "tx-1");
  assert.equal(JSON.stringify(result).includes("SECRET-CANONICAL-TOKEN"), false);

  const internal = store._unsafePeekForTest("tx-1");
  assert.equal(internal.identity, "operator@example.com");
  assert.equal(internal.action, "ARM_LIVE");
  assert.equal(internal.canonicalToken, "SECRET-CANONICAL-TOKEN");
  assert.equal(internal.expiresAt, 46_000);
  assert.equal(internal.consumed, false);
});

test("valid ARM execute consumes transaction once and calls canonical once", async () => {
  const { broker, calls } = harness();
  await broker.handleAction("operator@example.com", { action: "ARM_LIVE", phase: "PREFLIGHT" });
  const result = await broker.handleAction("operator@example.com", {
    action: "ARM_LIVE",
    phase: "EXECUTE",
    transactionId: "tx-1",
    confirmation: "ARM_LIVE",
  });
  assert.equal(result.outcome, "RUNNING");
  assert.equal(result.transactionId, "tx-1");
  assert.deepEqual(calls.filter((entry) => entry[0] === "execute"), [
    ["execute", "ARM_LIVE", "SECRET-CANONICAL-TOKEN"],
  ]);

  await assert.rejects(
    () => broker.handleAction("operator@example.com", {
      action: "ARM_LIVE",
      phase: "EXECUTE",
      transactionId: "tx-1",
      confirmation: "ARM_LIVE",
    }),
    /TRANSACTION_ALREADY_CONSUMED/,
  );
  assert.equal(calls.filter((entry) => entry[0] === "execute").length, 1);
});

test("execute rejects wrong identity, wrong action, expired transaction, and bad confirmation without canonical execute", async () => {
  {
    const { broker, calls } = harness();
    await broker.handleAction("operator@example.com", { action: "ARM_LIVE", phase: "PREFLIGHT" });
    await assert.rejects(() => broker.handleAction("other@example.com", {
      action: "ARM_LIVE", phase: "EXECUTE", transactionId: "tx-1", confirmation: "ARM_LIVE",
    }), /TRANSACTION_IDENTITY_MISMATCH/);
    assert.equal(calls.some((entry) => entry[0] === "execute"), false);
  }

  {
    const { broker, calls } = harness();
    await broker.handleAction("operator@example.com", { action: "ARM_LIVE", phase: "PREFLIGHT" });
    await assert.rejects(() => broker.handleAction("operator@example.com", {
      action: "DISARM_LIVE", phase: "EXECUTE", transactionId: "tx-1", confirmation: "DISARM_LIVE",
    }), /TRANSACTION_ACTION_MISMATCH/);
    assert.equal(calls.some((entry) => entry[0] === "execute"), false);
  }

  {
    let clock = 1_000;
    const { broker, calls } = harness({ now: () => clock, preflightExpiresAt: 1_500 });
    await broker.handleAction("operator@example.com", { action: "ARM_LIVE", phase: "PREFLIGHT" });
    clock = 2_000;
    await assert.rejects(() => broker.handleAction("operator@example.com", {
      action: "ARM_LIVE", phase: "EXECUTE", transactionId: "tx-1", confirmation: "ARM_LIVE",
    }), /TRANSACTION_EXPIRED/);
    assert.equal(calls.some((entry) => entry[0] === "execute"), false);
  }

  {
    const { broker, calls } = harness();
    await broker.handleAction("operator@example.com", { action: "ARM_LIVE", phase: "PREFLIGHT" });
    await assert.rejects(() => broker.handleAction("operator@example.com", {
      action: "ARM_LIVE", phase: "EXECUTE", transactionId: "tx-1", confirmation: "DISARM_LIVE",
    }), /CONFIRMATION_MISMATCH/);
    assert.equal(calls.some((entry) => entry[0] === "execute"), false);
  }
});

test("status is resolved only through same-identity gateway transaction and reports canonical PASS", async () => {
  const { broker, calls } = harness();
  await broker.handleAction("operator@example.com", { action: "ARM_LIVE", phase: "PREFLIGHT" });
  await broker.handleAction("operator@example.com", {
    action: "ARM_LIVE", phase: "EXECUTE", transactionId: "tx-1", confirmation: "ARM_LIVE",
  });

  await assert.rejects(
    () => broker.getTransactionStatus("other@example.com", "tx-1"),
    /TRANSACTION_IDENTITY_MISMATCH/,
  );

  const status = await broker.getTransactionStatus("operator@example.com", "tx-1");
  assert.equal(status.status, "PASS");
  assert.equal(status.finalArmStatus, "ARMED");
  assert.equal(JSON.stringify(status).includes("SECRET-CANONICAL-TOKEN"), false);
  assert.deepEqual(calls.filter((entry) => entry[0] === "status"), [["status", "req-1"]]);
});

test("DISARM also requires canonical capability, preflight and execute", async () => {
  const { broker, calls } = harness();
  const preflight = await broker.handleAction("operator@example.com", {
    action: "DISARM_LIVE",
    phase: "PREFLIGHT",
  });
  assert.equal(preflight.approved, true);
  await broker.handleAction("operator@example.com", {
    action: "DISARM_LIVE",
    phase: "EXECUTE",
    transactionId: "tx-1",
    confirmation: "DISARM_LIVE",
  });
  assert.deepEqual(calls.slice(0, 3), [
    ["capability"],
    ["preflight", "DISARM_LIVE"],
    ["execute", "DISARM_LIVE", "SECRET-CANONICAL-TOKEN"],
  ]);
});
