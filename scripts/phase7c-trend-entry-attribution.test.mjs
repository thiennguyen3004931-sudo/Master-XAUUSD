import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildTrendEntryAttribution,
  recordTrendEntryAttributionBestEffort,
} from "./phase7c-trend-entry-attribution.mjs";
import { __test as decisionAuditTest } from "./phase7c-decision-audit.mjs";

const wrapperSource = readFileSync(
  new URL("./run-phase7c-trend-controller.mjs", import.meta.url),
  "utf8",
);

test("builds final Trend attribution from the exact allowed decision and existing JSON order body", () => {
  const payload = buildTrendEntryAttribution({
    decision: {
      allowed: true,
      activeMode: "AUTO",
      recommendedMode: "TREND",
      regime: "BREAKOUT",
      regimeConfidence: 0.87,
      reason: "AUTO_REGIME_ALLOWS_TREND",
    },
    requestBody: JSON.stringify({
      clientOrderId: "p7b-pb-123-SELL",
      idempotencyKey: "p7b-pb-123-SELL",
      side: "SELL",
      volume: 0.12,
      stopLoss: 3512.4,
      takeProfit: 3492.4,
    }),
  });

  assert.equal(payload.activeMode, "AUTO");
  assert.equal(payload.recommendedMode, "TREND");
  assert.equal(payload.regime, "BREAKOUT");
  assert.equal(payload.regimeConfidence, 0.87);
  assert.equal(payload.permissionReason, "AUTO_REGIME_ALLOWS_TREND");
  assert.equal(payload.regimeSnapshotSource, "FINAL_TREND_ORDER_GATE");
  assert.equal(payload.clientOrderId, "p7b-pb-123-SELL");
  assert.equal(payload.idempotencyKey, "p7b-pb-123-SELL");
  assert.equal(payload.side, "SELL");
  assert.equal(payload.volume, 0.12);
  assert.equal(payload.stopLoss, 3512.4);
  assert.equal(payload.takeProfit, 3492.4);
});

test("manual TREND permission never fabricates a regime snapshot", () => {
  const payload = buildTrendEntryAttribution({
    decision: {
      allowed: true,
      activeMode: "TREND",
      recommendedMode: null,
      reason: "MANUAL_TREND_MODE",
    },
    requestBody: JSON.stringify({
      clientOrderId: "manual-trend",
      side: "BUY",
      volume: 0.12,
    }),
  });

  assert.equal(payload.activeMode, "TREND");
  assert.equal(payload.regime, null);
  assert.equal(payload.regimeConfidence, null);
});

test("invalid or unavailable request body does not invent order identity", () => {
  const payload = buildTrendEntryAttribution({
    decision: {
      allowed: true,
      activeMode: "AUTO",
      recommendedMode: "TREND",
      regime: "TRENDING",
      regimeConfidence: 0.78,
      reason: "AUTO_REGIME_ALLOWS_TREND",
    },
    requestBody: "not-json",
  });

  assert.equal(payload.regime, "TRENDING");
  assert.equal(payload.clientOrderId, null);
  assert.equal(payload.idempotencyKey, null);
  assert.equal(payload.side, null);
  assert.equal(payload.volume, null);
});

test("audit persistence failure is observability-only and never throws into order authorization", () => {
  const warnings = [];
  const result = recordTrendEntryAttributionBestEffort({
    audit: {
      record() {
        throw new Error("disk unavailable");
      },
    },
    decision: {
      allowed: true,
      activeMode: "AUTO",
      recommendedMode: "TREND",
      regime: "BREAKOUT",
      regimeConfidence: 0.9,
      reason: "AUTO_REGIME_ALLOWS_TREND",
    },
    requestBody: "{}",
    warn: (message) => warnings.push(message),
  });

  assert.equal(result.recorded, false);
  assert.match(result.error, /disk unavailable/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /TREND_ENTRY_ATTRIBUTION_AUDIT_FAILED/);
});

test("new final-permission event normalizes as READY and exposes regime fields", () => {
  const record = decisionAuditTest.normalizeRecord(
    "TREND",
    "XAUUSD",
    {},
    "ENTRY_FINAL_PERMISSION_GRANTED",
    {
      activeMode: "AUTO",
      recommendedMode: "TREND",
      regime: "BREAKOUT",
      regimeConfidence: 0.91,
      side: "SELL",
      volume: 0.12,
    },
  );

  assert.equal(record.stage, "READY");
  assert.equal(record.setup.activeMode, "AUTO");
  assert.equal(record.setup.recommendedMode, "TREND");
  assert.equal(record.setup.regime, "BREAKOUT");
  assert.equal(record.setup.confidence, 0.91);
});

test("wrapper records final attribution after lock recheck and immediately before forwarding without a second regime request", () => {
  assert.match(
    wrapperSource,
    /import\s+\{[^}]*createPhase7CDecisionAudit[^}]*\}\s+from\s+"\.\/phase7c-decision-audit\.mjs"/s,
  );
  assert.match(
    wrapperSource,
    /import\s+\{[^}]*recordTrendEntryAttributionBestEffort[^}]*\}\s+from\s+"\.\/phase7c-trend-entry-attribution\.mjs"/s,
  );
  assert.match(wrapperSource, /strategy:\s*"TREND"/);
  assert.match(wrapperSource, /body:\s*typeof init\?\.body === "string" \? init\.body : null/);

  const positionRecheckIndex = wrapperSource.indexOf("if (positions.length > 0) {");
  const attributionIndex = wrapperSource.indexOf("recordTrendEntryAttributionBestEffort({");
  const forwardIndex = wrapperSource.indexOf("return await nativeFetch(input, init);");

  assert.ok(positionRecheckIndex >= 0);
  assert.ok(attributionIndex > positionRecheckIndex);
  assert.ok(forwardIndex > attributionIndex);

  const regimeRequestOccurrences = wrapperSource.match(/\/api\/v1\/phase7c\/live-regime/g) ?? [];
  assert.equal(regimeRequestOccurrences.length, 1);
});
