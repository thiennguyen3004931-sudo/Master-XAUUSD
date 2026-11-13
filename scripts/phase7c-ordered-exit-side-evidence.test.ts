import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getPhase7COrderedExitSideEvidence,
} from "../apps/api/src/services/phase7c-ordered-exit-side-evidence.service";

function auditRow(input: {
  timestamp: number;
  ticket?: string;
  side?: "BUY" | "SELL";
  exitSidePrice?: number;
  bid?: number;
  ask?: number;
  evidenceVersion?: number;
}) {
  return {
    event: "MANAGEMENT_EXIT_SIDE_SAMPLE",
    source: "CANONICAL_MANAGEMENT_OBSERVED_QUOTE",
    strategy: "TREND",
    symbol: "XAUUSD",
    timestamp: input.timestamp,
    ticket: input.ticket ?? "123",
    side: input.side ?? "BUY",
    exitSidePrice: input.exitSidePrice ?? 100,
    bid: input.bid ?? input.exitSidePrice ?? 100,
    ask: input.ask ?? (input.exitSidePrice ?? 100) + 0.2,
    evidenceVersion: input.evidenceVersion ?? 1,
  };
}

function writeRows(root: string, rows: unknown[]) {
  const dir = path.join(root, "phase7c-executors", "decision-observability", "live");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "trend-exit-side-samples.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf8",
  );
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "phase7c-ordered-exit-side-"));
try {
  writeRows(root, [
    auditRow({ timestamp: 1_050, exitSidePrice: 100 }),
    auditRow({ timestamp: 2_000, exitSidePrice: 111 }),
    auditRow({ timestamp: 3_000, exitSidePrice: 120 }),
    auditRow({ timestamp: 9_950, exitSidePrice: 108 }),
  ]);

  const exact = getPhase7COrderedExitSideEvidence({
    runtimeRoot: root,
    accountMode: "LIVE",
    strategy: "TREND",
    positionId: "123",
    side: "BUY",
    openedAt: 1_000,
    closedAt: 10_000,
    boundaryToleranceMs: 120,
  });

  assert.equal(exact.verdict, "COMPLETE_OBSERVED_WINDOW");
  assert.equal(exact.complete, true);
  assert.deepEqual(
    exact.prices.map((row) => [row.timestamp, row.price, row.sequence]),
    [
      [1_050, 100, 0],
      [2_000, 111, 1],
      [3_000, 120, 2],
      [9_950, 108, 3],
    ],
  );
  assert.equal(exact.source.matchedRows, 4);
  assert.deepEqual(exact.warnings, []);

  writeRows(root, [
    auditRow({ timestamp: 2_000, exitSidePrice: 111 }),
    auditRow({ timestamp: 3_000, exitSidePrice: 120 }),
    auditRow({ timestamp: 9_950, exitSidePrice: 108 }),
  ]);
  const missingOpenBoundary = getPhase7COrderedExitSideEvidence({
    runtimeRoot: root,
    accountMode: "LIVE",
    strategy: "TREND",
    positionId: "123",
    side: "BUY",
    openedAt: 1_000,
    closedAt: 10_000,
    boundaryToleranceMs: 120,
  });
  assert.equal(missingOpenBoundary.verdict, "UNAVAILABLE");
  assert.equal(missingOpenBoundary.complete, false);
  assert.equal(missingOpenBoundary.warnings.includes("OPEN_BOUNDARY_NOT_BRACKETED"), true);

  writeRows(root, [
    auditRow({ timestamp: 1_050, exitSidePrice: 100 }),
    auditRow({ timestamp: 2_000, exitSidePrice: 111 }),
    auditRow({ timestamp: 8_000, exitSidePrice: 114 }),
  ]);
  const missingCloseBoundary = getPhase7COrderedExitSideEvidence({
    runtimeRoot: root,
    accountMode: "LIVE",
    strategy: "TREND",
    positionId: "123",
    side: "BUY",
    openedAt: 1_000,
    closedAt: 10_000,
    boundaryToleranceMs: 120,
  });
  assert.equal(missingCloseBoundary.verdict, "UNAVAILABLE");
  assert.equal(missingCloseBoundary.complete, false);
  assert.equal(missingCloseBoundary.warnings.includes("CLOSE_BOUNDARY_NOT_BRACKETED"), true);

  writeRows(root, [
    auditRow({ timestamp: 1_050, exitSidePrice: 100, side: "SELL" }),
    auditRow({ timestamp: 9_950, exitSidePrice: 108, side: "SELL" }),
  ]);
  const sideMismatch = getPhase7COrderedExitSideEvidence({
    runtimeRoot: root,
    accountMode: "LIVE",
    strategy: "TREND",
    positionId: "123",
    side: "BUY",
    openedAt: 1_000,
    closedAt: 10_000,
    boundaryToleranceMs: 120,
  });
  assert.equal(sideMismatch.verdict, "UNAVAILABLE");
  assert.equal(sideMismatch.complete, false);
  assert.equal(sideMismatch.warnings.includes("SIDE_MISMATCH"), true);

  const journalPath = path.join(
    root,
    "phase7c-executors",
    "decision-observability",
    "live",
    "trend-exit-side-samples.jsonl",
  );
  fs.writeFileSync(
    journalPath,
    JSON.stringify(auditRow({ timestamp: 1_050, exitSidePrice: 100 })) +
      "\n{bad-json}\n" +
      JSON.stringify(auditRow({ timestamp: 9_950, exitSidePrice: 108 })) +
      "\n",
    "utf8",
  );
  const malformed = getPhase7COrderedExitSideEvidence({
    runtimeRoot: root,
    accountMode: "LIVE",
    strategy: "TREND",
    positionId: "123",
    side: "BUY",
    openedAt: 1_000,
    closedAt: 10_000,
    boundaryToleranceMs: 120,
  });
  assert.equal(malformed.verdict, "UNAVAILABLE");
  assert.equal(malformed.complete, false);
  assert.equal(malformed.warnings.includes("JOURNAL_MALFORMED_ROWS"), true);

  console.log("P6A_ORDERED_EXIT_SIDE_EVIDENCE_TEST=PASS");
  console.log("P6A_OBSERVED_WINDOW_SOURCE=CANONICAL_MANAGEMENT_OBSERVED_QUOTES");
  console.log("P6A_TRIGGERED_FASTMOVE_EXACT_REQUIRES_BROKER_TICK_PATH=TRUE");
  console.log("P6A_INCOMPLETE_HISTORY_FAIL_CLOSED=PASS");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
