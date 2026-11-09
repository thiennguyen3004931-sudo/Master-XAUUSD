import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const controllerSource = readFileSync(
  new URL("../../../scripts/run-phase7b-demo-controller.ts", import.meta.url),
  "utf8",
);

function pendingPullbackBlock(): string {
  const start = controllerSource.indexOf("if (state.pendingPullback) {");
  const endMarker = "if (latestM15.closeTime <= state.lastEvaluatedM15Close) return;";
  const end = controllerSource.indexOf(endMarker, start);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return controllerSource.slice(start, end);
}

describe("Phase7B Trend controller pending pullback contract", () => {
  it("uses exactly the immediately following M15 candle as the pullback window", () => {
    expect(controllerSource).toContain("const pullbackWaitMinutes = 15;");
    expect(controllerSource).not.toContain("ZIQ_PHASE7B_PULLBACK_WAIT_MINUTES");
  });

  it("re-evaluates an active pending pullback without waiting for a new closed M5 bar", () => {
    const block = pendingPullbackBlock();

    expect(block).not.toContain(
      "if (latestM5.closeTime <= state.lastEvaluatedM5Close) return;",
    );
    expect(block).toContain("const pullbackCycleTimestamp = Number(quote.timestamp);");
    expect(block).toContain("timestamp: pullbackCycleTimestamp");
    expect(block).not.toContain("timestamp: latestM5.closeTime");
    expect(block).toContain('pending.side === "BUY" ? quote.ask : quote.bid');
  });

  it("evaluates terminal pullback lifecycle before generic strategy-condition entry gating", () => {
    const block = pendingPullbackBlock();
    const evaluationIndex = block.indexOf("pullbackEntryService.evaluatePullback({");
    const genericGateIndex = block.indexOf(
      "if (!entryConditions || !entryConditions.allEnabledPassed) {",
    );

    expect(evaluationIndex).toBeGreaterThanOrEqual(0);
    expect(genericGateIndex).toBeGreaterThanOrEqual(0);
    expect(evaluationIndex).toBeLessThan(genericGateIndex);
  });
});
