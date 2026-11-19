import { describe, expect, it } from "vitest";
import {
  AiDecisionEngine,
  StaticAiProvider
} from "../src";
import {
  createContext,
  createRisk,
  createStrategy,
  opinion
} from "./fixtures";

describe("AI safety policy", () => {
  it("never upgrades WAIT to EXECUTE", async () => {
    const strategy = createStrategy({
      action: "WAIT",
      plan: null
    });
    const engine = new AiDecisionEngine([
      new StaticAiProvider(
        "reviewer",
        "model",
        opinion("CONFIRM")
      )
    ]);

    const result = await engine.review(
      createContext({
        strategyEvaluation: strategy
      })
    );

    expect(result.executable).toBe(false);
    expect(result.policy.action).toBe("REJECT");
    expect(result.policy.order).toBe(null);
  });

  it("never bypasses Risk Engine rejection", async () => {
    const risk = {
      ...createRisk(),
      approved: false,
      decision: "REJECT" as const,
      order: null
    };
    const engine = new AiDecisionEngine([
      new StaticAiProvider(
        "reviewer",
        "model",
        opinion("CONFIRM")
      )
    ]);

    const result = await engine.review(
      createContext({
        riskAssessment: risk
      })
    );

    expect(result.executable).toBe(false);
    expect(result.policy.order).toBe(null);
  });

  it("preserves the exact risk-approved order", async () => {
    const context = createContext();
    const engine = new AiDecisionEngine([
      new StaticAiProvider(
        "reviewer",
        "model",
        opinion("CONFIRM", 100)
      )
    ]);
    const result = await engine.review(context);

    expect(result.policy.order).toEqual(
      context.riskAssessment.order
    );
  });
});
