import { describe, expect, it } from "vitest";
import { Phase7BPullbackEntryService } from "../src/services/Phase7BPullbackEntryService";

const service = new Phase7BPullbackEntryService();

function buyInitial(distance: number) {
  return service.decideInitial({
    signalId: `buy-${distance}`,
    side: "BUY",
    pattern: "ENGULFING",
    signalTimestamp: 1_000_000,
    referenceEntryPrice: 3_300 + distance,
    structuralStopPrice: 3_300,
    maxStopDistancePrice: 10,
    waitMinutes: 60,
  });
}

describe("Phase7BPullbackEntryService", () => {
  it("enters immediately when structural SL is exactly 10", () => {
    const result = buyInitial(10);

    expect(result.state).toBe("ENTRY_IMMEDIATE");
    expect(result.structuralStopDistance).toBeCloseTo(10, 8);
    expect(result.pending).toBeNull();
  });

  it("moves to WAIT_PULLBACK when structural SL is above 10", () => {
    const result = buyInitial(10.01);

    expect(result.state).toBe("WAIT_PULLBACK");
    expect(result.pending?.structuralStopPrice).toBe(3_300);
    expect(result.pending?.structuralStopDistanceAtSignal).toBeCloseTo(10.01, 8);
  });

  it("keeps waiting while the structural distance remains above 10", () => {
    const initial = buyInitial(14);
    const result = service.evaluatePullback({
      pending: initial.pending!,
      timestamp: 1_300_000,
      candidateEntryPrice: 3_311,
      barLow: 3_305,
      barHigh: 3_313,
      setupStillValid: true,
      m15SupertrendAligned: true,
      m5SupertrendAligned: true,
    });

    expect(result.state).toBe("PULLBACK_STILL_TOO_WIDE");
    expect(result.terminal).toBe(false);
  });

  it("executes pullback entry when distance compresses to 10 or less", () => {
    const initial = buyInitial(14);
    const result = service.evaluatePullback({
      pending: initial.pending!,
      timestamp: 1_300_000,
      candidateEntryPrice: 3_309,
      barLow: 3_305,
      barHigh: 3_311,
      setupStillValid: true,
      m15SupertrendAligned: true,
      m5SupertrendAligned: true,
    });

    expect(result.state).toBe("PULLBACK_ENTRY");
    expect(result.structuralStopPrice).toBe(3_300);
    expect(result.structuralStopDistance).toBeCloseTo(9, 8);
    expect(result.entryPrice).toBe(3_309);
    expect(result.terminal).toBe(true);
  });

  it("invalidates before fill when the same M5 bar touches structural stop", () => {
    const initial = buyInitial(14);
    const result = service.evaluatePullback({
      pending: initial.pending!,
      timestamp: 1_300_000,
      candidateEntryPrice: 3_309,
      barLow: 3_300,
      barHigh: 3_311,
      setupStillValid: true,
      m15SupertrendAligned: true,
      m5SupertrendAligned: true,
    });

    expect(result.state).toBe("PULLBACK_SETUP_INVALIDATED");
    expect(result.entryPrice).toBeNull();
  });

  it("cancels when M15 Supertrend flips", () => {
    const initial = buyInitial(14);
    const result = service.evaluatePullback({
      pending: initial.pending!,
      timestamp: 1_300_000,
      candidateEntryPrice: 3_309,
      barLow: 3_305,
      barHigh: 3_311,
      setupStillValid: true,
      m15SupertrendAligned: false,
      m5SupertrendAligned: true,
    });

    expect(result.state).toBe("PULLBACK_M15_ST_INVALIDATED");
  });

  it("cancels when M5 Supertrend flips", () => {
    const initial = buyInitial(14);
    const result = service.evaluatePullback({
      pending: initial.pending!,
      timestamp: 1_300_000,
      candidateEntryPrice: 3_309,
      barLow: 3_305,
      barHigh: 3_311,
      setupStillValid: true,
      m15SupertrendAligned: true,
      m5SupertrendAligned: false,
    });

    expect(result.state).toBe("PULLBACK_M5_ST_INVALIDATED");
  });

  it("expires exactly at the configured waiting boundary", () => {
    const initial = buyInitial(14);
    const result = service.evaluatePullback({
      pending: initial.pending!,
      timestamp: initial.pending!.expiresAt,
      candidateEntryPrice: 3_309,
      barLow: 3_305,
      barHigh: 3_311,
      setupStillValid: true,
      m15SupertrendAligned: true,
      m5SupertrendAligned: true,
    });

    expect(result.state).toBe("PULLBACK_EXPIRED");
  });

  it("expires after the configured waiting window", () => {
    const initial = buyInitial(14);
    const result = service.evaluatePullback({
      pending: initial.pending!,
      timestamp: initial.pending!.expiresAt + 1,
      candidateEntryPrice: 3_309,
      barLow: 3_305,
      barHigh: 3_311,
      setupStillValid: true,
      m15SupertrendAligned: true,
      m5SupertrendAligned: true,
    });

    expect(result.state).toBe("PULLBACK_EXPIRED");
  });

  it("supports SELL symmetrically", () => {
    const initial = service.decideInitial({
      signalId: "sell-14",
      side: "SELL",
      pattern: "THREE_CANDLE_BODY_DOMINANCE",
      signalTimestamp: 1_000_000,
      referenceEntryPrice: 3_300,
      structuralStopPrice: 3_314,
      maxStopDistancePrice: 10,
      waitMinutes: 60,
    });
    expect(initial.state).toBe("WAIT_PULLBACK");

    const result = service.evaluatePullback({
      pending: initial.pending!,
      timestamp: 1_300_000,
      candidateEntryPrice: 3_305,
      barLow: 3_303,
      barHigh: 3_310,
      setupStillValid: true,
      m15SupertrendAligned: true,
      m5SupertrendAligned: true,
    });

    expect(result.state).toBe("PULLBACK_ENTRY");
    expect(result.structuralStopDistance).toBeCloseTo(9, 8);
    expect(result.structuralStopPrice).toBe(3_314);
  });
});
