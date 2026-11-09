import { describe, expect, it } from "vitest";
import {
  ExecutionPipeline,
  InMemoryExecutionRepository,
  InMemoryIdempotencyStore,
  SimulatedExecutionAdapter,
} from "../src";
import {
  NOW,
  createQuote,
  createSpec,
  createStrategyEvaluation,
} from "./fixtures";

describe("ExecutionPipeline", () => {
  it("executes a valid BUY strategy plan", async () => {
    const adapter = new SimulatedExecutionAdapter(
      createQuote(),
      createSpec(),
      {},
      { now: () => NOW + 60_000 },
    );
    const result = await new ExecutionPipeline(
      adapter,
      {},
      new InMemoryExecutionRepository(),
      new InMemoryIdempotencyStore({
        now: () => NOW + 60_000,
      }),
      undefined,
      { now: () => NOW + 60_000 },
    ).execute({
      strategyEvaluation: createStrategyEvaluation(),
      requestedAt: NOW + 60_000,
    });

    expect(result.success).toBe(true);
    expect(result.action).toBe("EXECUTED");
    expect(result.record?.receipt?.ticket).toBeDefined();
    expect(adapter.placeOrderCalls).toBe(1);
    expect(result.rules).toHaveLength(13);
  });

  it("does not submit the same idempotency key twice", async () => {
    const clock = { now: () => NOW + 60_000 };
    const adapter = new SimulatedExecutionAdapter(
      createQuote(),
      createSpec(),
      {},
      clock,
    );
    const repository = new InMemoryExecutionRepository();
    const idempotency = new InMemoryIdempotencyStore(clock);
    const pipeline = new ExecutionPipeline(
      adapter,
      {},
      repository,
      idempotency,
      undefined,
      clock,
    );
    const request = {
      strategyEvaluation: createStrategyEvaluation(),
      requestedAt: NOW + 60_000,
      idempotencyKey: "same-order",
    };

    const first = await pipeline.execute(request);
    const second = await pipeline.execute(request);

    expect(first.success).toBe(true);
    expect(second.action).toBe("DUPLICATE");
    expect(adapter.placeOrderCalls).toBe(1);
  });
});
