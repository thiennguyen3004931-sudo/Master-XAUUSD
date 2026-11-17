import { describe, expect, it } from "vitest";
import { TradingSession } from "@xauusd/types";
import { StrategyPipeline } from "../src";
import { createContext, createRiskAssessment } from "./fixtures";

describe("StrategyPipeline safety gates", () => {
  it("rejects a risk-denied trade", () => {
    const result = new StrategyPipeline().evaluate(createContext({
      riskAssessment: createRiskAssessment({ approved: false, decision: "REJECT", order: null }),
    }));
    expect(result.action).toBe("REJECT");
    expect(result.diagnostics.rejectionCodes).toContain("RISK_NOT_APPROVED");
  });

  it("waits during a closed session", () => {
    const result = new StrategyPipeline().evaluate(createContext({ session: TradingSession.CLOSED }));
    expect(result.action).toBe("WAIT");
    expect(result.diagnostics.rejectionCodes).toContain("SESSION_NOT_ALLOWED");
  });

  it("waits when upstream context is stale", () => {
    const result = new StrategyPipeline().evaluate(createContext({ evaluatedAt: 1_700_001_000_000 }));
    expect(result.action).toBe("WAIT");
    expect(result.diagnostics.rejectionCodes).toContain("CONTEXT_STALE");
  });
});
