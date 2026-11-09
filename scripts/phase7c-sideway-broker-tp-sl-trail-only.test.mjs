import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { transformPhase7CSidewayM5TrailingSource } from "./phase7c-m5-structural-trailing-source-adapter.mjs";
import { tightestKnownStop } from "./phase7c-stop-monotonicity.mjs";
import { evaluateM5StructuralTrail } from "./phase7c-m5-structural-trailing.mjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(root, "run-phase7c-sideway-controller.mjs"), "utf8");
const start = source.indexOf("async function managePosition(");
const end = source.indexOf("async function closeAll(", start);
assert.ok(start >= 0 && end > start, "SIDEWAY managed-position body required");
const managedSource = source.slice(start, end);

function syntheticCycle({ dailyMode = "SIDEWAY_NATIVE", side = "BUY", quoteBid = 2500, quoteAsk = 2500.2 } = {}) {
  const actions = [];
  const events = [];
  const managed = {
    ticket: "synthetic-ticket-1", side, entry: 2500,
    timeStopAt: 1, lastRegimeCloseChecked: 10, lastHoldM15Key: "",
    dailyMode, breakEvenApplied: false, fastMovePeakPrice: 2500,
    fastMoveStop: side === "BUY" ? 2490 : 2510, fastMoveAttempt: 0, breakEvenAttempt: 0,
    tp1: 2510, tp2: 2512, partialApplied: false, partialAttempt: 0,
    initialVolume: 0.03, expectedRemainingVolume: 0.03,
  };
  const state = { managed };
  const context = vm.createContext({
    state,
    brokerTpSlTrailOnly: true,
    maxHoldingMinutes: 180,
    maxQuoteAgeMs: 30000,
    maxM15AgeMs: 30000,
    FAST_MOVE_PROFIT_LOCK_ACTIVATION_PRICE: 10,
    FAST_MOVE_PROFIT_LOCK_GIVEBACK_PRICE: 10,
    symbol: "XAUUSD",
    regimeCandleCount: 320,
    Date: { now: () => 1000000000 },
    Number, Math,
    journal: (name, data) => events.push({ name, data }),
    saveState: () => {},
    controlGet: async () => { throw new Error("regime API must not be queried after fill"); },
    bridgeRequest: async (method, url, body) => {
      actions.push({ method, url, body });
      if (method === "POST") throw new Error("synthetic broker close prohibited");
      if (method !== "PATCH") throw new Error("unexpected method");
      return { success: true };
    },
    evaluateTimestampFreshness: () => ({ fresh: true }),
    recordManagementExitSideSample: () => {},
    roundPrice: (n, digits) => Number(n.toFixed(digits)),
    stopIsAtLeastAsTight: (side, current, target) => side === "BUY" ? current >= target : current <= target,
    stopStrictlyTightens: (side, prev, next) => side === "BUY" ? next > prev : next < prev,
    tightestKnownStop: (side, ...stops) => side === "BUY" ? Math.max(...stops) : Math.min(...stops),
    fastMoveProfitLockCandidate: ({ entry }) => ({ active: false, peakPrice: entry }),
    canonicalHoldReason: () => null,
  });
  vm.runInContext(managedSource + "\nthis.managePosition = managePosition;", context);
  const position = { ticket: managed.ticket, side: side === "BUY" ? "LONG" : "SHORT", entry: managed.entry, stopLoss: side === "BUY" ? 2490 : 2510, takeProfit: side === "BUY" ? 2520 : 2480, volume: 0.03 };
  const quote = { bid: quoteBid, ask: quoteAsk, timestamp: 1000000000 };
  const spec = { digits: 2, stopsLevelTicks: 0, freezeLevelTicks: 0, point: 0.01, minVolume: 0.01, volumeStep: 0.01 };
  return { context, managed, actions, events, position, quote, spec };
}

test("SIDEWAY entry checks remain unchanged; post-fill mode is locked without environment override", () => {
  const preEntry = source.slice(source.indexOf("async function cycle()"), source.indexOf("function readStrategyEntryConfigSnapshot()"));
  for (const expected of [
    'const permission = resolveSidewayPermission(activeMode, "SIDEWAY")',
    'evaluateStrategyEntryConditions({',
    'minimumRegimeConfidence:',
    'm5Confirmation:',
    'const finalPermission = resolveSidewayPermission(freshMode?.state?.mode, "SIDEWAY")',
    'ENTRY_FINAL_GATE_BLOCK',
    'ENTRY_SUBMIT',
    'stopLoss: executionPlan.stopLoss',
    'takeProfit: brokerTakeProfit',
  ]) assert.ok(preEntry.includes(expected), "entry safeguard not present: " + expected);
  assert.match(source, /const brokerTpSlTrailOnly = true;/);
  assert.doesNotMatch(source, /process\.env\.[A-Z0-9_]*(?:EXIT_POLICY|BROKER_TARGETS_ONLY|BROKER_TP_SL_TRAIL)/);
});

