import { describe, expect, it } from "vitest";
import { WalkForwardWindowService } from "../src";
import { createCandles } from "./fixtures";

describe("WalkForwardWindowService", () => {
  it("creates rolling train and test windows", () => {
    const candles = createCandles(
      Array.from({ length: 20 }, (_, index) => 100 + index),
    );
    const windows = new WalkForwardWindowService().create(
      candles,
      {
        trainingBars: 10,
        testingBars: 4,
        stepBars: 4,
        anchored: false,
      },
    );

    expect(windows).toHaveLength(2);
    expect(windows[0]!.trainingCandles).toHaveLength(10);
    expect(windows[0]!.testingCandles).toHaveLength(4);
    expect(windows[1]!.trainingStartIndex).toBe(4);
  });
});
