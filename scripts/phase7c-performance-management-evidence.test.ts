import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPhase7CManagementEvidence } from "../apps/api/src/services/phase7c-performance-management-evidence.service";

function writeJsonl(file: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "p3-management-evidence-"));
try {
  const trendJournal = path.join(root, "phase7b-live-forward", "phase7b-demo-events.jsonl");
  writeJsonl(trendJournal, [
    { timestamp: new Date(1_100).toISOString(), type: "PLUS6_SL_TO_ENTRY", ticket: "101", stopLoss: 4300, favorable: 6.25 },
    { timestamp: new Date(1_200).toISOString(), type: "FAST_MOVE_PROFIT_LOCK_TIGHTEN", ticket: "101", peakPrice: 4310, stopLoss: 4304 },
    { timestamp: new Date(1_300).toISOString(), type: "FAST_MOVE_HANDOFF_M5_STRUCTURE", ticket: "101", structurePrice: 4308 },
    { timestamp: new Date(2_100).toISOString(), type: "FAST_MOVE_PROFIT_LOCK_TIGHTEN", ticket: "101", peakPrice: 4316, stopLoss: 4310 },
    { timestamp: new Date(1_250).toISOString(), type: "FAST_MOVE_PROFIT_LOCK_TIGHTEN", ticket: "999", peakPrice: 4312, stopLoss: 4306 },
    { timestamp: new Date(1_260).toISOString(), type: "HOLD_CONFIRMED", reason: "no explicit ticket" },
  ]);

  const trend = getPhase7CManagementEvidence({
    runtimeRoot: root,
    accountMode: "LIVE",
    strategy: "TREND",
    positionId: "101",
    openedAt: 1_000,
    closedAt: 2_000,
  });

  assert.equal(trend.evidence, "EXACT");
  assert.deepEqual(
    trend.events.map((event) => event.family),
    ["BREAK_EVEN", "FAST_MOVE_TIGHTEN", "FAST_MOVE_HANDOFF_M5_STRUCTURE"],
  );
  assert.equal(trend.events[0]?.stopLoss, 4300);
  assert.equal((trend.events[0] as unknown as { favorablePrice?: number }).favorablePrice, 6.25);
  assert.equal(trend.events[1]?.stopLoss, 4304);
  assert.equal(trend.events[1]?.price, 4310);
  assert.equal(trend.source.available, true);
  assert.equal(trend.source.malformedRows, 0);
  assert.match(trend.source.journalPath, /phase7b-live-forward\/phase7b-demo-events\.jsonl$/);

  const reversal = getPhase7CManagementEvidence({
    runtimeRoot: root,
    accountMode: "LIVE",
    strategy: "REVERSAL",
    positionId: "101",
    openedAt: 1_000,
    closedAt: 2_000,
  });
  assert.equal(reversal.evidence, "EXACT");
  assert.deepEqual(
    reversal.events.map((event) => event.family),
    trend.events.map((event) => event.family),
  );
  assert.equal(reversal.source.journalPath, trend.source.journalPath);

  const sidewayJournal = path.join(root, "phase7c-sideway-live-forward", "phase7c-sideway-events.jsonl");
  writeJsonl(sidewayJournal, [
    {
      timestamp: 3_100,
      event: "PLUS10_PARTIAL_ONE_THIRD",
      ticket: 202,
      favorable: 10.4,
      closedVolume: 0.01,
      remainingVolume: 0.02,
    },
    { timestamp: 3_200, event: "SIDEWAY_M5_STRUCTURAL_SL_TIGHTEN", ticket: "202", structurePrice: 4320, stopLoss: 4321 },
    { timestamp: 3_300, event: "FAST_MOVE_PROFIT_LOCK_REJECTED", ticket: "202", peakPrice: 4325, stopLoss: 4321 },
  ]);

  const sideway = getPhase7CManagementEvidence({
    runtimeRoot: root,
    accountMode: "LIVE",
    strategy: "SIDEWAY",
    positionId: "202",
    openedAt: 3_000,
    closedAt: 4_000,
  });

  assert.equal(sideway.evidence, "EXACT");
  assert.deepEqual(
    sideway.events.map((event) => event.family),
    ["PARTIAL_CLOSE", "M5_STRUCTURAL_TIGHTEN", "FAST_MOVE_REJECTED"],
  );
  const partial = sideway.events[0] as unknown as {
    favorablePrice?: number;
    closedVolume?: number;
    remainingVolume?: number;
  };
  assert.equal(partial.favorablePrice, 10.4);
  assert.equal(partial.closedVolume, 0.01);
  assert.equal(partial.remainingVolume, 0.02);
  assert.equal(sideway.events[1]?.price, 4320);

  writeJsonl(trendJournal, [
    { timestamp: new Date(5_100).toISOString(), type: "PLUS6_SL_TO_ENTRY", ticket: "303", positionId: "304", stopLoss: 4300 },
    { timestamp: new Date(5_200).toISOString(), type: "FAST_MOVE_PROFIT_LOCK_TIGHTEN", ticket: "303", peakPrice: 4310, stopLoss: 4304 },
  ]);

  const ambiguous = getPhase7CManagementEvidence({
    runtimeRoot: root,
    accountMode: "LIVE",
    strategy: "TREND",
    positionId: "303",
    openedAt: 5_000,
    closedAt: 6_000,
  });
  assert.equal(ambiguous.evidence, "AMBIGUOUS");
  assert.deepEqual(ambiguous.events, []);
  assert.ok(ambiguous.warnings.some((warning) => warning.includes("CONFLICTING_EXPLICIT_POSITION_IDENTITIES")));

  const unmatched = getPhase7CManagementEvidence({
    runtimeRoot: root,
    accountMode: "LIVE",
    strategy: "SIDEWAY",
    positionId: "404",
    openedAt: 3_000,
    closedAt: 4_000,
  });
  assert.equal(unmatched.evidence, "UNMATCHED");
  assert.deepEqual(unmatched.events, []);

  const missing = getPhase7CManagementEvidence({
    runtimeRoot: path.join(root, "missing-root"),
    accountMode: "DEMO",
    strategy: "TREND",
    positionId: "505",
    openedAt: 1,
    closedAt: 2,
  });
  assert.equal(missing.evidence, "UNMATCHED");
  assert.equal(missing.source.available, false);

  console.log("P3_PERFORMANCE_MANAGEMENT_EVIDENCE_TEST=PASS");
  console.log("P3_MANAGEMENT_IDENTITY=EXPLICIT_POSITION_ONLY");
  console.log("P3_MANAGEMENT_AMBIGUOUS=FAIL_CLOSED");
  console.log("P3_MANAGEMENT_NATURAL_TRADE_DETAILS=FAVORABLE_CLOSED_REMAINING_VOLUME");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
