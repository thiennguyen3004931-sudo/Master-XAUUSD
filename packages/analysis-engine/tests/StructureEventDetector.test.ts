import { describe, expect, it } from "vitest";
import { SwingType, type SwingPoint } from "@xauusd/types";
import { StructureEventDetector } from "../src/detectors/StructureEventDetector";
import { createCandle } from "./fixtures";

describe("StructureEventDetector", () => {
  it("confirms a bullish break above a prior swing high", () => {
    const candles = [
      createCandle(0, 100, 102, 99, 101),
      createCandle(1, 101, 105, 100, 104),
      createCandle(2, 104, 104.5, 101, 102),
      createCandle(3, 102, 108, 102, 107),
    ];
    const swing: SwingPoint = {
      index: 1,
      timestamp: candles[1]!.openTime,
      price: 105,
      high: 105,
      low: 100,
      close: 104,
      type: SwingType.High,
      strength: 4,
    };

    const result = new StructureEventDetector().detect(candles, [swing]);

    expect(result).toHaveLength(1);
    expect(result[0]?.direction).toBe("BULLISH");
    expect(result[0]?.level).toBe(105);
  });
});