test("newly filled SIDEWAY with expired holding timer cannot be closed by TIME_STOP", async () => {
  const f = syntheticCycle();
  await f.context.managePosition(f.position, f.quote, f.spec);
  assert.deepEqual(f.actions, []);
  assert.equal(f.events.some(e => e.name === "POSITION_CLOSED"), false);
  assert.equal(f.events.some(e => e.name === "SIDEWAY_HOLD_BROKER_TP_SL_TRAIL_ONLY"), true);
});

test("new M15 regime change after fill cannot trigger close or re-query regime", async () => {
  const f = syntheticCycle({ dailyMode: "SIDEWAY_NATIVE" });
  f.managed.lastRegimeCloseChecked = 0;
  await f.context.managePosition(f.position, f.quote, f.spec);
  assert.equal(f.actions.length, 0);
  assert.equal(f.events.some(e => e.name === "MANAGEMENT_REGIME_INVALIDATION"), false);
});

test("even after TP1/TP2 levels, controller does not issue a software close", async () => {
  const f = syntheticCycle({ quoteBid: 2530, quoteAsk: 2530.2 });
  await f.context.managePosition(f.position, f.quote, f.spec);
  assert.equal(f.actions.every(x => x.method === "PATCH" && x.url.includes("/positions/")), true);
  assert.equal(f.actions.some(x => x.method === "POST"), false);
  assert.equal(f.events.some(e => e.name === "PLUS10_PARTIAL_ONE_THIRD"), false);
});

test("after fill, +6 can move SL to entry but never submit CLOSE", async () => {
  const f = syntheticCycle({ quoteBid: 2507, quoteAsk: 2507.2 });
  await f.context.managePosition(f.position, f.quote, f.spec);
  assert.deepEqual(f.actions.map(x => x.method), ["PATCH"]);
  assert.equal(f.actions[0].body.stopLoss, f.managed.entry);
  assert.equal(f.managed.breakEvenApplied, true);
  assert.equal(f.events.some(e => e.name === "PLUS6_SL_TO_ENTRY"), true);
});

test("reported SELL case: +7 favorable points tightens SL to break-even without closing on regime/time", async () => {
  const f = syntheticCycle({ side: "SELL", quoteBid: 2492.7, quoteAsk: 2493 });
  f.managed.lastRegimeCloseChecked = 0;
  await f.context.managePosition(f.position, f.quote, f.spec);
  assert.deepEqual(f.actions.map(x => x.method), ["PATCH"]);
  assert.equal(f.actions[0].body.stopLoss, 2500);
  assert.equal(f.actions[0].url.includes("/positions/"), true);
  assert.equal(f.events.some(e => e.name === "PLUS6_SL_TO_ENTRY"), true);
  assert.equal(f.events.some(e => e.name === "POSITION_CLOSED"), false);
  assert.equal(f.events.some(e => e.name === "SIDEWAY_HOLD_BROKER_TP_SL_TRAIL_ONLY"), true);
});

test("RECOVERY_TP also retains broker TP/SL and allows stop management", async () => {
  const f = syntheticCycle({ dailyMode: "RECOVERY_TP", quoteBid: 2507 });
  await f.context.managePosition(f.position, f.quote, f.spec);
  assert.deepEqual(f.actions.map(x => x.method), ["PATCH"]);
  assert.equal(f.events.some(e => e.name === "SIDEWAY_HOLD_BROKER_TP_SL_TRAIL_ONLY"), true);
});

test("native broker stop/take-profit remain untouched; no false repeated hold alarms", async () => {
  const f = syntheticCycle();
  await f.context.managePosition(f.position, f.quote, f.spec);
  await f.context.managePosition(f.position, f.quote, f.spec);
  assert.deepEqual(f.actions, []);
  assert.equal(f.position.stopLoss, 2490);
  assert.equal(f.position.takeProfit, 2520);
  assert.equal(f.events.filter(x => x.name === "SIDEWAY_HOLD_BROKER_TP_SL_TRAIL_ONLY").length, 1);
});

