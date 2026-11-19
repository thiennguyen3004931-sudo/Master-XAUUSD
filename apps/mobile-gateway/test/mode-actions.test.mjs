import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createTransactionStore } = require("../transaction-store.cjs");
const { createM4ActionBroker } = require("../m4-action-broker.cjs");

function brokerWithCanonical(canonical) {
  return createM4ActionBroker({
    canonical,
    transactions: createTransactionStore({ now: () => 1_000, randomUUID: () => "tx-1" }),
    audit: { before: async () => {}, after: async () => {} },
    now: () => 1_000,
  });
}

test("mode broker forwards only fixed approved mode action to canonical client", async () => {
  for (const action of ["MODE_AUTO", "MODE_SEMI", "MODE_TREND", "MODE_SIDEWAY", "MODE_PAUSE"]) {
    const calls = [];
    const broker = brokerWithCanonical({
      executeModeAction: async (received) => {
        calls.push(received);
        return { state: { mode: action.replace("MODE_", "") } };
      },
    });
    const result = await broker.handleAction("operator@example.com", { action, confirmation: action });
    assert.deepEqual(calls, [action]);
    assert.equal(result.outcome, "PASS");
    assert.equal(result.action, action);
  }
});

test("canonical mode rejection remains failure", async () => {
  const broker = brokerWithCanonical({
    executeModeAction: async () => {
      const error = new Error("blocked by canonical gate");
      error.status = 409;
      throw error;
    },
  });
  const result = await broker.handleAction("operator@example.com", {
    action: "MODE_AUTO",
    confirmation: "MODE_AUTO",
  });
  assert.equal(result.outcome, "FAIL");
  assert.equal(result.httpStatus, 409);
  assert.match(result.message, /blocked/);
});

test("unknown or forbidden action never reaches canonical client", async () => {
  let calls = 0;
  const broker = brokerWithCanonical({
    executeModeAction: async () => { calls += 1; },
  });
  await assert.rejects(
    () => broker.handleAction("operator@example.com", { action: "ORDER_BUY" }),
    /UNSUPPORTED_ACTION/,
  );
  assert.equal(calls, 0);
});
