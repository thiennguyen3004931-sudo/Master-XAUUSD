import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  evaluatePhase7CAccountHealth,
  resolvePhase7CAccountRuntime,
} from "./phase7c-account-runtime-guard.mjs";
import {
  transformPhase7CSidewaySource,
  transformPhase7CTrendLegacySource,
} from "./phase7c-live-source-adapters.mjs";
import { buildSidewayPlan } from "./phase7c-sideway-logic.mjs";

const scriptsDir = fileURLToPath(new URL("./", import.meta.url));

function runtimeEnv(accountMode) {
  if (accountMode === "LIVE") {
    return {
      ZIQ_PHASE7C_ACCOUNT_MODE: "LIVE",
      ZIQ_PHASE7C_LIVE_EXECUTION_ENABLED: "true",
      MT5_ALLOW_REAL_ACCOUNT: "true",
      MT5_TRADING_ENABLED: "true",
      MT5_ALLOWED_LOGINS: "123456",
    };
  }
  return {
    ZIQ_PHASE7C_ACCOUNT_MODE: "DEMO",
    ZIQ_PHASE7C_LIVE_EXECUTION_ENABLED: "false",
    MT5_ALLOW_REAL_ACCOUNT: "false",
    MT5_TRADING_ENABLED: "true",
    MT5_ALLOWED_LOGINS: "123456",
  };
}

function health(accountMode, login = 123456) {
  return {
    status: "ok",
    connected: true,
    accountMode,
    accountLogin: login,
    tradingEnabled: true,
    terminalTradeAllowed: true,
    expertTradeAllowed: true,
  };
}

const demo = resolvePhase7CAccountRuntime(runtimeEnv("DEMO"));
assert.equal(demo.accountMode, "DEMO");
assert.equal(demo.expectedBrokerMode, "demo");
assert.equal(evaluatePhase7CAccountHealth(health("demo"), demo).allowed, true);
assert.equal(evaluatePhase7CAccountHealth(health("real"), demo).allowed, false);

const live = resolvePhase7CAccountRuntime(runtimeEnv("LIVE"));
assert.equal(live.accountMode, "LIVE");
assert.equal(live.expectedBrokerMode, "real");
assert.equal(evaluatePhase7CAccountHealth(health("real"), live).allowed, true);
assert.equal(evaluatePhase7CAccountHealth(health("demo"), live).allowed, false);
assert.equal(evaluatePhase7CAccountHealth(health("real", 999999), live).reason, "ACCOUNT_LOGIN_NOT_ALLOWLISTED");

assert.throws(
  () => resolvePhase7CAccountRuntime({ ...runtimeEnv("LIVE"), ZIQ_PHASE7C_LIVE_EXECUTION_ENABLED: "false" }),
  /LIVE runtime requires ZIQ_PHASE7C_LIVE_EXECUTION_ENABLED=true/,
);
assert.throws(
  () => resolvePhase7CAccountRuntime({ ...runtimeEnv("LIVE"), MT5_ALLOW_REAL_ACCOUNT: "false" }),
  /LIVE runtime requires MT5_ALLOW_REAL_ACCOUNT=true/,
);
assert.throws(
  () => resolvePhase7CAccountRuntime({ ...runtimeEnv("DEMO"), MT5_ALLOW_REAL_ACCOUNT: "true" }),
  /DEMO runtime requires MT5_ALLOW_REAL_ACCOUNT=false/,
);

const trendSource = fs.readFileSync(`${scriptsDir}run-phase7b-demo-controller.ts`, "utf8");
const trendLive = transformPhase7CTrendLegacySource(trendSource);
assert.match(trendLive, /health\.accountMode !== "real"/);
assert.doesNotMatch(trendLive, /Phase 7B DEMO refuses MT5_ALLOW_REAL_ACCOUNT=true/);
for (const marker of [
  "MIN_INITIAL_SL_PRICE = 6",
  "MAX_INITIAL_SL_PRICE = 10",
  "PHASE7B_DEMO_PLUS6=SL_TO_ENTRY",
  "PHASE7B_DEMO_PLUS10=PARTIAL_ONE_THIRD",
  "PHASE7B_DEMO_DAILY_RECOVERY_LOT_ESCALATION=OFF",
]) {
  assert.ok(trendSource.includes(marker), `Trend canonical source missing strategy marker: ${marker}`);
  assert.ok(trendLive.includes(marker), `Trend LIVE adapter mutated strategy marker: ${marker}`);
}

