import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  transformPhase7CSidewayCanonicalDailyRecoverySource,
  transformPhase7CTrendCanonicalDailyRecoverySource,
} from "./phase7c-canonical-daily-recovery-source-adapter.mjs";
import { transformPhase7CTrendLegacySource } from "./phase7c-live-source-adapters.mjs";
import {
  fetchPhase7CCanonicalDailyRecoveryPlan,
  registerPhase7CCanonicalDailyRecoverySubmission,
  verifyPhase7CCanonicalDailyRecoverySubmission,
} from "./phase7c-canonical-daily-recovery-executor.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const trendAccountMode = read("scripts/run-phase7c-trend-account-mode.mjs");
const sidewayAccountMode = read("scripts/run-phase7c-sideway-account-mode.mjs");
const sidewayLocked = read("scripts/run-phase7c-sideway-locked.mjs");
const accountGuard = read("scripts/phase7c-account-runtime-guard.mjs");
const canonicalExecutor = read("scripts/phase7c-canonical-daily-recovery-executor.mjs");
const trendLegacy = read("scripts/run-phase7b-demo-controller.ts");
const sidewayLegacy = read("scripts/run-phase7c-sideway-controller.mjs");

assert.ok(
  trendAccountMode.includes("transformPhase7CTrendCanonicalDailyRecoverySource"),
  "Trend DEMO and LIVE runtime must canonicalize legacy Daily Recovery planning before execution.",
);
assert.ok(
  sidewayAccountMode.includes("transformPhase7CSidewayCanonicalDailyRecoverySource"),
  "Sideway DEMO and LIVE runtime must canonicalize Daily Recovery planning before execution.",
);
assert.ok(
  sidewayLocked.includes("installPhase7CAccountOrderFetchGuard") &&
    sidewayLocked.indexOf("installPhase7CAccountOrderFetchGuard") < sidewayLocked.indexOf("const nativeFetch = globalThis.fetch.bind(globalThis)"),
  "Sideway account/canonical order guard must be installed before the execution-lock wrapper captures nativeFetch.",
);
assert.ok(
  sidewayLocked.includes("PHASE7C_SIDEWAY_ACCOUNT_AND_CANONICAL_GATE=UNDER_EXECUTION_LOCK"),
  "Sideway must document that final account/canonical verification is under the shared execution lock.",
);

const transformedTrend = transformPhase7CTrendCanonicalDailyRecoverySource(trendLegacy);
const transformedSideway = transformPhase7CSidewayCanonicalDailyRecoverySource(sidewayLegacy);

