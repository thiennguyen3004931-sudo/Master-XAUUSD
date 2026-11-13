import { describe, expect, it } from "vitest";
import {
  BreakoutRetestStrategy,
  StrategyPipeline,
} from "../src";
import { acceptsCommonResult, createContext } from "./fixtures";

describe("StrategyPipeline", () => {
  it("creates an executable breakout plan", () => {
    const result = new StrategyPipeline(
      { minimumCandidateEdge: 0 },
      [new BreakoutRetestStrategy()],
    ).evaluate(createContext());
    expect(result.action).toBe("EXECUTE");
    expect(result.plan?.selectedStrategy.strategyId).toBe("BREAKOUT_RETEST");
    expect(result.plan?.order.volume).toBe(0.2);
    expect(result.plan?.management.partialTargets).toHaveLength(3);
    expect(acceptsCommonResult(result.commonResult).decision).toBe("BUY");
  });
});

/**
 * Phase 7C production default keeps breakout/reversal opt-in while enabling
 * only the mutually-exclusive TREND_CONTINUATION and RANGE_MEAN_REVERSION bots.
 */
describe("StrategyPipeline controlled production default", () => {
  it("includes the range bot without restoring breakout into the default module set", () => {
    const result = new StrategyPipeline({
      minimumCandidateEdge: 0,
    }).evaluate(createContext());
    const strategyIds = result.selection.ranked.map((candidate) => candidate.strategyId);

    expect(strategyIds).toContain("TREND_CONTINUATION");
    expect(strategyIds).toContain("RANGE_MEAN_REVERSION");
    expect(strategyIds).not.toContain("BREAKOUT_RETEST");
    expect(result.botMode).toBe("AUTO");
  });
});

describe("StrategyPipeline operator bot mode gate", () => {
  it("TREND evaluates only the Trend bot", () => {
    const result = new StrategyPipeline({ minimumCandidateEdge: 0 }).evaluate(
      createContext({ botMode: "TREND" }),
    );

    expect(result.botMode).toBe("TREND");
    expect(result.selection.ranked.map((candidate) => candidate.strategyId)).toEqual([
      "TREND_CONTINUATION",
    ]);
  });

  it("SIDEWAY evaluates only the Range Mean Reversion bot", () => {
    const result = new StrategyPipeline({ minimumCandidateEdge: 0 }).evaluate(
      createContext({ botMode: "SIDEWAY" }),
    );

    expect(result.botMode).toBe("SIDEWAY");
    expect(result.selection.ranked.map((candidate) => candidate.strategyId)).toEqual([
      "RANGE_MEAN_REVERSION",
    ]);
  });

  it("PAUSE disables every strategy and cannot create an order plan", () => {
    const result = new StrategyPipeline({ minimumCandidateEdge: 0 }).evaluate(
      createContext({ botMode: "PAUSE" }),
    );

    expect(result.botMode).toBe("PAUSE");
    expect(result.action).toBe("WAIT");
    expect(result.plan).toBeNull();
    expect(result.selection.ranked).toEqual([]);
    expect(result.diagnostics.accepted).toBe(false);
    expect(result.diagnostics.warnings).toContain(
      "BOT_MODE_PAUSE: Strategy execution is disabled by operator.",
    );
  });

  it("AUTO keeps both production bots available for regime selection", () => {
    const result = new StrategyPipeline({ minimumCandidateEdge: 0 }).evaluate(
      createContext({ botMode: "AUTO" }),
    );
    const strategyIds = result.selection.ranked.map((candidate) => candidate.strategyId);

    expect(strategyIds).toContain("TREND_CONTINUATION");
    expect(strategyIds).toContain("RANGE_MEAN_REVERSION");
    expect(result.botMode).toBe("AUTO");
  });
});
