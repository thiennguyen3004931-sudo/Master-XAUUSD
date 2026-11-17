import { describe, expect, it } from "vitest";
import { MathUtils, PriceUtils, ValidationUtils } from "../src";

describe("shared utilities", () => {
  it("rounds and clamps numbers", () => {
    expect(MathUtils.round(1.235, 2)).toBe(1.24);
    expect(MathUtils.clamp(12, 0, 10)).toBe(10);
  });

  it("calculates risk/reward", () => {
    expect(PriceUtils.riskReward(3300, 3290, 3320)).toBe(2);
  });

  it("validates values", () => {
    expect(ValidationUtils.isPositive(1)).toBe(true);
    expect(ValidationUtils.hasValue(null)).toBe(false);
  });
});
