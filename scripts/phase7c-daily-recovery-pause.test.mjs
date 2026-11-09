import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DAILY_RECOVERY_NEW_ENTRY_PAUSED,
  pauseDailyRecoveryForNewEntry,
  assertDailyRecoveryPausedBeforeSend,
} from "./phase7c-daily-recovery-pause.mjs";
import {
  fetchPhase7CCanonicalDailyRecoveryPlan,
  registerPhase7CCanonicalDailyRecoverySubmission,
  verifyPhase7CCanonicalDailyRecoverySubmission,
} from "./phase7c-canonical-daily-recovery-executor.mjs";
import {
  transformPhase7CSidewayCanonicalDailyRecoverySource,
  transformPhase7CTrendCanonicalDailyRecoverySource,
} from "./phase7c-canonical-daily-recovery-source-adapter.mjs";

const sourceDir = dirname(fileURLToPath(import.meta.url));
const read = name => readFileSync(join(sourceDir, name), "utf8");

function view(dailyNetPnl, volume = 0.03) {
  const loss = dailyNetPnl < 0;
  return {
    source: "MT5_DEMO_READ_ONLY",
    readOnly: true,
    dayStartTime: 1_750_000_000_000,
    dailyNetPnl,
    dailyMode: loss ? "RECOVERY_TP" : "NORMAL",
    dealCount: 2,
    preview: {
      volume,
      requiredUsd: loss ? 243.7 : 0,
      rawTpDistance: loss ? 81.2 : null,
      tpDistance: loss ? 10 : null,
      canRecoverInOneTrade: false,
    },
    strategy: { targetNetUsd: 1 },
  };
}
const fetchView = (dailyNetPnl, volume = 0.03) => async () => ({
  ok: true,
  status: 200,
  async text() { return JSON.stringify(view(dailyNetPnl, volume)); },
});

test("operator pause is source-locked and cannot silently be overridden by environment", () => {
  assert.equal(DAILY_RECOVERY_NEW_ENTRY_PAUSED, true);
  assert.equal(read("phase7c-daily-recovery-pause.mjs").includes("process.env."), false);
});

