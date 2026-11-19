import { describe, expect, it } from "vitest";
import { FairValueGapDetector } from "../src/detectors/FairValueGapDetector";
import { createCandle } from "./fixtures";

describe("FairValueGapDetector", () => {
  it("detects a bullish three-candle imbalance", () => {
    const candles = [
      createCandle(0, 100, 101, 99, 100),
      createCandle(1, 100, 106, 100, 105),
      createCandle(2, 105, 108, 103, 107),
    ];

    const result = new FairValueGapDetector().detect(candles, {
      minimumSize: 0,
      maxZones: 10,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.bullish).toBe(true);
    expect(result[0]?.low).toBe(101);
    expect(result[0]?.high).toBe(103);
  });
});
