import { describe, expect, it } from "vitest";
import { StrategyConfigValidator, StrategyInputValidator, defaultStrategyEngineConfig } from "../src";
import { createContext, createIndicators } from "./fixtures";

describe("Strategy validation", () => {
  it("rejects invalid ADX threshold ordering", () => {
    expect(() => new StrategyConfigValidator().validate({
      ...defaultStrategyEngineConfig,
      rangeAdxThreshold: 30,
      trendAdxThreshold: 20,
    })).toThrow();
  });

  it("rejects indicators that are not warmed up", () => {
    expect(() => new StrategyInputValidator().validate(createContext({
      indicators: createIndicators({ warmupComplete: false }),
    }))).toThrow();
  });
});