test("legacy early-close code is inaccessible under forced broker-target policy", () => {
  assert.match(managedSource, /if \(!brokerTpSlTrailOnly\)\s*\{\s*if \(Date\.now\(\) >= managed\.timeStopAt\)/);
  assert.match(managedSource, /if \(!brokerTpSlTrailOnly\)\s*\{\s*if \(managed\.dailyMode === "RECOVERY_TP"\)/);
  assert.match(managedSource, /if \(!brokerTpSlTrailOnly && managed\.breakEvenApplied && !managed\.partialApplied && targetReached\(/);
  assert.ok(managedSource.indexOf('if (!brokerTpSlTrailOnly && managed.breakEvenApplied') < managedSource.indexOf('SIDEWAY_HOLD_BROKER_TP_SL_TRAIL_ONLY'));
  assert.ok(managedSource.indexOf('SIDEWAY_HOLD_BROKER_TP_SL_TRAIL_ONLY') < managedSource.indexOf('if (await closeFixedTpIfTriggered(position, quote)) return;', managedSource.indexOf('SIDEWAY_HOLD_BROKER_TP_SL_TRAIL_ONLY')));
});

test("M5 structural SL adapter inserts stop-tightening before broker-only hold, without requiring partial close", () => {
  const transformed = transformPhase7CSidewayM5TrailingSource(source);
  assert.match(transformed, /managed\.partialApplied \|\| \(typeof brokerTpSlTrailOnly !== "undefined" && brokerTpSlTrailOnly\)/);
  const m5Tighten = transformed.indexOf('journal("SIDEWAY_M5_STRUCTURAL_SL_TIGHTEN"');
  const hold = transformed.indexOf('journal("SIDEWAY_HOLD_BROKER_TP_SL_TRAIL_ONLY"');
  assert.ok(m5Tighten > 0 && hold > m5Tighten,
    "M5 stop-tightening must be reachable before broker-only early return");
  const m5Success = transformed.lastIndexOf("if (response.success)", m5Tighten);
  assert.ok(m5Success > 0 && m5Success < m5Tighten);
  assert.ok(transformed.includes('previousStopLoss: position.stopLoss'));
});

test("M5 same-cycle trailing cannot reverse accepted BUY/SELL break-even moves", () => {
  const transformed = transformPhase7CSidewayM5TrailingSource(source);
  assert.match(
    transformed,
    /managed\.breakEvenApplied \? Number\(managed\.entry\) : 0/,
    "BE floor must be included in M5 trailing's effective known-stop baseline",
  );

  for (const fixture of [
    {
      side: "BUY", staleStop: 2490, entry: 2500,
      bid: 2507, ask: 2507.2, candidate: 2498,
      bars: [
        { low: 2500, high: 2508, closeTime: 1000 },
        { low: 2499, high: 2507, closeTime: 2000 },
        { low: 2502, high: 2510, closeTime: 3000 },
      ],
    },
    {
      side: "SELL", staleStop: 2510, entry: 2500,
      bid: 2492.8, ask: 2493, candidate: 2502,
      bars: [
        { low: 2495, high: 2498, closeTime: 1000 },
        { low: 2494, high: 2501, closeTime: 2000 },
        { low: 2490, high: 2497, closeTime: 3000 },
      ],
    },
  ]) {
    const { side, staleStop, entry, bid, ask, candidate, bars } = fixture;
    const input = {
      side, bars, afterTimestamp: 0, atOrBefore: 3000,
      currentStop: staleStop, bid, ask,
      digits: 2, point: 0.01, stopsLevelTicks: 0, freezeLevelTicks: 0,
    };

    // A stale broker snapshot alone WOULD accept an unsafe rollback.
    const stale = evaluateM5StructuralTrail({
      ...input, lastStructuralStop: tightestKnownStop(side, staleStop),
    });
    assert.equal(stale.stopLoss, candidate);
    assert.equal(stale.allowed, true, side + " demonstrates the same-cycle stale snapshot risk");

    // After BE succeeds, the authoritative floor is the tightened entry.
    const protectedStop = tightestKnownStop(side, staleStop, entry);
    const protectedDecision = evaluateM5StructuralTrail({
      ...input, lastStructuralStop: protectedStop,
    });
    assert.equal(protectedDecision.allowed, false, side + " must never loosen accepted BE");
    assert.equal(protectedDecision.reason, "NOT_STRICTLY_TIGHTER");
    assert.equal(protectedDecision.baseline, entry);
  }
});
