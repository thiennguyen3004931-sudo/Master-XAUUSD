import { describe, expect, it } from "vitest";
import { PositionSizeService } from "../src";
import { createInstrument } from "./fixtures";

describe("PositionSizeService", () => {
  it("sizes XAUUSD volume from stop distance and risk amount", () => {
    const result = new PositionSizeService().calculate(
      2400,
      2395,
      10_000,
      {
        baseRiskPercent: 1,
        confidenceFactor: 1,
        strengthFactor: 1,
        drawdownFactor: 1,
        lossStreakFactor: 1,
        availablePortfolioRiskAmount: 400,
        requestedRiskPercent: 1,
        requestedRiskAmount: 100,
        approvedRiskPercent: 1,
        approvedRiskAmount: 100,
      },
      createInstrument(),
    );

    expect(result.riskPerLot).toBe(500);
    expect(result.volume).toBe(0.2);
    expect(result.actualRiskAmount).toBe(100);
  });
});
