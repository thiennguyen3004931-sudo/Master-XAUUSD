import { describe, expect, it } from "vitest";
import {
  ExecutionPipeline,
  InMemoryExecutionRepository,
  ReconciliationService,
  SimulatedExecutionAdapter,
} from "../src";
import {
  NOW,
  createQuote,
  createSpec,
  createStrategyEvaluation,
} from "./fixtures";

describe("ReconciliationService", () => {
  it("reports a consistent filled position", async () => {
    const clock = { now: () => NOW + 60_000 };
    const repository = new InMemoryExecutionRepository();
    const adapter = new SimulatedExecutionAdapter(
      createQuote(),
      createSpec(),
      {},
      clock,
    );
    const pipeline = new ExecutionPipeline(
      adapter,
      {},
      repository,
      undefined,
      undefined,
      clock,
    );

    await pipeline.execute({
      strategyEvaluation: createStrategyEvaluation(),
      requestedAt: NOW + 60_000,
    });

    const result = await new ReconciliationService(
      adapter,
      repository,
      clock,
    ).reconcile("XAUUSD");

    expect(result.consistent).toBe(true);
  });
});