assert.ok(
  transformedTrend.includes("async function readPhase7CReversalEntryContext()"),
  "Trend canonical Daily Recovery transform must preserve the REVERSAL context reader definition.",
);
assert.ok(
  transformedTrend.includes("function effectiveTrendEntryConfig("),
  "Trend canonical Daily Recovery transform must preserve the REVERSAL effective-entry-config helper.",
);
assert.equal(
  (transformedTrend.match(/readPhase7CReversalEntryContext\s*\(/g) ?? []).length >= 2,
  true,
  "Trend transformed runtime must retain REVERSAL context calls together with its definition.",
);

const transformedLiveTrend = transformPhase7CTrendCanonicalDailyRecoverySource(
  transformPhase7CTrendLegacySource(trendLegacy),
);
assert.equal(
  (transformedLiveTrend.match(/async\s+function\s+readPhase7CReversalEntryContext\s*\(/g) ?? []).length,
  1,
  "Full LIVE account + canonical Daily Recovery transform must preserve exactly one REVERSAL context definition.",
);
assert.equal(
  (transformedLiveTrend.match(/function\s+effectiveTrendEntryConfig\s*\(/g) ?? []).length,
  1,
  "Full LIVE transform must preserve exactly one REVERSAL effective-entry-config helper.",
);
assert.ok(
  (transformedLiveTrend.match(/readPhase7CReversalEntryContext\s*\(/g) ?? []).length >= 2,
  "Full LIVE transformed Trend runtime must retain REVERSAL calls and definition together.",
);
for (const [strategy, transformed] of [["TREND", transformedTrend], ["SIDEWAY", transformedSideway]]) {
  assert.ok(
    transformed.includes("fetchPhase7CCanonicalDailyRecoveryPlan"),
    `${strategy} transformed planner must fetch canonical Daily Recovery.`,
  );
  assert.ok(
    transformed.includes("registerPhase7CCanonicalDailyRecoverySubmission"),
    `${strategy} transformed planner must register the canonical snapshot for final SEND verification.`,
  );
  assert.ok(
    !transformed.includes("/v1/history/deals?fromMs="),
    `${strategy} transformed runtime must not derive Daily Recovery from private broker deal-history math.`,
  );
}

assert.ok(
  canonicalExecutor.includes("/api/v1/phase7c/daily-recovery?symbol="),
  "Executor canonical Daily Recovery must use the existing canonical API view.",
);
assert.ok(
  canonicalExecutor.includes('const expectedDailyMode = dailyNetPnl < 0 ? "RECOVERY_TP" : "NORMAL"'),
  "Canonical view must preserve reported positive/flat NORMAL and negative RECOVERY_TP for integrity checks, even when execution is paused.",
);
assert.ok(
  canonicalExecutor.includes("submission snapshot is missing"),
  "Missing planner snapshot must fail closed at final SEND verification.",
);
assert.ok(
  canonicalExecutor.includes("changed before SEND"),
  "A canonical snapshot change between planning and SEND must fail closed.",
);

const verifyIndex = accountGuard.indexOf("verifyPhase7CCanonicalDailyRecoverySubmission");
const rawSendIndex = accountGuard.indexOf("return nativeFetch(input, init);", verifyIndex);
assert.ok(
  verifyIndex >= 0 && rawSendIndex > verifyIndex,
  "Common account-order transport guard must verify canonical Daily Recovery before raw broker SEND.",
);
assert.ok(
  accountGuard.includes("CANONICAL_DAILY_RECOVERY_FINAL_GATE_FAIL_CLOSED"),
  "Canonical Daily Recovery unavailable/malformed/mismatched at final gate must return a fail-closed block.",
);

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(payload); },
  };
}

function canonicalView({ dailyNetPnl, volume = 0.03, dayStartTime = 1_725_216_000_000 } = {}) {
  const recovery = dailyNetPnl < 0;
  return {
    source: "MT5_LIVE_READ_ONLY",
    readOnly: true,
    symbol: "XAUUSD",
    dayStartTime,
    historyEndTime: dayStartTime + 60_000,
    dealCount: 2,
    dailyNetPnl,
    dailyMode: recovery ? "RECOVERY_TP" : "NORMAL",
    nextEntryManagement: recovery ? "FULL_POSITION_ADAPTIVE_TP_6_TO_10" : "REGIME_NATIVE",
    preview: {
      volume,
      cashPerPriceUnitPerLot: 100,
      requiredUsd: recovery ? Math.abs(dailyNetPnl) + 1 : 0,
      rawTpDistance: recovery ? 7 : null,
      tpDistance: recovery ? 7 : null,
      canRecoverInOneTrade: true,
    },
    strategy: {
      trendMagicNumber: 270715,
      sidewayMagicNumber: 270714,
      configuredMagicNumbers: [270715, 270714],
      targetNetUsd: 1,
      minTpDistance: 6,
      maxTpDistance: 10,
      lotEscalation: false,
      forcedEntry: false,
      forceRegime: false,
      newPositionsOnly: true,
    },
  };
}

const positivePlan = await fetchPhase7CCanonicalDailyRecoveryPlan({
  strategy: "TREND",
  symbol: "XAUUSD",
  volume: 0.03,
  fetchImpl: async () => jsonResponse(canonicalView({ dailyNetPnl: 12.5 })),
});
assert.equal(positivePlan.mode, "TREND");
assert.equal(positivePlan.canonicalDailyMode, "NORMAL");
assert.equal(positivePlan.dailyNetPnl, 12.5);
assert.equal(positivePlan.tpDistance, 0);

const negativePlan = await fetchPhase7CCanonicalDailyRecoveryPlan({
  strategy: "SIDEWAY",
  symbol: "XAUUSD",
  volume: 0.03,
  fetchImpl: async () => jsonResponse(canonicalView({ dailyNetPnl: -20 })),
});
assert.equal(negativePlan.mode, "SIDEWAY_NATIVE");
assert.equal(negativePlan.canonicalDailyMode, "RECOVERY_TP");
assert.equal(negativePlan.dailyNetPnl, -20);
assert.equal(negativePlan.tpDistance, 0);
assert.equal(negativePlan.recoveryEntryPaused, true);

registerPhase7CCanonicalDailyRecoverySubmission({
  strategy: "TREND",
  clientOrderId: "positive-day-order",
  volume: 0.03,
  plan: positivePlan,
});
await verifyPhase7CCanonicalDailyRecoverySubmission({
  strategy: "TREND",
  requestBody: JSON.stringify({ clientOrderId: "positive-day-order", symbol: "XAUUSD", volume: 0.03 }),
  fetchImpl: async () => jsonResponse(canonicalView({ dailyNetPnl: 12.5 })),
});

registerPhase7CCanonicalDailyRecoverySubmission({
  strategy: "SIDEWAY",
  clientOrderId: "pnl-flipped-before-send",
  volume: 0.03,
  plan: negativePlan,
});
await assert.rejects(
  verifyPhase7CCanonicalDailyRecoverySubmission({
    strategy: "SIDEWAY",
    requestBody: JSON.stringify({ clientOrderId: "pnl-flipped-before-send", symbol: "XAUUSD", volume: 0.03 }),
    fetchImpl: async () => jsonResponse(canonicalView({ dailyNetPnl: 3 })),
  }),
  /changed before SEND/,
);

await assert.rejects(
  fetchPhase7CCanonicalDailyRecoveryPlan({
    strategy: "TREND",
    symbol: "XAUUSD",
    volume: 0.03,
    fetchImpl: async () => jsonResponse({ error: "unavailable" }, 503),
  }),
  /HTTP 503/,
);

console.log("PHASE7C_CANONICAL_DAILY_RECOVERY_EXECUTORS_CONTRACT=PASS");
console.log("TREND_DAILY_RECOVERY_SOURCE=CANONICAL");
console.log("SIDEWAY_DAILY_RECOVERY_SOURCE=CANONICAL");
console.log("CANONICAL_POSITIVE_DAY_RECOVERY=FORBIDDEN");
console.log("CANONICAL_UNVERIFIED_PRE_SEND=FAIL_CLOSED");
