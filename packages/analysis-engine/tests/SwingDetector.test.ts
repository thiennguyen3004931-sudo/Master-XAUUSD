import { describe, expect, it } from "vitest";
import { SwingType } from "@xauusd/types";
import { SwingDetector } from "../src/detectors/SwingDetector";
import { createCandle } from "./fixtures";

describe("SwingDetector", () => {
  it("detects local highs and lows", () => {
    const candles = [
      createCandle(0, 10, 11, 9, 10),
      createCandle(1, 10, 13, 9.5, 12),
      createCandle(2, 12, 15, 11, 14),
      createCandle(3, 14, 13, 8, 9),
      createCandle(4, 9, 12, 9, 11),
    ];

    const result = new SwingDetector().detect(candles, {
      leftBars: 1,
      rightBars: 1,
      externalStrength: 4,
    });

    expect(result.some((swing) => swing.type === SwingType.High)).toBe(true);
    expect(result.some((swing) => swing.type === SwingType.Low)).toBe(true);
  });
});
