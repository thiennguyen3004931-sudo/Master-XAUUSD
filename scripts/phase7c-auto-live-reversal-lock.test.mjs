import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { evaluateLiveAutoReversalEntryLock } from "./phase7c-auto-live-reversal-lock.mjs";

test("LIVE AUTO reversal regime denies even a mislabelled/new normal order", () => {
  for (const reversalOrigin of [true, false, undefined]) {
    const result = evaluateLiveAutoReversalEntryLock({ activeMode: "AUTO", regime: "REVERSAL", reversalOrigin });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "LIVE_AUTO_REVERSAL_ENTRY_LOCKED");
  }
});

test("LIVE AUTO stale reversal origin denies after regime changes", () => {
  for (const regime of ["TRENDING", "BREAKOUT", "UNCERTAIN", null]) {
    assert.equal(evaluateLiveAutoReversalEntryLock({ activeMode: "AUTO", regime, reversalOrigin: true }).allowed, false);
  }
});

test("normal AUTO TRENDING/BREAKOUT path remains available", () => {
  for (const regime of ["TRENDING", "BREAKOUT"]) {
    assert.equal(evaluateLiveAutoReversalEntryLock({ activeMode: "AUTO", regime, reversalOrigin: false }).allowed, true);
  }
});

test("manual-mode policy remains under existing mode guards", () => {
  for (const activeMode of ["PAUSE", "TREND", "SIDEWAY", "SEMI"]) {
    assert.equal(evaluateLiveAutoReversalEntryLock({ activeMode, regime: "REVERSAL", reversalOrigin: false }).allowed, true);
  }
});

test("LIVE order wrapper invokes hard lock AFTER authoritative regime reload, BEFORE AUTO gate", () => {
  const src = readFileSync(new URL("./run-phase7c-trend-controller.mjs", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("async function evaluateTrendEntryPermission("), src.indexOf("\nfunction reversalOrderGateDiagnostics("));
  assert.match(src, /import \{ evaluateLiveAutoReversalEntryLock \} from "\.\/phase7c-auto-live-reversal-lock\.mjs";/);
  const regime = fn.indexOf('const finalRegime = String(regime?.regime ?? "").toUpperCase();');
  const lock = fn.indexOf("evaluateLiveAutoReversalEntryLock({");
  const normalGate = fn.indexOf("return evaluateAutoTrendEntryModeGate({");
  assert.ok(regime >= 0 && lock > regime && normalGate > lock);
  assert.match(fn, /if \(!liveReversalLock\.allowed\) \{/);
  assert.match(fn, /reason: liveReversalLock\.reason/);
  assert.match(src, /PHASE7C_GATE_SCOPE=POST_\/v1\/orders_ONLY/);
});
