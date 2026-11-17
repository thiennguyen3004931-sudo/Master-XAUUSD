import assert from "node:assert/strict";
import test from "node:test";
import { assessReversalTrendFilter } from "../apps/api/src/services/phase7c-reversal-trend-filter.ts";

const STEP = 15 * 60_000;
const NOW = Date.UTC(2026, 9, 29, 12, 0, 0, 0);
function trendBars(size = 320, step = 0.2) {
  const start = NOW - size * STEP;
  return Array.from({ length: size }, (_, i) => ({
    openTime: start + i * STEP,
    closeTime: start + (i + 1) * STEP,
    close: 1500 + i * step,
  }));
}
test("closed M15 higher timeframes confirm aligned BUY only as SHADOW", () => {
  const evidence = assessReversalTrendFilter(trendBars(), "BUY", NOW);
  assert.equal(evidence.status, "CONFIRMED_H1_H4");
  assert.equal(evidence.shadowEligible, true);
  assert.equal(evidence.liveEntryPermission, false);
  assert.equal(evidence.tradingMutation, false);
  assert.equal(evidence.h1.direction, "BUY");
  assert.equal(evidence.h4.direction, "BUY");
});
test("H1/H4 reject countertrend REVERSAL signal without granting LIVE", () => {
  const x = assessReversalTrendFilter(trendBars(), "SELL", NOW);
  assert.equal(x.status, "COUNTER_TREND");
  assert.equal(x.shadowEligible, false);
  assert.equal(x.liveEntryPermission, false);
});
test("matching sell trend may be observed but never authorizes orders", () => {
  const x = assessReversalTrendFilter(trendBars(320, -0.2), "SELL", NOW);
  assert.equal(x.status, "CONFIRMED_H1_H4");
  assert.equal(x.liveEntryPermission, false);
});
test("missing or stale higher timeframe data fails closed", () => {
  const few = assessReversalTrendFilter(trendBars(100), "BUY", NOW);
  assert.equal(few.status, "INSUFFICIENT_OR_STALE_DATA");
  const stale = assessReversalTrendFilter(trendBars(), "BUY", NOW + 3 * 24 * 60 * 60_000);
  assert.equal(stale.status, "INSUFFICIENT_OR_STALE_DATA");
});
test("ignores future/incomplete M15 candles and does not look ahead", () => {
  const bars = trendBars();
  const baseline = assessReversalTrendFilter(bars, "BUY", NOW);
  const future = [...bars, { openTime: NOW, closeTime: NOW + STEP, close: 9999 }];
  const newEvidence = assessReversalTrendFilter(future, "BUY", NOW);
  assert.deepEqual(newEvidence, baseline);
});
test("does not create permissions for missing reversal context", () => {
  const x = assessReversalTrendFilter(trendBars(), null, NOW);
  assert.equal(x.status, "NO_REVERSAL_SIGNAL");
  assert.equal(x.shadowEligible, false);
  assert.equal(x.liveEntryPermission, false);
});
