import { describe, expect, it } from "vitest";
import type { ExecutionRecord } from "../src";
import {
  InMemoryExecutionRepository,
  ManagementExecutionService,
  PositionManagementService,
  ReconciliationService,
  SimulatedExecutionAdapter,
  defaultExecutionEngineConfig,
} from "../src";
import {
  NOW,
  createManagementContext,
  createQuote,
  createSpec,
} from "./fixtures";

function normalizedOrder() {
  const original = createManagementContext().plan.order;

  return {
    original,
    symbol: "XAUUSD",
    side: original.side,
    orderType: "MARKET" as const,
    timeInForce: "IOC" as const,
    volume: 0.2,
    requestedPrice: 2400,
    stopLoss: 2395,
    takeProfit: 2411,
    clientOrderId: "management-order",
    idempotencyKey: "management-order",
  };
}

async function createPersistedFixture(
  now = NOW + 90_000,
) {
  const clock = { now: () => now };
  const adapter = new SimulatedExecutionAdapter(
    createQuote(),
    createSpec(),
    {},
    clock,
  );
  const repository = new InMemoryExecutionRepository();
  const order = normalizedOrder();
  const receipt = await adapter.placeOrder(order);

  if (!receipt.position || !receipt.ticket) {
    throw new Error("Position was not created.");
  }

  const record: ExecutionRecord = {
    id: "management-record",
    idempotencyKey: order.idempotencyKey,
    correlationId: "management-correlation",
    strategyAction: "EXECUTE",
    strategyPlan: null,
    order,
    status: "FILLED",
    receipt,
    createdAt: now,
    updatedAt: now,
  };

  await repository.save(record);

  return {
    adapter,
    repository,
    clock,
    record,
    position: receipt.position,
  };
}

