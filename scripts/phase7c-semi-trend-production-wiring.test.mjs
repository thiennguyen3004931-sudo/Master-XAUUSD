import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import {
  createPhase7CSemiTrendAdoptionRuntime,
} from "./phase7c-semi-trend-adoption-runtime.mjs";
import {
  transformPhase7CSemiTrendRuntimeSource,
} from "./phase7c-semi-trend-runtime-source-adapter.mjs";
import {
  evaluateSemiManualAdoption,
} from "../apps/api/dist/services/phase7c-semi-manual-adoption.service.js";

const NOW = 1_789_100_100_000;
const ACTIVATED_AT = 1_789_100_000_000;
const MANUAL_OPENED_AT = 1_789_100_002_000;

function mode(mode = "SEMI", updatedAt = ACTIVATED_AT) {
  return {
    state: {
      mode,
      updatedAt: new Date(updatedAt).toISOString(),
      updatedBy: "web-control-center",
    },
  };
}

function health(overrides = {}) {
  return {
    status: "ok",
    connected: true,
    tradingEnabled: true,
    terminalTradeAllowed: true,
    expertTradeAllowed: true,
    accountLogin: 5201362,
    accountMode: "real",
    liveExecutionArmed: true,
    liveArmStatus: "ARMED",
    timestamp: NOW,
    ...overrides,
  };
}

function position(overrides = {}) {
  return {
    ticket: "99001",
    symbol: "XAUUSD",
    brokerSymbol: "XAUUSD",
    side: "LONG",
    volume: 0.12,
    entry: 3600,
    stopLoss: 0,
    takeProfit: 0,
    profit: 0,
    swap: 0,
    commission: 0,
    openedAt: MANUAL_OPENED_AT,
    ...overrides,
  };
}

function deal(overrides = {}) {
  return {
    ticket: "88001",
    orderId: "77001",
    positionId: "99001",
    symbol: "XAUUSD",
    side: "BUY",
    entry: "IN",
    volume: 0.12,
    price: 3600,
    profit: 0,
    commission: 0,
    swap: 0,
    fee: 0,
    netPnl: 0,
    magic: 0,
    comment: "",
    timestamp: MANUAL_OPENED_AT,
    isTradingDeal: true,
    ...overrides,
  };
}

function spec() {
  return {
    symbol: "XAUUSD",
    brokerSymbol: "XAUUSD",
    tickSize: 0.01,
    point: 0.01,
    digits: 2,
    minVolume: 0.01,
    maxVolume: 100,
    volumeStep: 0.01,
    maxSpread: 10,
    stopsLevelTicks: 10,
    freezeLevelTicks: 10,
  };
}

function quote() {
  return {
    symbol: "XAUUSD",
    brokerSymbol: "XAUUSD",
    bid: 3600.1,
    ask: 3600.2,
    spread: 0.1,
    timestamp: NOW,
  };
}

function durableState(overrides = {}) {
  return {
    version: 1,
    ownershipId: `semi:99001:${ACTIVATED_AT}`,
    ticket: "99001",
    openingDealTicket: "88001",
    symbol: "XAUUSD",
    accountLogin: "5201362",
    entrySource: "MANUAL",
    managementStrategy: "TREND",
    side: "LONG",
    entry: 3600,
    initialVolume: 0.12,
    expectedRemainingVolume: 0.12,
    activationEpochMs: ACTIVATED_AT,
    manualOpenedAt: MANUAL_OPENED_AT,
    managementStartedAt: NOW,
    initialStopDistance: 6,
    targetStopLoss: 3594,
    tightestStopLoss: 3594,
    protectionStatus: "PENDING",
    protectionReason: "PROTECTION_REQUIRED",
    fixedTakeProfit: { enabled: true, targetPrice: 3620 },
    updatedAt: NOW,
    ...overrides,
  };
}

