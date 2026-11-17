import { describe, expect, it } from "vitest";
import {
  AiDecisionEngine,
  StaticAiProvider
} from "../src";
import {
  createContext,
  opinion
} from "./fixtures";

describe("AiDecisionEngine", () => {
  it("confirms an existing risk-approved strategy", async () => {
    const engine = new AiDecisionEngine([
      new StaticAiProvider(
        "reviewer-1",
        "test-model",
        opinion("CONFIRM")
      )
    ]);

    const result = await engine.review(
      createContext()
    );

    expect(result.executable).toBe(true);
    expect(result.policy.action).toBe("CONFIRM");
    expect(result.policy.order?.volume).toBe(0.2);
  });

  it("downgrades when AI consensus requests WAIT", async () => {
    const engine = new AiDecisionEngine([
      new StaticAiProvider(
        "reviewer-1",
        "test-model",
        opinion("DOWNGRADE_TO_WAIT")
      )
    ]);

    const result = await engine.review(
      createContext()
    );

    expect(result.executable).toBe(false);
    expect(result.policy.action).toBe(
      "DOWNGRADE_TO_WAIT"
    );
    expect(result.policy.order).toBe(null);
  });

  it("rejects when AI consensus rejects", async () => {
    const engine = new AiDecisionEngine([
      new StaticAiProvider(
        "reviewer-1",
        "test-model",
        opinion("REJECT")
      )
    ]);

    const result = await engine.review(
      createContext()
    );

    expect(result.executable).toBe(false);
    expect(result.policy.action).toBe("REJECT");
  });
});