for (const strategy of ["TREND", "SIDEWAY"]) {
  const native = strategy === "TREND" ? "TREND" : "SIDEWAY_NATIVE";
  test(strategy + ": negative canonical P/L is retained but no Recovery TP, lot escalation, or forced entry", async () => {
    const plan = await fetchPhase7CCanonicalDailyRecoveryPlan({
      strategy, symbol: "XAUUSD", volume: 0.03, fetchImpl: fetchView(-242.7),
    });
    assert.equal(plan.mode, native);
    assert.equal(plan.canonicalDailyMode, "RECOVERY_TP");
    assert.equal(plan.dailyNetPnl, -242.7);
    assert.equal(plan.dayStartTime, 1_750_000_000_000);
    assert.equal(plan.tpDistance, 0);
    assert.equal(plan.rawTpDistance, 0);
    assert.equal(plan.requiredUsd, 0);
    assert.equal(plan.recoveryEntryPaused, true);
    assert.equal(plan.recoveryPauseReason, "DAILY_RECOVERY_TEMPORARILY_DISABLED");
    assertDailyRecoveryPausedBeforeSend(strategy, plan);
    assert.equal(Object.isFrozen(plan), true);
  });

  test(strategy + ": positive P/L remains native and does not permit Recovery", async () => {
    const plan = await fetchPhase7CCanonicalDailyRecoveryPlan({
      strategy, symbol: "XAUUSD", volume: 0.03, fetchImpl: fetchView(15),
    });
    assert.equal(plan.mode, native);
    assert.equal(plan.canonicalDailyMode, "NORMAL");
    assert.equal(plan.dailyNetPnl, 15);
    assert.equal(plan.tpDistance, 0);
    assert.equal(plan.recoveryEntryPaused, true);
  });

  test(strategy + ": final broker SEND rejects direct Recovery snapshot injection", () => {
    assert.throws(() => assertDailyRecoveryPausedBeforeSend(strategy, {
      mode: "RECOVERY_TP", recoveryEntryPaused: false, tpDistance: 10,
    }), /DAILY_RECOVERY_PAUSE_FINAL_GATE_BLOCK/);
    assert.throws(() => registerPhase7CCanonicalDailyRecoverySubmission({
      strategy, clientOrderId: "synthetic-bypass", volume: 0.03,
      plan: { mode: "RECOVERY_TP", tpDistance: 10 },
    }), /DAILY_RECOVERY_PAUSE_FINAL_GATE_BLOCK/);
  });

  test(strategy + ": negative P/L canonical snapshot is re-verified before entry (read-only)", async () => {
    const initial = await fetchPhase7CCanonicalDailyRecoveryPlan({
      strategy, symbol: "XAUUSD", volume: 0.03, fetchImpl: fetchView(-20),
    });
    const orderId = "synthetic-recovery-paused-" + strategy;
    registerPhase7CCanonicalDailyRecoverySubmission({ strategy, clientOrderId: orderId, volume: 0.03, plan: initial });
    const accepted = await verifyPhase7CCanonicalDailyRecoverySubmission({
      strategy,
      requestBody: JSON.stringify({ clientOrderId: orderId, volume: 0.03, symbol: "XAUUSD" }),
      fetchImpl: fetchView(-20),
    });
    assert.equal(accepted.mode, native);
    assert.equal(accepted.recoveryEntryPaused, true);
    assert.equal(accepted.canonicalDailyMode, "RECOVERY_TP");
  });

  test(strategy + ": P/L changed before submission is still fail-closed", async () => {
    const initial = await fetchPhase7CCanonicalDailyRecoveryPlan({
      strategy, symbol: "XAUUSD", volume: 0.03, fetchImpl: fetchView(-20),
    });
    const orderId = "synthetic-flip-" + strategy;
    registerPhase7CCanonicalDailyRecoverySubmission({ strategy, clientOrderId: orderId, volume: 0.03, plan: initial });
    await assert.rejects(() => verifyPhase7CCanonicalDailyRecoverySubmission({
      strategy,
      requestBody: JSON.stringify({ clientOrderId: orderId, volume: 0.03, symbol: "XAUUSD" }),
      fetchImpl: fetchView(3),
    }), /changed before SEND/);
  });
}

test("raw local planners also freeze negative days; both account-mode transforms source canonical guard", () => {
  const trend = read("run-phase7b-demo-controller.ts");
  const sideway = read("run-phase7c-sideway-controller.mjs");
  assert.match(trend, /return pauseDailyRecoveryForNewEntry\("TREND", \{\s*mode: "RECOVERY_TP"/);
  assert.match(sideway, /return pauseDailyRecoveryForNewEntry\("SIDEWAY", \{\s*mode: "RECOVERY_TP"/);
  const transformedTrend = transformPhase7CTrendCanonicalDailyRecoverySource(trend);
  const transformedSideway = transformPhase7CSidewayCanonicalDailyRecoverySource(sideway);
  assert.match(transformedTrend, /fetchPhase7CCanonicalDailyRecoveryPlan\(\{\s*strategy: "TREND"/);
  assert.match(transformedSideway, /fetchPhase7CCanonicalDailyRecoveryPlan\(\{\s*strategy: "SIDEWAY"/);
  assert.match(trend, /dailyRecovery\.mode === "RECOVERY_TP"/);
  assert.match(sideway, /dailyRecovery\.mode === "RECOVERY_TP"/);
});

test("preexisting managed RECOVERY_TP remains durable and is NOT silently rewritten by this pause", () => {
  const trend = read("run-phase7b-demo-controller.ts");
  const sideway = read("run-phase7c-sideway-controller.mjs");
  assert.match(trend, /managed\.dailyMode === "RECOVERY_TP"/);
  assert.match(sideway, /managed\.dailyMode === "RECOVERY_TP"/);
  assert.equal(read("phase7c-daily-recovery-pause.mjs").includes("/v1/positions/"), false);
  assert.equal(read("phase7c-daily-recovery-pause.mjs").includes("/v1/orders"), false);
});
