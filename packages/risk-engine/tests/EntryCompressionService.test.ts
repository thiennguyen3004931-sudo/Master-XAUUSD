import { describe, expect, it } from "vitest";
import { OrderSide } from "@xauusd/types";
import { EntryCompressionService } from "../src/services/EntryCompressionService";
import type { EntryCompressionRequest, InstrumentRiskSpec } from "../src/models";

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

function baseRequest(): EntryCompressionRequest {
  return {
    side: OrderSide.BUY,
    canonicalEntry: 3400,
    canonicalStopLoss: 3388,
    canonicalSignalTime: 1_000,
    expiresAt: 1_900,
    effectiveRiskCapUsd: 8,
    instrument,
    candidates: [],
  };
}

describe("EntryCompressionService", () => {
  it("rescues a blocked 0.01 lot setup using a favorable structural M5 entry", () => {
    const result = new EntryCompressionService().evaluate({
      ...baseRequest(),
      candidates: [
        { price: 3395, source: "FVG", timestamp: 1_300 },
      ],
    });

    expect(result.canonicalRiskAtMinVolumeUsd).toBe(12);
    expect(result.canonicalFeasibleAtMinVolume).toBe(false);
    expect(result.selectedEntry).toBe(3395);
    expect(result.selectedRiskAtMinVolumeUsd).toBe(7);
    expect(result.rescuedAtMinVolume).toBe(true);
  });

  it("rejects a candidate that crosses the canonical structural stop", () => {
    const result = new EntryCompressionService().evaluate({
      ...baseRequest(),
      candidates: [
        { price: 3387, source: "SUPPLY_DEMAND", timestamp: 1_300 },
      ],
    });

    expect(result.selectedEntry).toBeNull();
    expect(result.assessments[0]?.rejectionCodes).toContain("CANONICAL_STOP_CROSSED");
  });

  it("rejects expired M5 candidates", () => {
    const result = new EntryCompressionService().evaluate({
      ...baseRequest(),
      candidates: [
        { price: 3395, source: "MA20", timestamp: 2_000 },
      ],
    });

    expect(result.selectedEntry).toBeNull();
    expect(result.assessments[0]?.rejectionCodes).toContain("OUTSIDE_EXECUTION_WINDOW");
  });

  it("supports SELL compression symmetrically", () => {
    const result = new EntryCompressionService().evaluate({
      ...baseRequest(),
      side: OrderSide.SELL,
      canonicalEntry: 3400,
      canonicalStopLoss: 3412,
      candidates: [
        { price: 3405, source: "VOLUME_PROFILE", timestamp: 1_400 },
      ],
    });

    expect(result.canonicalRiskAtMinVolumeUsd).toBe(12);
    expect(result.selectedEntry).toBe(3405);
    expect(result.selectedRiskAtMinVolumeUsd).toBe(7);
    expect(result.rescuedAtMinVolume).toBe(true);
  });

  it("does not mark an already-feasible canonical setup as rescued", () => {
    const result = new EntryCompressionService().evaluate({
      ...baseRequest(),
      effectiveRiskCapUsd: 15,
      candidates: [
        { price: 3395, source: "FVG", timestamp: 1_300 },
      ],
    });

    expect(result.canonicalFeasibleAtMinVolume).toBe(true);
    expect(result.rescuedAtMinVolume).toBe(false);
  });
});
