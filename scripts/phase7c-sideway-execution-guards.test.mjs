import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  evaluateTimestampFreshness,
  inferBrokerClockOffset,
  normalizeBrokerTimestamp,
  validateAutoLotSnapshot,
} from "./phase7c-sideway-execution-guards.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const sidewayControllerSource = fs.readFileSync(
  path.join(scriptsDir, "run-phase7c-sideway-controller.mjs"),
  "utf8",
);

test("timestamp freshness blocks stale and future snapshots", () => {
  const now = 1_700_000_000_000;
  assert.equal(evaluateTimestampFreshness(now - 5_000, { now, maxAgeMs: 10_000 }).fresh, true);
  assert.equal(evaluateTimestampFreshness(now - 20_000, { now, maxAgeMs: 10_000 }).reason, "TIMESTAMP_STALE");
  assert.equal(evaluateTimestampFreshness(now + 20_000, { now, maxAgeMs: 10_000 }).reason, "TIMESTAMP_TOO_FAR_IN_FUTURE");
});

test("DBG-style whole-hour broker clock offset normalizes quote and candle freshness", () => {
  const now = 1_700_000_000_000;
  const threeHours = 3 * 60 * 60_000;
  const brokerQuote = now + threeHours - 1_500;
  const offset = inferBrokerClockOffset(brokerQuote, { systemTimestamp: now });

  assert.equal(offset, threeHours);
  assert.equal(normalizeBrokerTimestamp(brokerQuote, offset), now - 1_500);

  const quoteFreshness = evaluateTimestampFreshness(brokerQuote, {
    now,
    maxAgeMs: 30_000,
    clockOffsetMs: offset,
  });
  assert.equal(quoteFreshness.fresh, true);
  assert.equal(quoteFreshness.clockOffsetMs, threeHours);
  assert.equal(quoteFreshness.ageMs, 1_500);
  assert.equal(quoteFreshness.rawAgeMs, -threeHours + 1_500);

  const latestM15Close = now + threeHours - 5 * 60_000;
  const candleFreshness = evaluateTimestampFreshness(latestM15Close, {
    now,
    maxAgeMs: 30 * 60_000,
    clockOffsetMs: offset,
  });
  assert.equal(candleFreshness.fresh, true);
  assert.equal(candleFreshness.clockOffsetMs, threeHours);
  assert.equal(candleFreshness.ageMs, 5 * 60_000);
});

test("broker clock inference fails closed on non-hour or excessive skew", () => {
  const now = 1_700_000_000_000;
  assert.equal(inferBrokerClockOffset(now + 37 * 60_000, { systemTimestamp: now }), null);
  assert.equal(inferBrokerClockOffset(now + 15 * 60 * 60_000, { systemTimestamp: now }), null);
});

function validPayload(now = 1_700_000_000_000) {
  return {
    generatedAt: now - 500,
    safety: {
      mode: "AUTO_LOT_SHADOW",
      executionMutation: false,
      phase7bFixedVolumeUnchanged: true,
    },
    account: {
      login: 123456,
      mode: "demo",
    },
    broker: {
      symbol: "XAUUSDm",
    },
    configuration: {
      riskPercent: 0.25,
      maxLot: 0.03,
    },
    preview: {
      stopDistance: 4.25,
      recommendedLot: 0.03,
      estimatedRiskUsd: 12.75,
      approved: true,
    },
  };
}

