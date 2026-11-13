# @xauusd/execution-engine

Execution orchestration for XAUUSD AI MASTER.

Pack 08 receives an `EXECUTE` plan from `@xauusd/strategy-engine`, performs a fail-closed preflight, and then delegates broker operations through `IExecutionAdapter`.

## Responsibilities

- Strategy-plan validation and expiry enforcement
- Idempotency and duplicate-order prevention
- Quote freshness, spread and slippage checks
- Broker symbol-spec normalization
- Volume-step and price-tick normalization
- Stop-loss and take-profit distance checks
- Execution-rate limiting
- Order lifecycle persistence
- Partial take-profit command generation
- Break-even and ATR trailing-stop command generation
- Time-stop and hard-invalidation closure
- Position reconciliation

## Safety boundary

This package does **not** contain MT5 credentials or a live broker implementation. Pack 09 must implement `IExecutionAdapter`.

The included `SimulatedExecutionAdapter` is only for tests, demos and local smoke validation.

## Basic execution

```ts
import {
  ExecutionPipeline,
  InMemoryExecutionRepository,
  InMemoryIdempotencyStore,
} from "@xauusd/execution-engine";

const pipeline = new ExecutionPipeline(
  brokerAdapter,
  {
    maxSlippageTicks: 50,
    maxExecutionsPerMinute: 10,
  },
  new InMemoryExecutionRepository(),
  new InMemoryIdempotencyStore(),
);

const result = await pipeline.execute({
  strategyEvaluation,
  requestedAt: Date.now(),
});

if (result.success && result.record?.receipt?.ticket) {
  // Persist the ticket and start the management loop.
}
```

## Position management

```ts
const decision = positionManagementService.evaluate({
  plan,
  position,
  quote,
  spec,
  atr,
  state,
  evaluatedAt: Date.now(),
});

await managementExecutionService.execute(decision.commands);
```

Every management command has its own `commandId`. The broker adapter must treat command IDs idempotently.

## Build

```bash
pnpm --filter @xauusd/execution-engine typecheck
pnpm --filter @xauusd/execution-engine build
pnpm --filter @xauusd/execution-engine test
```
