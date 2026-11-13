import { describe, expect, it } from "vitest";
import { TradeDecision } from "@xauusd/types";
import { SignalPipeline } from "../src";
import { createContext } from "./fixtures";

describe("SignalPipeline", () => {
  it("creates a BUY signal for strong bullish confluence", () => {
    const result = new SignalPipeline().generate(createContext("BULLISH"));
    expect(result.decision).toBe(TradeDecision.BUY);
    expect(result.signal?.type).toBe("BUY");
    expect(result.levels?.riskReward).toBeGreaterThanOrEqual(1.8);
    expect(result.diagnostics.accepted).toBe(true);
  });

  it("creates a SELL signal for strong bearish confluence", () => {
    const result = new SignalPipeline().generate(createContext("BEARISH"));
    expect(result.decision).toBe(TradeDecision.SELL);
    expect(result.signal?.type).toBe("SELL");
    expect(result.levels?.stopLoss).toBeGreaterThan(result.levels?.entry ?? 0);
  });
});