const sidewaySource = fs.readFileSync(`${scriptsDir}run-phase7c-sideway-controller.mjs`, "utf8");
const sidewayLive = transformPhase7CSidewaySource(sidewaySource);
assert.match(sidewayLive, /health\.accountMode !== "real"/);
for (const marker of [
  "PHASE7C_SIDEWAY_PLUS6=SL_TO_ENTRY",
  "PHASE7C_SIDEWAY_PLUS10=PARTIAL_DISABLED_WHILE_BROKER_TP_SL_TRAIL_ONLY",
  "PHASE7C_SIDEWAY_DAILY_RECOVERY_LOT_ESCALATION=OFF",
]) {
  assert.ok(sidewaySource.includes(marker), `Sideway canonical source missing strategy marker: ${marker}`);
  assert.ok(sidewayLive.includes(marker), `Sideway LIVE adapter mutated strategy marker: ${marker}`);
}

// Verify the canonical Sideway plan itself instead of relying on a controller
// log literal. A structural stop wider than 10 must fail closed and explicitly
// wait for a later pullback; a stop closer than 6 must be widened to 6.
const tooWidePlan = buildSidewayPlan({
  side: "BUY",
  bid: 99.9,
  ask: 100,
  range: {
    demand: { low: 89, high: 95 },
    supply: { low: 120, high: 122 },
  },
  atr: 1,
  point: 0.01,
  stopsLevelTicks: 0,
  digits: 2,
});
assert.equal(tooWidePlan.accepted, false);
assert.equal(tooWidePlan.reason, "WAIT_PULLBACK_STOP_GT_10");
assert.equal(tooWidePlan.maxInitialStopDistance, 10);

const widenedPlan = buildSidewayPlan({
  side: "BUY",
  bid: 99.9,
  ask: 100,
  range: {
    demand: { low: 96, high: 97 },
    supply: { low: 120, high: 122 },
  },
  atr: 1,
  point: 0.01,
  stopsLevelTicks: 0,
  digits: 2,
});
assert.equal(widenedPlan.accepted, true);
assert.equal(widenedPlan.stopPolicy, "WIDENED_TO_MIN_6");
assert.equal(widenedPlan.stopDistance, 6);

const sidewayLogicSource = fs.readFileSync(`${scriptsDir}phase7c-sideway-logic.mjs`, "utf8");
for (const marker of [
  "MIN_INITIAL_STOP_DISTANCE = 6",
  "MAX_INITIAL_STOP_DISTANCE = 10",
  'reason: "WAIT_PULLBACK_STOP_GT_10"',
  'stopPolicy: structuralStopDistance < MIN_INITIAL_STOP_DISTANCE',
]) {
  assert.ok(sidewayLogicSource.includes(marker), `Sideway canonical logic missing stop-policy marker: ${marker}`);
}

// Drift tests remove every account-mode marker. This proves the adapters fail
// closed instead of silently transforming only one of several guard clauses.
assert.throws(
  () => transformPhase7CTrendLegacySource(trendSource.replaceAll('health.accountMode !== "demo"', 'health.accountMode !== "paper"')),
  /adapter marker no longer matches source/,
);
assert.throws(
  () => transformPhase7CSidewaySource(sidewaySource.replaceAll('health.accountMode !== "demo"', 'health.accountMode !== "paper"')),
  /adapter marker no longer matches source/,
);

const sidewayLock = fs.readFileSync(`${scriptsDir}run-phase7c-sideway-locked.mjs`, "utf8");
assert.match(sidewayLock, /evaluatePhase7CAccountHealth/);
assert.match(sidewayLock, /fetchHealthUnderLock/);
assert.match(sidewayLock, /POSITION_PRESENT_UNDER_LOCK/);

const trendWrapper = fs.readFileSync(`${scriptsDir}run-phase7c-trend-account-mode.mjs`, "utf8");
assert.match(trendWrapper, /installPhase7CAccountOrderFetchGuard/);
assert.match(trendWrapper, /transformPhase7CTrendLegacySource/);

console.log("PHASE7C_DUAL_ACCOUNT_NODE_TEST=PASS");
