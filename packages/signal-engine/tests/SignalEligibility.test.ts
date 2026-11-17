import { describe, expect, it } from "vitest";
import { TradeDecision } from "@xauusd/types";
import { SignalPipeline } from "../src";
import { createContext } from "./fixtures";

describe("Signal eligibility", () => {
  it("returns WAIT when indicator warm-up is incomplete", () => {
    const context = createContext("BULLISH");
    context.indicators.warmupComplete = false;
    const result = new SignalPipeline().generate(context);
    expect(result.decision).toBe(TradeDecision.WAIT);
    expect(result.diagnostics.rejectionCodes).toContain("INDICATOR_WARMUP_INCOMPLETE");
  });

  it("returns WAIT when data quality is below the configured minimum", () => {
    const context = createContext("BULLISH");
    context.analysis.metrics.dataQuality = 70;
    const result = new SignalPipeline().generate(context);
    expect(result.signal).toBeNull();
    expect(result.diagnostics.rejectionCodes).toContain("DATA_QUALITY_TOO_LOW");
  });
});
