import { describe, expect, it } from "vitest";
import { SignalPipeline } from "../src";
import { createContext } from "./fixtures";

describe("Signal validation", () => {
  it("rejects mismatched symbols", () => {
    const context = createContext();
    context.indicators.symbol = "EURUSD";
    expect(() => new SignalPipeline().generate(context)).toThrow(/symbols must match/);
  });

  it("rejects mismatched closing snapshots", () => {
    const context = createContext();
    context.indicators.latest.close = 2400;
    expect(() => new SignalPipeline().generate(context)).toThrow(/same closing price/);
  });
});
