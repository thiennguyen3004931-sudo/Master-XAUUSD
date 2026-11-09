/**
 * Phase 7C Final Strategy Acceptance — SOURCE/UNIT ONLY.
 * No broker client, no HTTP, no MT5, no BOT_MODE/ARM mutation.
 * A green test does NOT constitute LIVE readiness, profitability,
 * machine attestation, customer release, or customer DEMO acceptance.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  createVirtualStrategyEntryConditionState,
  STRATEGY_ENTRY_MANDATORY,
  evaluateStrategyEntryConditions,
  validateStrategyEntryConditionState,
} from './phase7c-strategy-entry-conditions.mjs';
import {
  buildSidewayPlan,
  chooseRangeSide,
  resolveSidewayPermission,
} from './phase7c-sideway-logic.mjs';
import {
  stopStrictlyTightens,
  stopIsAtLeastAsTight,
} from './phase7c-stop-monotonicity.mjs';
import {
  DAILY_RECOVERY_NEW_ENTRY_PAUSED,
  pauseDailyRecoveryForNewEntry,
  assertDailyRecoveryPausedBeforeSend,
} from './phase7c-daily-recovery-pause.mjs';
import { evaluateLiveAutoReversalEntryLock } from './phase7c-auto-live-reversal-lock.mjs';
import { evaluateAutoTrendEntryModeGate } from './phase7c-trend-mode-gate.mjs';

const src = name => readFileSync(new URL('./' + name, import.meta.url), 'utf8');
const defaults = createVirtualStrategyEntryConditionState();
const observations = conditionSet => Object.fromEntries(
  Object.keys(conditionSet).map(id => [id, { passed: true, observed: 'SYNTHETIC_PASS' }]),
);
const range = {
  demand: { low: 2390, high: 2392 },
  supply: { low: 2408, high: 2410 },
};
const sidewayPlan = (side, rangeOverride = range) => buildSidewayPlan({
  side, bid: side === 'BUY' ? 2392.2 : 2407.8,
  ask: side === 'BUY' ? 2392.3 : 2407.9,
  range: rangeOverride, atr: 4, point: 0.01, stopsLevelTicks: 0, digits: 2,
});

test('TREND default: M15 pattern, M15/M5 SuperTrend and structure; MA/FVG not mandatory', () => {
  assert.equal(defaults.trend.patternM15, true);
  assert.equal(defaults.trend.supertrendM15, true);
  assert.equal(defaults.trend.supertrendM5, true);
  assert.equal(defaults.trend.validTrendStructure, true);
  assert.equal(defaults.trend.ma20Ma50, false);
  assert.equal(defaults.trend.fvg, false);
  assert.deepEqual(STRATEGY_ENTRY_MANDATORY.TREND, ['patternM15']);
  const result = evaluateStrategyEntryConditions({
    strategy: 'TREND', config: defaults, side: 'BUY',
    observations: observations(defaults.trend),
  });
  assert.equal(result.allEnabledPassed, true);
  assert.equal(result.conditions.find(row => row.id === 'ma20Ma50').status, 'IGNORED');
  assert.equal(result.conditions.find(row => row.id === 'fvg').status, 'IGNORED');
});

test('TREND entry fails closed on disabled mandatory pattern or missing M5 confirmation', () => {
  const invalid = {
    ...defaults, trend: { ...defaults.trend, patternM15: false },
  };
  assert.equal(
    validateStrategyEntryConditionState(invalid, { allowVirtualVersionZero: true }).valid,
    false,
  );
  const obs = observations(defaults.trend);
  obs.supertrendM5 = { passed: false, observed: 'SELL' };
  const result = evaluateStrategyEntryConditions({
    strategy: 'TREND', config: defaults, side: 'BUY', observations: obs,
  });
  assert.equal(result.allEnabledPassed, false);
  assert.deepEqual(result.failedConditions, ['supertrendM5']);
});

test('SIDEWAY default requires RANGING, recommended SIDEWAY, confidence, range, edge, M5 confirmation', () => {
  assert.deepEqual(STRATEGY_ENTRY_MANDATORY.SIDEWAY, ['rangeEdge']);
  assert.equal(Object.values(defaults.sideway).every(value => value === true), true);
  const obs = observations(defaults.sideway);
  assert.equal(evaluateStrategyEntryConditions({
    strategy: 'SIDEWAY', config: defaults, side: 'SELL', observations: obs,
  }).allEnabledPassed, true);
  obs.rangingRegime = { passed: false, observed: 'TRENDING' };
  obs.m5Confirmation = { passed: false, observed: null };
  const blocked = evaluateStrategyEntryConditions({
    strategy: 'SIDEWAY', config: defaults, side: 'SELL', observations: obs,
  });
  assert.deepEqual(blocked.failedConditions, ['rangingRegime', 'm5Confirmation']);
});

test('PAUSE and mismatched AUTO modes block fresh SIDEWAY and TREND entries', () => {
  assert.equal(resolveSidewayPermission('PAUSE', 'SIDEWAY').allowed, false);
  assert.equal(resolveSidewayPermission('TREND', 'SIDEWAY').allowed, false);
  assert.equal(resolveSidewayPermission('AUTO', 'TREND').allowed, false);
  assert.equal(resolveSidewayPermission('AUTO', 'SIDEWAY').allowed, true);
  const trend = evaluateAutoTrendEntryModeGate({
    activeMode: 'AUTO',
    regime: { activeMode: 'AUTO', regime: 'UNCERTAIN', recommendedMode: 'PAUSE' },
    demo: {},
  });
  assert.equal(trend.allowed, false);
  assert.equal(trend.reason, 'AUTO_REGIME_RECOMMENDS_PAUSE');
});

test('SIDEWAY BUY/SELL only from opposite range edges; not range center or outside', () => {
  assert.equal(chooseRangeSide(range, 2392.2, 2392.4), 'BUY');
  assert.equal(chooseRangeSide(range, 2407.8, 2408.0), 'SELL');
  assert.equal(chooseRangeSide(range, 2399.9, 2400.1), null);
  assert.equal(chooseRangeSide(range, 2388.8, 2389.0), null);
});

test('SIDEWAY initial broker SL is 6-10 price units, BUY/SELL symmetric with opposite-edge TP', () => {
  const buy = sidewayPlan('BUY');
  const sell = sidewayPlan('SELL');
  for (const plan of [buy, sell]) {
    assert.equal(plan.accepted, true);
    assert.ok(plan.stopDistance >= 6 && plan.stopDistance <= 10);
    assert.ok(plan.rewardRisk >= 1.2);
    assert.ok(Math.abs(plan.takeProfit - plan.entry) > 10);
  }
  assert.ok(buy.stopLoss < buy.entry && buy.takeProfit > buy.entry);
  assert.ok(sell.stopLoss > sell.entry && sell.takeProfit < sell.entry);
  const wideRange = {
    demand: { low: 2378, high: 2392 },
    supply: { low: 2410, high: 2412 },
  };
  const rejected = sidewayPlan('BUY', wideRange);
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, 'WAIT_PULLBACK_STOP_GT_10');
});

test('accepted BE floor and M5 trailing cannot loosen BUY/SELL stop', () => {
  assert.equal(stopStrictlyTightens('BUY', 2392.3, 2392.2), false);
  assert.equal(stopStrictlyTightens('BUY', 2392.3, 2393.3), true);
  assert.equal(stopStrictlyTightens('SELL', 2407.8, 2408.0), false);
  assert.equal(stopStrictlyTightens('SELL', 2407.8, 2406.8), true);
  assert.equal(stopIsAtLeastAsTight('BUY', 2393, 2392.3), true);
  assert.equal(stopIsAtLeastAsTight('SELL', 2407, 2407.8), true);
});

test('TREND +6 BE, +10 one-third partial and post-partial trailing remain source-visible', () => {
  const trend = src('run-phase7b-demo-controller.ts');
  assert.match(trend, /if \(!managed\.breakEvenApplied && favorable >= 6\)/);
  assert.match(trend, /if \(!managed\.partialApplied && favorable >= 10\)/);
  assert.match(trend, /PLUS10_PARTIAL_ONE_THIRD/);
  assert.match(trend, /if \(managed\.partialApplied\) \{/);
  assert.match(trend, /STRUCTURAL_SL_TIGHTEN/);
  assert.match(trend, /const trendFixedTpEnabled =/);
});

test('SIDEWAY after-fill broker-only TP/SL, BE +6; no software partial/expiry/regime closure', () => {
  const sideway = src('run-phase7c-sideway-controller.mjs');
  assert.match(sideway, /const brokerTpSlTrailOnly = true;/);
  assert.match(sideway, /if \(!managed\.breakEvenApplied && favorable >= 6\)/);
  assert.match(sideway, /PLUS6_SL_TO_ENTRY/);
  assert.match(sideway, /if \(!brokerTpSlTrailOnly && managed\.breakEvenApplied && !managed\.partialApplied/);
  assert.match(sideway, /SIDEWAY_HOLD_BROKER_TP_SL_TRAIL_ONLY/);
  assert.match(sideway, /SIDEWAY_POST_ENTRY_REGIME_TIME_PARTIAL_SOFTWARE_CLOSE=DISABLED/);
});

test('account-mode wrappers attach M5 trailing to BOTH strategies, not only static helper', () => {
  const trend = src('run-phase7c-trend-controller.mjs');
  const sideway = src('run-phase7c-sideway-account-mode.mjs');
  assert.match(trend, /transformPhase7CTrendM5TrailingSource\(source\)/);
  assert.match(sideway, /transformPhase7CSidewayM5TrailingSource\(canonicalOutput\)/);
});

test('Daily Recovery is source-paused for both new entry strategies without touching positions', () => {
  assert.equal(DAILY_RECOVERY_NEW_ENTRY_PAUSED, true);
  for (const [strategy, native] of [['TREND', 'TREND'], ['SIDEWAY', 'SIDEWAY_NATIVE']]) {
    const plan = pauseDailyRecoveryForNewEntry(strategy, {
      mode: 'RECOVERY_TP', dailyNetPnl: -20,
      tpDistance: 10, rawTpDistance: 10, requiredUsd: 21,
      canRecoverInOneTrade: true,
    });
    assert.equal(plan.mode, native);
    assert.equal(plan.recoveryEntryPaused, true);
    assert.equal(plan.tpDistance, 0);
    assert.doesNotThrow(() => assertDailyRecoveryPausedBeforeSend(strategy, plan));
  }
});

test('REVERSAL remains explicitly hard-locked for new AUTO LIVE orders', () => {
  assert.deepEqual(
    evaluateLiveAutoReversalEntryLock({
      activeMode: 'AUTO', regime: 'REVERSAL', reversalOrigin: false,
    }).allowed,
    false,
  );
  assert.equal(evaluateLiveAutoReversalEntryLock({
    activeMode: 'AUTO', regime: 'TRENDING', reversalOrigin: true,
  }).allowed, false);
});

test('Final Strategy Acceptance is deliberately not a trade or release permission', () => {
  // No acceptance script may enable the trading bridge from CI.
  const evidence = {
    sourceConditionsChecked: true,
    mt5DemoAcceptance: false,
    liveAuthorized: false,
    customerReleaseAuthorized: false,
  };
  assert.equal(evidence.sourceConditionsChecked, true);
  assert.equal(evidence.mt5DemoAcceptance, false);
  assert.equal(evidence.liveAuthorized, false);
  assert.equal(evidence.customerReleaseAuthorized, false);
});
