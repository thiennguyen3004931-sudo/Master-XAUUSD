import { describe, expect, it } from "vitest";
import { RiskPipeline } from "../src";
import {
  createPortfolio,
  createRiskContext,
  createSignalResult,
} from "./fixtures";

describe("RiskPipeline rejections", () => {
  it("rejects daily loss limit", () => {
    const result = new RiskPipeline().evaluate(
      createRiskContext({
        portfolio: createPortfolio({
          dailyRealizedPnl: -350,
        }),
      }),
    );

    expect(result.approved).toBe(false);
    expect(result.diagnostics.rejectionCodes).toContain(
      "DAILY_LOSS_LIMIT_REACHED",
    );
  });

  it("rejects an unaccepted signal", () => {
    const result = new RiskPipeline().evaluate(
      createRiskContext({
        signalResult: createSignalResult({
          signal: null,
          levels: null,
          diagnostics: {
            accepted: false,
            rejectionCodes: ["NO_DIRECTION"],
            notes: [],
          },
        }),
      }),
    );

    expect(result.approved).toBe(false);
    expect(result.diagnostics.rejectionCodes).toContain(
      "SIGNAL_NOT_ACCEPTED",
    );
  });

  it("rejects excessive spread", () => {
    const result = new RiskPipeline().evaluate(
      createRiskContext({
        portfolio: createPortfolio({ spread: 0.8 }),
      }),
    );

    expect(result.diagnostics.rejectionCodes).toContain(
      "SPREAD_TOO_HIGH",
    );
  });
});
