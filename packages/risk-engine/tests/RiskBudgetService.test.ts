import { describe, expect, it } from "vitest";
import { RiskBudgetService, defaultRiskEngineConfig } from "../src";
import { createRiskContext } from "./fixtures";

describe("RiskBudgetService", () => {
  it("reduces risk after consecutive losses and drawdown", () => {
    const service = new RiskBudgetService();
    const normal = service.calculate(
      createRiskContext(),
      defaultRiskEngineConfig,
    );
    const reduced = service.calculate(
      createRiskContext({
        account: {
          ...createRiskContext().account,
          equity: 9_300,
        },
        portfolio: {
          ...createRiskContext().portfolio,
          peakEquity: 10_000,
          consecutiveLosses: 2,
        },
      }),
      defaultRiskEngineConfig,
    );

    expect(reduced.approvedRiskPercent).toBeLessThan(
      normal.approvedRiskPercent,
    );
  });
});
