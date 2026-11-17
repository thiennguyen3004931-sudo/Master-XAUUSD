import { describe, expect, it } from "vitest";
import { OrderSide, type RiskResult } from "@xauusd/types";
import { RiskPipeline } from "../src";
import { createRiskContext } from "./fixtures";

describe("RiskPipeline", () => {
  it("approves a valid trade and creates a normalized order", () => {
    const result = new RiskPipeline().evaluate(createRiskContext());

    expect(result.approved).toBe(true);
    expect(result.decision).toBe("APPROVE");
    expect(result.order?.side).toBe(OrderSide.BUY);
    expect(result.order?.volume).toBeGreaterThan(0);
    expect(result.rules).toHaveLength(13);

    const common: RiskResult = result.commonResult;
    expect(common.approved).toBe(true);
  });
});
