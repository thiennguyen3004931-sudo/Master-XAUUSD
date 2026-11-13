import { describe, expect, it } from "vitest";
import {
  AiConfigValidator,
  AiContextValidator,
  defaultAiEngineConfig
} from "../src";
import {
  createContext,
  createIndicators
} from "./fixtures";

describe("AI validation", () => {
  it("rejects invalid agreement ratio", () => {
    expect(() =>
      new AiConfigValidator().validate({
        ...defaultAiEngineConfig,
        minimumAgreementRatio: 1.2
      })
    ).toThrow();
  });

  it("rejects mismatched symbols", () => {
    expect(() =>
      new AiContextValidator().validate(
        createContext({
          indicators: {
            ...createIndicators(),
            symbol: "EURUSD"
          }
        })
      )
    ).toThrow();
  });
});
