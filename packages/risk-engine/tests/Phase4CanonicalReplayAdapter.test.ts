import { describe, expect, it } from "vitest";
import { OrderSide } from "@xauusd/types";
import { Phase4CanonicalReplayAdapter } from "../src/services/Phase4CanonicalReplayAdapter";
import type { InstrumentRiskSpec, Phase4M5Bar } from "../src/models";

const instrument: InstrumentRiskSpec = {
  symbol: "XAUUSD",
  tickSize: 0.01,
  tickValuePerLot: 1,
  contractSize: 100,
  minVolume: 0.01,
  maxVolume: 100,
  volumeStep: 0.01,
  maxSpread: 1,
  priceDigits: 2,
};

const bars: Phase4M5Bar[] = [
  { openTime: 1_000, closeTime: 1_300, open: 3398, high: 3399, low: 3396, close: 3397, volume: 100 },
  { openTime: 1_300, closeTime: 1_600, open: 3397, high: 3398, low: 3395, close: 3396, volume: 110 },
  { openTime: 1_600, closeTime: 1_900, open: 3396, high: 3397, low: 3394, close: 3395, volume: 120 },
  { openTime: 1_900, closeTime: 2_200, open: 3395, high: 3396, low: 3393, close: 3394, volume: 130 },
];

describe("Phase4CanonicalReplayAdapter", () => {
  it("collects research cases without changing execution state", () => {
    const adapter = new Phase4CanonicalReplayAdapter();

    adapter.add({
      id: "case-1",
      side: OrderSide.BUY,
      canonicalEntry: 3400,
      canonicalStopLoss: 3388,
      canonicalTakeProfit: 3420,
      signalTimestamp: 1_000,
      expiresAt: 2_200,
      effectiveRiskCapUsd: 8,
      instrument,
      m5Bars: bars,
    });

    const result = adapter.result();
    expect(adapter.size).toBe(1);
    expect(result.counters.totalCases).toBe(1);
    expect(result.counters.canonicalMinLotBlocked).toBe(1);
    expect(result.counters.finalMinLotFeasible).toBeGreaterThanOrEqual(0);
    expect(adapter.formatCounters()).toContain("PHASE4_TOTAL_CASES=1");
  });

  it("exposes only feasible canonical/rescued cases to the shadow lane", () => {
    const adapter = new Phase4CanonicalReplayAdapter();

    adapter.add({
      id: "feasible",
      side: OrderSide.BUY,
      canonicalEntry: 3400,
      canonicalStopLoss: 3395,
      canonicalTakeProfit: 3420,
      signalTimestamp: 1_000,
      expiresAt: 2_200,
      effectiveRiskCapUsd: 10,
      instrument,
      m5Bars: bars,
    });

    const shadow = adapter.shadowCases();
    expect(shadow).toHaveLength(1);
    expect(shadow[0]?.volume).toBe(0.01);
    expect(shadow[0]?.takeProfit).toBe(3420);
    expect(shadow[0]?.entrySource).toBe("CANONICAL");
  });
});
