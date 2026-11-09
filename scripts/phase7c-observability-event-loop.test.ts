import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __test as performanceIntelligenceTest } from "../apps/api/src/services/phase7c-performance-intelligence.service";

type ParsedAuditSourceShape = {
  available: boolean;
  parsedRows: number;
  malformedRows: number;
  events: Array<{ eventName: string }>;
};

async function main(): Promise<void> {
  const parseAuditSource = (performanceIntelligenceTest as Record<string, unknown>)
    .parseAuditSource;

  assert.equal(
    typeof parseAuditSource,
    "function",
    "performance intelligence must expose parseAuditSource to semantic regression tests",
  );

  const root = await mkdtemp(path.join(os.tmpdir(), "phase7c-event-loop-"));
  const fileName = "trend-decisions.jsonl";
  const filePath = path.join(root, fileName);

  try {
    const validRows = Array.from({ length: 12_000 }, (_, index) =>
      JSON.stringify({
        event: index % 2 === 0 ? "ENTRY_FILLED" : "DECISION",
        eventId: `event-${index}`,
        positionId: index % 2 === 0 ? String(100_000 + index) : undefined,
        passedRules: ["REGRESSION_RULE"],
      }),
    );
    const lines = [
      validRows[0]!,
      "{malformed-json",
      "[]",
      ...validRows.slice(1),
      "",
    ];
    await writeFile(filePath, lines.join("\n"), "utf8");

    let timerFired = false;
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        timerFired = true;
        resolve();
      }, 0);
    });

    const pending = (
      parseAuditSource as (
        strategy: "TREND" | "SIDEWAY",
        root: string,
        fileName: string,
      ) => unknown
    )("TREND", root, fileName);

    assert.ok(
      pending instanceof Promise,
      "parseAuditSource must be asynchronous instead of blocking the Node event loop",
    );

    const result = (await pending) as ParsedAuditSourceShape;
    await timer;

    assert.equal(timerFired, true, "audit parsing must yield so timers can run");
    assert.equal(result.available, true);
    assert.equal(result.parsedRows, 12_000);
    assert.equal(result.malformedRows, 2);
    assert.equal(result.events.length, 12_000);
    assert.equal(result.events[0]?.eventName, "ENTRY_FILLED");

    console.log("PHASE7C_OBSERVABILITY_EVENT_LOOP_SEMANTIC=PASS");
    console.log("AUDIT_PARSER=ASYNC");
    console.log("EVENT_LOOP_YIELD=PASS");
    console.log("PARSED_ROWS=12000");
    console.log("MALFORMED_ROWS=2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("PHASE7C_OBSERVABILITY_EVENT_LOOP_SEMANTIC=FAIL");
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