test("auto lot snapshot must match the same demo account, broker, risk and stop", () => {
  const now = 1_700_000_000_000;
  const expected = {
    accountLogin: 123456,
    accountMode: "demo",
    brokerSymbol: "XAUUSDm",
    riskPercent: 0.25,
    maxLot: 0.03,
    stopDistance: 4.25,
    now,
    maxAgeMs: 10_000,
  };

  const accepted = validateAutoLotSnapshot(validPayload(now), expected);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.recommendedLot, 0.03);

  assert.equal(validateAutoLotSnapshot({ ...validPayload(now), account: { login: 999999, mode: "demo" } }, expected).reason, "AUTO_LOT_ACCOUNT_LOGIN_MISMATCH");
  assert.equal(
    validateAutoLotSnapshot({ ...validPayload(now), account: { login: 123456, mode: "real" } }, expected).reason,
    "AUTO_LOT_ACCOUNT_MODE_MISMATCH",
  );
  assert.equal(validateAutoLotSnapshot({ ...validPayload(now), broker: { symbol: "XAUUSD.pro" } }, expected).reason, "AUTO_LOT_BROKER_SYMBOL_MISMATCH");
  assert.equal(validateAutoLotSnapshot({ ...validPayload(now), configuration: { riskPercent: 0.5, maxLot: 0.03 } }, expected).reason, "AUTO_LOT_RISK_PERCENT_MISMATCH");
  assert.equal(validateAutoLotSnapshot({ ...validPayload(now), preview: { ...validPayload(now).preview, stopDistance: 5 } }, expected).reason, "AUTO_LOT_STOP_DISTANCE_MISMATCH");
});

test("auto lot snapshot accepts LIVE only when preview account mode matches the active LIVE controller", () => {
  const now = 1_700_000_000_000;
  const payload = {
    ...validPayload(now),
    account: {
      login: 123456,
      mode: "real",
    },
  };
  const expected = {
    accountLogin: 123456,
    accountMode: "real",
    brokerSymbol: "XAUUSDm",
    riskPercent: 0.25,
    maxLot: 0.03,
    stopDistance: 4.25,
    now,
    maxAgeMs: 10_000,
  };

  const accepted = validateAutoLotSnapshot(payload, expected);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.recommendedLot, 0.03);

  assert.equal(
    validateAutoLotSnapshot({ ...payload, account: { login: 123456, mode: "demo" } }, expected).reason,
    "AUTO_LOT_ACCOUNT_MODE_MISMATCH",
  );
});

test("auto lot snapshot fails closed on stale or unsafe payloads", () => {
  const now = 1_700_000_000_000;
  const expected = {
    accountLogin: 123456,
    accountMode: "demo",
    brokerSymbol: "XAUUSDm",
    riskPercent: 0.25,
    maxLot: 0.03,
    stopDistance: 4.25,
    now,
    maxAgeMs: 10_000,
  };

  const stale = validPayload(now);
  stale.generatedAt = now - 20_000;
  assert.equal(validateAutoLotSnapshot(stale, expected).reason, "AUTO_LOT_TIMESTAMP_STALE");

  const unsafe = validPayload(now);
  unsafe.safety.executionMutation = true;
  assert.equal(validateAutoLotSnapshot(unsafe, expected).reason, "AUTO_LOT_SAFETY_ASSERTION_FAILED");

  const unapproved = validPayload(now);
  unapproved.preview.approved = false;
  assert.equal(validateAutoLotSnapshot(unapproved, expected).reason, "AUTO_LOT_PREVIEW_NOT_APPROVED");
});

test("Sideway +10 partial is locked OFF after fill; +6 BE still uses canonical event names", () => {
  const plus6Index = sidewayControllerSource.indexOf(
    'if (!managed.breakEvenApplied && favorable >= 6)',
  );
  const plus10Index = sidewayControllerSource.indexOf(
    'if (!brokerTpSlTrailOnly && managed.breakEvenApplied && !managed.partialApplied && targetReached(managed.side, marketPrice, managed.tp1))',
  );

  assert.ok(plus6Index >= 0, "Sideway +6 BE block must exist");
  assert.ok(
    plus10Index > plus6Index,
    "the legacy partial must be policy-disabled and must never precede break-even",
  );
  assert.match(
    sidewayControllerSource,
    /journal\("PLUS6_SL_TO_ENTRY"/,
    "Sideway +6 success must use the canonical PLUS6_SL_TO_ENTRY event",
  );
  assert.match(
    sidewayControllerSource,
    /journal\("PLUS6_SL_REJECTED"/,
    "Sideway +6 rejection must use the canonical PLUS6_SL_REJECTED event",
  );
  assert.doesNotMatch(
    sidewayControllerSource,
    /PLUS6_BREAK_EVEN_(?:APPLIED|REJECTED)/,
    "legacy Sideway +6 event names must not remain in the controller",
  );
});
