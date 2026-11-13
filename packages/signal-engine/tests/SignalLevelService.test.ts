import { describe, expect, it } from "vitest";
import { defaultSignalEngineConfig, SignalLevelService } from "../src";
import { createContext } from "./fixtures";

describe("SignalLevelService", () => {
  it("builds a three-stage partial take-profit plan", () => {
    const levels = new SignalLevelService().calculate(
      createContext("BULLISH"),
      "BULLISH",
      defaultSignalEngineConfig,
    );
    expect(levels?.partialTargets).toHaveLength(3);
    expect(levels?.partialTargets.reduce((sum, target) => sum + target.closePercent, 0)).toBe(100);
    expect(levels?.stopLoss).toBeLessThan(levels?.entry ?? 0);
  });
});
