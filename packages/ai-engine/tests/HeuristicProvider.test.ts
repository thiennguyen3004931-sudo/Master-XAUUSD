import { describe, expect, it } from "vitest";
import {
  AiDecisionEngine,
  DeterministicHeuristicProvider
} from "../src";
import {
  createContext
} from "./fixtures";

describe("DeterministicHeuristicProvider", () => {
  it("confirms a high-quality risk-approved setup", async () => {
    const result = await new AiDecisionEngine([
      new DeterministicHeuristicProvider()
    ]).review(createContext());

    expect(result.consensus?.action).toBe("CONFIRM");
    expect(result.executable).toBe(true);
  });
});
