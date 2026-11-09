import { describe, expect, it } from "vitest";
import {
  ExecutionPipeline,
  SimulatedExecutionAdapter,
} from "../src";
import {
  NOW,
  createQuote,
  createSpec,
  createStrategyEvaluation,
} from "./fixtures";

describe("Execution preflight rejections", () => {
  it("rejects an expired strategy plan", async () => {
    const evaluation = createStrategyEvaluation();
    if (!evaluation.plan) throw new Error("Plan missing.");

    const result = await new ExecutionPipeline(
      new SimulatedExecutionAdapter(
        createQuote(),
        createSpec(),
      ),
    ).execute({
      strategyEvaluation: {
        ...evaluation,
        plan: {
          ...evaluation.plan,
          expiresAt: NOW,
        },
      },
      requestedAt: NOW + 60_000,
    });

    expect(result.success).toBe(false);
    expect(result.diagnostics.rejectionCodes).toContain(
      "PLAN_EXPIRED",
    );
  });

  it("rejects excessive spread", async () => {
    const result = await new ExecutionPipeline(
      new SimulatedExecutionAdapter(
        createQuote({ spread: 0.8 }),
        createSpec(),
      ),
    ).execute({
      strategyEvaluation: createStrategyEvaluation(),
      requestedAt: NOW + 60_000,
    });

    expect(result.diagnostics.rejectionCodes).toContain(
      "SPREAD_TOO_HIGH",
    );
  });

  it("rejects excessive adverse slippage", async () => {
    const result = await new ExecutionPipeline(
      new SimulatedExecutionAdapter(
        createQuote({
          bid: 2400.9,
          ask: 2401,
          spread: 0.1,
        }),
        createSpec(),
      ),
      { maxSlippageTicks: 50 },
    ).execute({
      strategyEvaluation: createStrategyEvaluation(),
      requestedAt: NOW + 60_000,
    });

    expect(result.diagnostics.rejectionCodes).toContain(
      "SLIPPAGE_TOO_HIGH",
    );
  });

  it("rejects a WAIT strategy evaluation", async () => {
    const evaluation = createStrategyEvaluation({
      action: "WAIT",
      plan: null,
    });

    const result = await new ExecutionPipeline(
      new SimulatedExecutionAdapter(
        createQuote(),
        createSpec(),
      ),
    ).execute({
      strategyEvaluation: evaluation,
      requestedAt: NOW + 60_000,
    });

    expect(result.diagnostics.rejectionCodes).toContain(
      "STRATEGY_NOT_EXECUTABLE",
    );
  });
});
