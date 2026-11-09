import { describe, expect, it } from "vitest";
import {
  ExecutionConfigValidator,
  ExecutionInputValidator,
  defaultExecutionEngineConfig,
} from "../src";
import { createStrategyEvaluation } from "./fixtures";

describe("Execution validation", () => {
  it("rejects an invalid quote age configuration", () => {
    expect(() =>
      new ExecutionConfigValidator().validate({
        ...defaultExecutionEngineConfig,
        maxQuoteAgeMs: 0,
      }),
    ).toThrow();
  });

  it("rejects a blank idempotency key", () => {
    expect(() =>
      new ExecutionInputValidator().validate({
        strategyEvaluation: createStrategyEvaluation(),
        idempotencyKey: "   ",
      }),
    ).toThrow();
  });
});