function harness(overrides = {}) {
  const events = [];
  const states = new Map();
  let currentMode = overrides.mode ?? mode();
  let modeReads = 0;
  let currentPosition = overrides.position ?? position();
  let protectionCalls = 0;
  let lockReleases = 0;

  const repository = {
    async findByTicket(ticket) {
      return states.get(ticket) ?? null;
    },
    async listActive() {
      return [...states.values()];
    },
    async save(next) {
      states.set(next.ticket, structuredClone(next));
    },
    async markClosed(ticket) {
      states.delete(ticket);
      events.push(`CLOSED:${ticket}`);
    },
  };

  const deps = {
    now: () => NOW,
    accountRuntime: {
      accountMode: "LIVE",
      expectedBrokerMode: "real",
      liveExecutionEnabled: true,
      allowRealAccount: true,
      tradingConfigured: true,
      allowedLogins: new Set([5201362]),
    },
    armed: true,
    getBotMode: async () => {
      modeReads += 1;
      if (overrides.modeAfterLock && modeReads >= 2) return overrides.modeAfterLock;
      return currentMode;
    },
    getHealth: async () => overrides.health ?? health(),
    getPositions: async () => (currentPosition ? [structuredClone(currentPosition)] : []),
    getDeals: async () => structuredClone(overrides.deals ?? [deal()]),
    getQuote: async () => quote(),
    getSpec: async () => spec(),
    evaluateAdoption: evaluateSemiManualAdoption,
    adoptionRepository: repository,
    acquireExecutionLock: () => overrides.lockBusy
      ? { acquired: false, reason: "LOCK_BUSY", file: "test.lock" }
      : {
          acquired: true,
          file: "test.lock",
          release() { lockReleases += 1; },
        },
    executeProtection: async (ticket) => {
      protectionCalls += 1;
      const saved = states.get(ticket);
      assert.ok(saved, "PENDING durable adoption must exist before broker protection");
      currentPosition = position({ stopLoss: saved.targetStopLoss, takeProfit: saved.fixedTakeProfit.targetPrice ?? 0 });
      const protectedState = {
        ...saved,
        protectionStatus: "PROTECTED",
        protectionReason: "BROKER_CONFIRMED",
        tightestStopLoss: saved.targetStopLoss,
        updatedAt: NOW,
      };
      states.set(ticket, protectedState);
      return {
        status: "PROTECTED",
        reason: "BROKER_CONFIRMED",
        brokerMutationAttempted: true,
        state: structuredClone(protectedState),
      };
    },
    log: (event, detail) => events.push(`${event}:${detail ?? ""}`),
  };

  return {
    runtime: createPhase7CSemiTrendAdoptionRuntime(deps),
    states,
    events,
    get protectionCalls() { return protectionCalls; },
    get lockReleases() { return lockReleases; },
  };
}

test("non-SEMI mode never acquires protection ownership", async () => {
  const h = harness({ mode: mode("TREND") });
  const result = await h.runtime.reconcile({
    symbol: "XAUUSD",
    trendFixedTpEnabled: true,
    trendFixedTpDistance: 20,
    latestM15CloseTime: MANUAL_OPENED_AT - 1,
    systemMagicNumber: 270713,
  });

  assert.equal(result.status, "SKIPPED");
  assert.equal(result.reason, "MODE_NOT_SEMI");
  assert.equal(h.protectionCalls, 0);
  assert.equal(h.states.size, 0);
});

test("LIVE SEMI refuses adoption while bridge session is not ARMED", async () => {
  const h = harness({ health: health({ liveExecutionArmed: false, liveArmStatus: "DISARMED" }) });
  const result = await h.runtime.reconcile({
    symbol: "XAUUSD",
    trendFixedTpEnabled: true,
    trendFixedTpDistance: 20,
    latestM15CloseTime: MANUAL_OPENED_AT - 1,
    systemMagicNumber: 270713,
  });

  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "LIVE_ARM_REQUIRED");
  assert.equal(h.protectionCalls, 0);
  assert.equal(h.states.size, 0);
});

test("SEMI is rechecked under the shared execution lock before any protection mutation", async () => {
  const h = harness({ modeAfterLock: mode("PAUSE", ACTIVATED_AT + 5_000) });
  const result = await h.runtime.reconcile({
    symbol: "XAUUSD",
    trendFixedTpEnabled: true,
    trendFixedTpDistance: 20,
    latestM15CloseTime: MANUAL_OPENED_AT - 1,
    systemMagicNumber: 270713,
  });

  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "MODE_CHANGED_UNDER_LOCK");
  assert.equal(h.protectionCalls, 0);
  assert.equal(h.states.size, 0);
  assert.equal(h.lockReleases, 1);
});

