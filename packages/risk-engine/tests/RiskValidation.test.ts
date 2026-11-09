import { describe, expect, it } from "vitest";
import {
  RiskConfigValidator,
  RiskInputValidator,
  defaultRiskEngineConfig,
} from "../src";
import { createInstrument, createRiskContext } from "./fixtures";

describe("Risk validation", () => {
  it("rejects an invalid risk range", () => {
    expect(() =>
      new RiskConfigValidator().validate({
        ...defaultRiskEngineConfig,
        minRiskPercent: 2,
        maxRiskPercent: 1,
      }),
    ).toThrow();
  });

  it("rejects mismatched signal and instrument symbols", () => {
    expect(() =>
      new RiskInputValidator().validate(
        createRiskContext({
          instrument: createInstrument({ symbol: "EURUSD" }),
        }),
      ),
    ).toThrow();
  });
});