describe("ManagementExecutionService", () => {
  it("executes management commands idempotently", async () => {
    const clock = { now: () => NOW + 90_000 };
    const adapter = new SimulatedExecutionAdapter(
      createQuote(),
      createSpec(),
      {},
      clock,
    );

    const orderResult = await adapter.placeOrder(
      normalizedOrder(),
    );
    const position = orderResult.position;

    if (!position) {
      throw new Error("Position was not created.");
    }

    const context = createManagementContext({ position });
    const decision = new PositionManagementService(
      defaultExecutionEngineConfig,
    ).evaluate(context);
    const executor = new ManagementExecutionService(
      adapter,
      clock,
    );

    const first = await executor.execute(decision.commands);
    const second = await executor.execute(decision.commands);

    expect(first.every((item) => item.success)).toBe(true);
    expect(second.every((item) => item.success)).toBe(true);
    expect(adapter.closePositionCalls).toBe(1);
    expect(adapter.modifyPositionCalls).toBe(1);
  });

  it("keeps a partially closed record open and synchronizes remaining volume", async () => {
    const {
      adapter,
      repository,
      clock,
      position,
    } = await createPersistedFixture();

    const executor = new ManagementExecutionService(
      adapter,
      clock,
      repository,
    );

    const [result] = await executor.execute([
      {
        type: "PARTIAL_CLOSE",
        commandId: "partial-1",
        ticket: position.ticket,
        volume: 0.1,
        targetLabel: "TP1",
        reason: "TP1 reached.",
        expiresAt: clock.now() + 30_000,
      },
    ]);

    expect(result?.success).toBe(true);

    const persisted = await repository.findByTicket(
      position.ticket,
    );

    expect(persisted?.status).toBe("FILLED");
    expect(persisted?.receipt?.filledVolume).toBe(0.2);
    expect(persisted?.receipt?.position?.volume).toBeCloseTo(
      0.1,
      8,
    );
    expect(await repository.listOpen()).toHaveLength(1);

    const reconciliation = await new ReconciliationService(
      adapter,
      repository,
      clock,
    ).reconcile("XAUUSD");

    expect(reconciliation.consistent).toBe(true);
  });

  it("marks a fully closed broker position CLOSED and removes it from listOpen", async () => {
    const {
      adapter,
      repository,
      clock,
      position,
    } = await createPersistedFixture();

    const executor = new ManagementExecutionService(
      adapter,
      clock,
      repository,
    );

    const [result] = await executor.execute([
      {
        type: "CLOSE_POSITION",
        commandId: "close-1",
        ticket: position.ticket,
        volume: position.volume,
        reason: "TIME_STOP",
        expiresAt: clock.now() + 30_000,
      },
    ]);

    expect(result?.success).toBe(true);

    const persisted = await repository.findByTicket(
      position.ticket,
    );

    expect(persisted?.status).toBe("CLOSED");
    expect(
      persisted?.receipt?.position?.closedAt,
    ).toBe(clock.now());
    expect(await repository.listOpen()).toHaveLength(0);

    const reconciliation = await new ReconciliationService(
      adapter,
      repository,
      clock,
    ).reconcile("XAUUSD");

    expect(reconciliation.consistent).toBe(true);
  });

  it("synchronizes modified protection into the execution record", async () => {
    const {
      adapter,
      repository,
      clock,
      position,
    } = await createPersistedFixture();

    const executor = new ManagementExecutionService(
      adapter,
      clock,
      repository,
    );

    const [result] = await executor.execute([
      {
        type: "MODIFY_STOP",
        commandId: "modify-1",
        ticket: position.ticket,
        stopLoss: 2398,
        takeProfit: 2412,
        reason: "BREAK_EVEN",
        expiresAt: clock.now() + 30_000,
      },
    ]);

    expect(result?.success).toBe(true);

    const persisted = await repository.findByTicket(
      position.ticket,
    );

    expect(
      persisted?.receipt?.position?.stopLoss,
    ).toBe(2398);
    expect(
      persisted?.receipt?.position?.takeProfit,
    ).toBe(2412);

    const reconciliation = await new ReconciliationService(
      adapter,
      repository,
      clock,
    ).reconcile("XAUUSD");

    expect(reconciliation.consistent).toBe(true);
  });

  it("fails closed when broker mutation succeeds but lifecycle record is missing", async () => {
    const clock = { now: () => NOW + 90_000 };
    const adapter = new SimulatedExecutionAdapter(
      createQuote(),
      createSpec(),
      {},
      clock,
    );
    const repository = new InMemoryExecutionRepository();
    const receipt = await adapter.placeOrder(
      normalizedOrder(),
    );

    if (!receipt.position) {
      throw new Error("Position was not created.");
    }

    const executor = new ManagementExecutionService(
      adapter,
      clock,
      repository,
    );

    const [result] = await executor.execute([
      {
        type: "CLOSE_POSITION",
        commandId: "close-missing-record",
        ticket: receipt.position.ticket,
        volume: receipt.position.volume,
        reason: "HARD_INVALIDATION",
        expiresAt: clock.now() + 30_000,
      },
    ]);

    expect(result?.success).toBe(false);
    expect(result?.message).toContain(
      "lifecycle synchronization failed",
    );
    expect(
      await adapter.getOpenPositions("XAUUSD"),
    ).toHaveLength(0);
  });

  it("keeps lifecycle synchronization idempotent across command replay", async () => {
    const {
      adapter,
      repository,
      clock,
      position,
    } = await createPersistedFixture();

    const executor = new ManagementExecutionService(
      adapter,
      clock,
      repository,
    );

    const command = {
      type: "CLOSE_POSITION" as const,
      commandId: "close-replay",
      ticket: position.ticket,
      volume: position.volume,
      reason: "TIME_STOP" as const,
      expiresAt: clock.now() + 30_000,
    };

    const first = await executor.execute([command]);
    const second = await executor.execute([command]);

    expect(first[0]?.success).toBe(true);
    expect(second[0]?.success).toBe(true);
    expect(adapter.closePositionCalls).toBe(1);

    const persisted = await repository.findByTicket(
      position.ticket,
    );

    expect(persisted?.status).toBe("CLOSED");
    expect(await repository.listOpen()).toHaveLength(0);
  });
});