test("valid manual LIVE position is protected then handed to the real Trend managed-state loop", async () => {
  const h = harness();
  const result = await h.runtime.reconcile({
    symbol: "XAUUSD",
    trendFixedTpEnabled: true,
    trendFixedTpDistance: 20,
    latestM15CloseTime: MANUAL_OPENED_AT - 1,
    systemMagicNumber: 270713,
  });

  assert.equal(result.status, "ADOPTED");
  assert.equal(h.protectionCalls, 1);
  assert.equal(h.lockReleases, 1);
  assert.equal(h.states.get("99001")?.protectionStatus, "PROTECTED");
  assert.equal(result.managed.ticket, "99001");
  assert.equal(result.managed.side, "BUY");
  assert.equal(result.managed.entry, 3600);
  assert.equal(result.managed.initialVolume, 0.12);
  assert.equal(result.managed.expectedRemainingVolume, 0.12);
  assert.equal(result.managed.stopDistance, 6);
  assert.equal(result.managed.fixedTpEnabled, true);
  assert.equal(result.managed.fixedTpDistance, 20);
  assert.equal(result.managed.fixedTpPrice, 3620);
  assert.equal(result.managed.breakEvenApplied, false);
  assert.equal(result.managed.partialApplied, false);
  assert.equal(result.managed.dailyMode, "TREND");
  assert.equal(result.position.stopLoss, 3594);
  assert.equal(result.position.takeProfit, 3620);
});

test("foreign/non-manual opening deal fails closed before durable ownership or protection", async () => {
  const h = harness({ deals: [deal({ magic: 991122 })] });
  const result = await h.runtime.reconcile({
    symbol: "XAUUSD",
    trendFixedTpEnabled: false,
    trendFixedTpDistance: 0,
    latestM15CloseTime: MANUAL_OPENED_AT - 1,
    systemMagicNumber: 270713,
  });

  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "MANUAL_PROVENANCE_NOT_PROVEN");
  assert.equal(h.protectionCalls, 0);
  assert.equal(h.states.size, 0);
});

test("busy shared execution lock causes zero durable or broker mutation", async () => {
  const h = harness({ lockBusy: true });
  const result = await h.runtime.reconcile({
    symbol: "XAUUSD",
    trendFixedTpEnabled: false,
    trendFixedTpDistance: 0,
    latestM15CloseTime: MANUAL_OPENED_AT - 1,
    systemMagicNumber: 270713,
  });

  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason, "EXECUTION_LOCK_BUSY");
  assert.equal(h.protectionCalls, 0);
  assert.equal(h.states.size, 0);
});

test("closing a managed SEMI ticket tombstones only an existing SEMI adoption", async () => {
  const h = harness();
  await h.states.set("99001", durableState({ protectionStatus: "MANAGED", protectionReason: "TREND_MANAGEMENT_ACTIVE" }));

  const result = await h.runtime.markClosedIfAdopted("99001", NOW + 1_000);
  assert.equal(result.status, "CLOSED");
  assert.equal(h.states.has("99001"), false);
  assert.ok(h.events.includes("CLOSED:99001"));
});

test("source adapter hands unmanaged broker positions to SEMI adoption before legacy UNMANAGED_POSITION_PRESENT", () => {
  const source = fs.readFileSync(new URL("./run-phase7b-demo-controller.ts", import.meta.url), "utf8");
  const output = transformPhase7CSemiTrendRuntimeSource(source);

  assert.match(output, /reconcilePhase7CSemiManualPosition/);
  assert.match(output, /SEMI_MANUAL_POSITION_ADOPTED/);
  assert.match(output, /await managePosition\(semiAdoption\.position, quote, spec, m15\)/);
  assert.doesNotMatch(output, /await managePosition\(positions\[0\], quote, spec, m15\)/);
  assert.match(output, /markPhase7CSemiManualAdoptionClosed/);
});

test("production Trend wrapper applies the SEMI runtime source adapter before TypeScript transpilation", () => {
  const wrapper = fs.readFileSync(new URL("./run-phase7c-trend-controller.mjs", import.meta.url), "utf8");
  assert.match(wrapper, /transformPhase7CSemiTrendRuntimeSource/);
  assert.match(wrapper, /transformPhase7CSemiTrendRuntimeSource\(source\)/);
});
