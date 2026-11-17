import { describe, expect, it } from "vitest";
import { Phase4M5CandidateService } from "../src/services/Phase4M5CandidateService";
import type { Phase4M5Bar } from "../src/models";

function bar(index: number, open: number, high: number, low: number, close: number, volume = 100): Phase4M5Bar {
  return {
    openTime: 1_000 + index * 300,
    closeTime: 1_300 + index * 300,
    open,
    high,
    low,
    close,
    volume,
  };
}

describe("Phase4M5CandidateService", () => {
  it("uses only bars inside signal and expiry window", () => {
    const result = new Phase4M5CandidateService().build({
      side: "BUY",
      canonicalEntry: 3400,
      signalTimestamp: 1_300,
      expiresAt: 2_200,
      bars: [
        bar(0, 3400, 3401, 3399, 3400),
        bar(1, 3398, 3399, 3396, 3397),
        bar(2, 3397, 3398, 3395, 3396),
        bar(3, 3396, 3397, 3394, 3395),
        bar(4, 3395, 3396, 3393, 3394),
      ],
    });

    expect(result.barsConsidered).toBe(3);
    expect(result.candidates.every((candidate) => candidate.timestamp <= 2_200)).toBe(true);
  });

  it("creates favorable BUY structural candidates", () => {
    const result = new Phase4M5CandidateService().build({
      side: "BUY",
      canonicalEntry: 3400,
      signalTimestamp: 1_000,
      expiresAt: 4_000,
      bars: [
        bar(0, 3398, 3399, 3396, 3397),
        bar(1, 3397, 3398, 3395, 3396),
        bar(2, 3400, 3402, 3400, 3401),
        bar(3, 3396, 3397, 3394, 3395),
        bar(4, 3395, 3396, 3393, 3394),
      ],
    });

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.every((candidate) => candidate.price < 3400)).toBe(true);
    expect(Object.keys(result.sources).length).toBeGreaterThan(0);
  });

  it("creates favorable SELL structural candidates symmetrically", () => {
    const result = new Phase4M5CandidateService().build({
      side: "SELL",
      canonicalEntry: 3400,
      signalTimestamp: 1_000,
      expiresAt: 4_000,
      bars: [
        bar(0, 3402, 3404, 3401, 3403),
        bar(1, 3403, 3405, 3402, 3404),
        bar(2, 3399, 3400, 3397, 3398),
        bar(3, 3404, 3406, 3403, 3405),
        bar(4, 3405, 3407, 3404, 3406),
      ],
    });

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.every((candidate) => candidate.price > 3400)).toBe(true);
  });
});
