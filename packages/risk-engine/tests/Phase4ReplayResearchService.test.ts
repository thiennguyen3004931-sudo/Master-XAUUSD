import { describe, expect, it } from "vitest";
import { OrderSide } from "@xauusd/types";
import type { EntryCompressionRequest, InstrumentRiskSpec } from "../src/models";
import { Phase4ReplayResearchService } from "../src/services/Phase4ReplayResearchService";

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

function request(overrides: Partial<EntryCompressionRequest> = {}): EntryCompressionRequest {
  return {
    side: OrderSide.BUY,
    canonicalEntry: 3400,
    canonicalStopLoss: 3388,
    canonicalSignalTime: 1_000,
    expiresAt: 1_900,
    effectiveRiskCapUsd: 8,
    instrument,
    candidates: [],
    ...overrides,
  };
}

describe("Phase4ReplayResearchService", () => {
  it("aggregates baseline feasible, rescued, and still-blocked cases", () => {
    const result = new Phase4ReplayResearchService().run([
      {
        id: "baseline-feasible",
        request: request({ effectiveRiskCapUsd: 15 }),
      },
      {
        id: "rescued",
        request: request({
          candidates: [{ price: 3395, source: "FVG", timestamp: 1_300 }],
        }),
      },
      {
        id: "still-blocked",
        request: request({
          candidates: [{ price: 3398, source: "MA20", timestamp: 1_300 }],
        }),
      },
    ]);

    expect(result.counters.totalCases).toBe(3);
    expect(result.counters.canonicalMinLotFeasible).toBe(1);
    expect(result.counters.canonicalMinLotBlocked).toBe(2);
    expect(result.counters.compressionAttempted).toBe(2);
    expect(result.counters.minLotRescued).toBe(1);
    expect(result.counters.stillMinLotBlocked).toBe(1);
    expect(result.counters.finalMinLotFeasible).toBe(2);
  });

  it("tracks expired-only and stop-crossed-only candidate sets", () => {
    const result = new Phase4ReplayResearchService().run([
      {
        id: "expired",
        request: request({
          candidates: [{ price: 3395, source: "SUPPLY_DEMAND", timestamp: 2_100 }],
        }),
      },
      {
        id: "crossed",
        request: request({
          candidates: [{ price: 3387, source: "VOLUME_PROFILE", timestamp: 1_300 }],
        }),
      },
    ]);

    expect(result.counters.candidateExpiredOnly).toBe(1);
    expect(result.counters.canonicalStopCrossedOnly).toBe(1);
    expect(result.counters.finalMinLotFeasible).toBe(0);
  });

  it("formats stable replay counter lines", () => {
    const service = new Phase4ReplayResearchService();
    const result = service.run([]);

    expect(service.formatCounters(result.counters)).toContain("PHASE4_MINLOT_RESCUED=0");
    expect(service.formatCounters(result.counters)).toContain("PHASE4_FINAL_MINLOT_FEASIBLE=0");
  });
});
