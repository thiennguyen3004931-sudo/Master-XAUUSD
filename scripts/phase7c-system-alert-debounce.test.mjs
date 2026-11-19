import assert from "node:assert/strict";
import {
  DEFAULT_TRANSIENT_MT5_READ_ALERT_THRESHOLD,
  DEFAULT_TRANSIENT_MT5_READ_ALERT_WINDOW_MS,
  evaluateTransientSystemAlertDebounce,
  isMt5CycleErrorEvent,
  isTransientMt5ReadTimeoutEvent,
} from "./phase7c-system-alert-debounce.mjs";

const event = (message) => ({
  type: "CYCLE_ERROR",
  message,
});

assert.equal(DEFAULT_TRANSIENT_MT5_READ_ALERT_THRESHOLD, 3);
assert.equal(DEFAULT_TRANSIENT_MT5_READ_ALERT_WINDOW_MS, 60_000);

assert.equal(
  isMt5CycleErrorEvent(
    event("MT5 bridge GET /v1/candles/XAUUSD?timeframe=M15 | timeout=8000ms | attempts=2"),
  ),
  true,
);
assert.equal(
  isMt5CycleErrorEvent(
    event("MT5 bridge is not healthy/connected."),
  ),
  true,
);
assert.equal(
  isMt5CycleErrorEvent(
    event("readPhase7CReversalEntryContext is not defined"),
  ),
  false,
  "JavaScript/runtime errors must not be classified as MT5 cycle errors.",
);

assert.equal(
  isTransientMt5ReadTimeoutEvent(
    event("MT5 bridge GET /v1/symbols/XAUUSD/spec | timeout=8000ms | attempts=1"),
  ),
  true,
);
assert.equal(
  isTransientMt5ReadTimeoutEvent(
    event("MT5 bridge GET /health | timeout=8000ms | attempts=1"),
  ),
  true,
);
assert.equal(
  isTransientMt5ReadTimeoutEvent(
    event("MT5 bridge GET /health | timeout=8000ms | attempts=2"),
  ),
  false,
  "Exhausted safe GET retries remain immediately alertable.",
);
assert.equal(
  isTransientMt5ReadTimeoutEvent(
    event("MT5 bridge PATCH /v1/positions/1 | timeout=8000ms | attempts=1"),
  ),
  false,
  "Mutation-path timeouts must never be suppressed.",
);

const t0 = Date.parse("2026-09-24T00:00:00.000Z");

const first = evaluateTransientSystemAlertDebounce({
  event: event("MT5 bridge GET /health | timeout=8000ms | attempts=1"),
  current: null,
  nowMs: t0,
});
assert.equal(first.matched, true);
assert.equal(first.suppress, true);
assert.equal(first.count, 1);
assert.equal(first.next.active, false);

const second = evaluateTransientSystemAlertDebounce({
  event: event("MT5 bridge GET /v1/symbols/XAUUSD/spec | timeout=8000ms | attempts=1"),
  current: first.next,
  nowMs: t0 + 5_000,
});
assert.equal(second.suppress, true);
assert.equal(second.count, 2);

const third = evaluateTransientSystemAlertDebounce({
  event: event("MT5 bridge GET /v1/candles/XAUUSD?timeframe=M15&count=320 | timeout=8000ms | attempts=1"),
  current: second.next,
  nowMs: t0 + 10_000,
});
assert.equal(third.suppress, false);
assert.equal(third.count, 3);
assert.equal(
  third.next.pendingKind,
  "MT5_READ_TIMEOUT",
  "Different read-only endpoints must share one persistent-timeout debounce bucket.",
);

const reset = evaluateTransientSystemAlertDebounce({
  event: event("MT5 bridge GET /health | timeout=8000ms | attempts=1"),
  current: third.next,
  nowMs: t0 + 70_001,
});
assert.equal(reset.suppress, true);
assert.equal(reset.count, 1);

const persistentFast = evaluateTransientSystemAlertDebounce({
  event: event("MT5 bridge GET /health | timeout=8000ms | attempts=1"),
  current: second.next,
  nowMs: t0 + 6_000,
  threshold: 2,
});
assert.equal(persistentFast.suppress, false);
assert.equal(persistentFast.count, 3);

const nonTransient = evaluateTransientSystemAlertDebounce({
  event: event("MT5 bridge GET /health | transport=fetch failed | attempts=2"),
  current: second.next,
  nowMs: t0 + 7_000,
});
assert.equal(nonTransient.matched, false);
assert.equal(nonTransient.suppress, false);

console.log("SYSTEM_ALERT_TRANSIENT_MT5_READ_CLASSIFICATION=PASS");
console.log("SYSTEM_ALERT_TRANSIENT_MT5_READ_FIRST_TWO_SUPPRESSED=PASS");
console.log("SYSTEM_ALERT_TRANSIENT_MT5_READ_THIRD_ALERTS=PASS");
console.log("SYSTEM_ALERT_MUTATION_TIMEOUT_IMMEDIATE=PASS");
console.log("SYSTEM_ALERT_EXHAUSTED_GET_RETRY_IMMEDIATE=PASS");
console.log("SYSTEM_ALERT_DEBOUNCE_WINDOW_RESET=PASS");

console.log("SYSTEM_ALERT_RUNTIME_ERROR_NOT_MT5_CLASSIFICATION=PASS");
