import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createPhase7CDecisionAudit } from "./phase7c-decision-audit.mjs";

mkdirSync(tmpdir(), { recursive: true });

test("decision audit writes a normalized Sideway pre-trade snapshot", () => {
  const root = mkdtempSync(path.join(tmpdir(), "phase7c-decision-audit-"));
  try {
    const audit = createPhase7CDecisionAudit({
      strategy: "SIDEWAY",
      directory: root,
      configuration: { riskPercent: 1, maxLot: 0.3 },
    });
    const record = audit.record("ENTRY_SUBMIT", {
      timestamp: 1_776_000_000_000,
      side: "BUY",
      volume: 0.12,
      rawLot: 0.187,
      estimatedRiskUsd: 81,
      estimatedRiskPercent: 0.81,
      lotLimitReason: "Clamped to one-third-compatible lot.",
      plan: { entry: 2500, stopLoss: 2494, stopDistance: 6, tp1: 2510, takeProfit: 2520 },
    });

    assert.equal(record.stage, "SUBMITTED");
    assert.equal(record.sizing.rawLot, 0.187);
    assert.equal(record.sizing.finalLot, 0.12);
    assert.equal(record.sizing.maxLot, 0.3);
    assert.equal(record.plan.breakEvenTriggerDistance, 6);
    assert.equal(record.plan.partialFraction, "1/3");
    assert.equal(record.plan.tp2, 2520);

    const latest = JSON.parse(readFileSync(audit.latestPath, "utf8"));
    assert.equal(latest.event, "ENTRY_SUBMIT");
    assert.equal(readFileSync(audit.journalPath, "utf8").trim().split(/\r?\n/).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("decision audit preserves an explicit block reason", () => {
  const root = mkdtempSync(path.join(tmpdir(), "phase7c-decision-block-"));
  try {
    const audit = createPhase7CDecisionAudit({ strategy: "TREND", directory: root });
    const record = audit.record("ENTRY_MODE_BLOCK", {
      activeMode: "PAUSE",
      reason: "PAUSE_MODE_BLOCKS_NEW_ENTRY",
    });
    assert.equal(record.stage, "BLOCKED");
    assert.match(record.reason, /PAUSE_MODE_BLOCKS_NEW_ENTRY/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
