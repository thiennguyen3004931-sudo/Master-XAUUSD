import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createTransactionStore } = require("../transaction-store.cjs");
const { createM4ActionBroker } = require("../m4-action-broker.cjs");

function makeBroker({ canonical, audit, randomUUID = () => "tx-1" }) {
  return createM4ActionBroker({
    canonical,
    transactions: createTransactionStore({ now: () => 1_000, randomUUID }),
    audit,
    now: () => 1_000,
  });
}

const throwingAudit = {
  append() {
    throw new Error("AUDIT_WRITE_FAILED");
  },
};

test("risk-increasing mode actions fail closed before canonical mutation when audit is unavailable", async () => {
  for (const action of ["MODE_AUTO", "MODE_SEMI", "MODE_TREND", "MODE_SIDEWAY"]) {
    let canonicalCalls = 0;
    const broker = makeBroker({
      canonical: { executeModeAction: async () => { canonicalCalls += 1; return {}; } },
      audit: throwingAudit,
    });
    await assert.rejects(
      () => broker.handleAction("operator@example.com", { action, confirmation: action }),
      /AUDIT_WRITE_FAILED/,
      action,
    );
    assert.equal(canonicalCalls, 0, action);
  }
});

test("MODE_PAUSE remains reachable when audit is degraded", async () => {
  let canonicalCalls = 0;
  const broker = makeBroker({
    canonical: { executeModeAction: async () => { canonicalCalls += 1; return { state: { mode: "PAUSE" } }; } },
    audit: throwingAudit,
  });
  const result = await broker.handleAction("operator@example.com", {
    action: "MODE_PAUSE",
    confirmation: "MODE_PAUSE",
  });
  assert.equal(canonicalCalls, 1);
  assert.equal(result.outcome, "PASS");
  assert.equal(result.auditDegraded, true);
});

test("ARM execute fails closed on audit failure but DISARM execute remains reachable", async () => {
  for (const [action, expectExecute] of [["ARM_LIVE", false], ["DISARM_LIVE", true]]) {
    let executeCalls = 0;
    const canonical = {
      getArmCapability: async () => ({ canArm: true, canDisarm: true }),
      createArmPreflight: async (requested) => ({
        approved: true,
        action: requested,
        preflightToken: "secret",
        expiresAt: 46_000,
        checks: {},
        blockedBy: [],
      }),
      executeArm: async () => {
        executeCalls += 1;
        return { requestId: "req-1", status: "RUNNING", message: "accepted" };
      },
    };
    const broker = makeBroker({ canonical, audit: throwingAudit });
    const preflight = await broker.handleAction("operator@example.com", { action, phase: "PREFLIGHT" });

    const execute = () => broker.handleAction("operator@example.com", {
      action,
      phase: "EXECUTE",
      transactionId: preflight.transactionId,
      confirmation: action,
    });

    if (expectExecute) {
      const result = await execute();
      assert.equal(result.outcome, "RUNNING");
      assert.equal(result.auditDegraded, true);
    } else {
      await assert.rejects(execute, /AUDIT_WRITE_FAILED/);
    }
    assert.equal(executeCalls, expectExecute ? 1 : 0, action);
  }
});
