import { describe, expect, it } from "vitest";
import type { CustomerFollowerExecutionRequest } from "./follower-execution.js";
import {
  CustomerMt5FollowerExecutor,
  InMemoryCustomerFollowerPositionRegistry,
  type CustomerMt5BridgePort,
} from "./mt5-follower-executor.js";

function bridge(): CustomerMt5BridgePort & {
  calls: Array<{ kind: string; value: unknown }>;
  positions: Array<{
    ticket: string;
    symbol: string;
    volume: number;
    stopLoss: number;
    takeProfit: number;
    side?: "LONG" | "SHORT";
  }>;
} {
  const calls: Array<{ kind: string; value: unknown }> = [];
  const positions: Array<{
    ticket: string;
    symbol: string;
    volume: number;
    stopLoss: number;
    takeProfit: number;
    side?: "LONG" | "SHORT";
  }> = [];
  return {
    calls,
    positions,
    async health() {
      return {
        connected: true,
        tradingEnabled: true,
        terminalTradeAllowed: true,
        expertTradeAllowed: true,
        accountLogin: 770001,
        server: "Broker-Real",
      };
    },
    async quote() {
      return { bid: 4199.5, ask: 4200.5 };
    },
    async placeOrder(request) {
      calls.push({ kind: "placeOrder", value: request });
      positions.push({
        ticket: "9001",
        side: request.side === "BUY" ? "LONG" : "SHORT",
        symbol: request.symbol,
        volume: request.volume,
        stopLoss: request.stopLoss,
        takeProfit: request.takeProfit,
      });
      return {
        accepted: true,
        status: "FILLED",
        ticket: "9001",
        message: "ok",
      };
    },
    async modifyPosition(ticket, stopLoss, takeProfit, commandId) {
      calls.push({
        kind: "modifyPosition",
        value: { ticket, stopLoss, takeProfit, commandId },
      });
      const position = positions.find((item) => item.ticket === ticket);
      if (!position) return { success: false, message: "missing" };
      position.stopLoss = stopLoss;
      position.takeProfit = takeProfit ?? 0;
      return { success: true };
    },
    async closePosition(ticket, volume, commandId) {
      calls.push({
        kind: "closePosition",
        value: { ticket, volume, commandId },
      });
      const position = positions.find((item) => item.ticket === ticket);
      if (!position) return { success: false, message: "missing" };
      if (volume >= position.volume) {
        positions.splice(positions.indexOf(position), 1);
      } else {
        position.volume -= volume;
      }
      return { success: true };
    },
    async openPositions(symbol) {
      return positions.filter((item) => !symbol || item.symbol === symbol);
    },
  };
}

const openRequest: CustomerFollowerExecutionRequest = {
  action: "POSITION_OPEN",
  commandId: "cmd-open-1",
  sequence: 1,
  symbol: "XAUUSD",
  masterPositionRef: "master-1",
  side: "BUY",
  volume: 0.12,
  stopLoss: 4190,
  takeProfit: 4220,
};

describe("CustomerMt5FollowerExecutor", () => {
  it("opens once with command idempotency and binds the follower ticket", async () => {
    const port = bridge();
    const registry = new InMemoryCustomerFollowerPositionRegistry();
    const executor = new CustomerMt5FollowerExecutor(port, registry, {
      expectedMt5Login: 770001,
      expectedBrokerServer: "Broker-Real",
      reconcileAttempts: 2,
      reconcileDelayMs: 0,
    });

    await executor.execute(openRequest);

    expect(port.calls[0]).toMatchObject({
      kind: "placeOrder",
      value: {
        symbol: "XAUUSD",
        side: "BUY",
        orderType: "MARKET",
        volume: 0.12,
        requestedPrice: 4200.5,
        clientOrderId: "cmd-open-1",
        idempotencyKey: "cmd-open-1",
      },
    });
    expect(await registry.get("master-1")).toBe("9001");

    await expect(executor.execute(openRequest)).rejects.toThrow(
      "FOLLOWER_POSITION_ALREADY_BOUND",
    );
  });

  it("updates SL/TP, partially closes, then fully closes by bound ticket", async () => {
    const port = bridge();
    const registry = new InMemoryCustomerFollowerPositionRegistry();
    const executor = new CustomerMt5FollowerExecutor(port, registry, {
      expectedMt5Login: 770001,
      expectedBrokerServer: "Broker-Real",
      reconcileAttempts: 2,
      reconcileDelayMs: 0,
    });

    await executor.execute(openRequest);
    await executor.execute({
      action: "STOP_LOSS_UPDATE",
      commandId: "cmd-sl-2",
      sequence: 2,
      symbol: "XAUUSD",
      masterPositionRef: "master-1",
      stopLoss: 4201,
    });
    await executor.execute({
      action: "TAKE_PROFIT_UPDATE",
      commandId: "cmd-tp-3",
      sequence: 3,
      symbol: "XAUUSD",
      masterPositionRef: "master-1",
      takeProfit: 4230,
    });
    await executor.execute({
      action: "PARTIAL_CLOSE",
      commandId: "cmd-pc-4",
      sequence: 4,
      symbol: "XAUUSD",
      masterPositionRef: "master-1",
      volume: 0.04,
    });
    await executor.execute({
      action: "POSITION_CLOSE",
      commandId: "cmd-close-5",
      sequence: 5,
      symbol: "XAUUSD",
      masterPositionRef: "master-1",
    });

    expect(port.positions).toHaveLength(0);
    expect(await registry.get("master-1")).toBeUndefined();
    expect(port.calls.filter((call) => call.kind === "modifyPosition")).toHaveLength(2);
    expect(port.calls.filter((call) => call.kind === "closePosition")).toHaveLength(2);
  });

  it("fails closed when MT5 health or binding evidence is missing", async () => {
    const disconnected = bridge();
    disconnected.health = async () => ({
      connected: false,
      tradingEnabled: false,
      terminalTradeAllowed: false,
      expertTradeAllowed: false,
    });
    const executor = new CustomerMt5FollowerExecutor(
      disconnected,
      new InMemoryCustomerFollowerPositionRegistry(),
      {
        expectedMt5Login: 770001,
        expectedBrokerServer: "Broker-Real",
        reconcileAttempts: 2,
        reconcileDelayMs: 0,
      },
    );

    await expect(executor.execute(openRequest)).rejects.toThrow(
      "FOLLOWER_MT5_DISCONNECTED",
    );

    const connected = bridge();
    const noBindingExecutor = new CustomerMt5FollowerExecutor(
      connected,
      new InMemoryCustomerFollowerPositionRegistry(),
      {
        expectedMt5Login: 770001,
        expectedBrokerServer: "Broker-Real",
        reconcileAttempts: 2,
        reconcileDelayMs: 0,
      },
    );
    await expect(
      noBindingExecutor.execute({
        action: "POSITION_SNAPSHOT",
        commandId: "cmd-snapshot",
        sequence: 2,
        symbol: "XAUUSD",
        masterPositionRef: "missing",
      }),
    ).rejects.toThrow("FOLLOWER_POSITION_BINDING_MISSING");
  });

  it("fails closed when bridge account or server identity does not match", async () => {
    const wrongAccount = bridge();
    wrongAccount.health = async () => ({
      connected: true,
      tradingEnabled: true,
      terminalTradeAllowed: true,
      expertTradeAllowed: true,
      accountLogin: 770002,
      server: "Broker-Real",
    });
    const wrongAccountExecutor = new CustomerMt5FollowerExecutor(
      wrongAccount,
      new InMemoryCustomerFollowerPositionRegistry(),
      {
        expectedMt5Login: 770001,
        expectedBrokerServer: "Broker-Real",
        reconcileAttempts: 2,
        reconcileDelayMs: 0,
      },
    );
    await expect(wrongAccountExecutor.execute(openRequest)).rejects.toThrow(
      "FOLLOWER_MT5_ACCOUNT_MISMATCH",
    );
    expect(wrongAccount.calls).toHaveLength(0);

    const wrongServer = bridge();
    wrongServer.health = async () => ({
      connected: true,
      tradingEnabled: true,
      terminalTradeAllowed: true,
      expertTradeAllowed: true,
      accountLogin: 770001,
      server: "Broker-Other",
    });
    const wrongServerExecutor = new CustomerMt5FollowerExecutor(
      wrongServer,
      new InMemoryCustomerFollowerPositionRegistry(),
      {
        expectedMt5Login: 770001,
        expectedBrokerServer: "Broker-Real",
        reconcileAttempts: 2,
        reconcileDelayMs: 0,
      },
    );
    await expect(wrongServerExecutor.execute(openRequest)).rejects.toThrow(
      "FOLLOWER_MT5_SERVER_MISMATCH",
    );
    expect(wrongServer.calls).toHaveLength(0);
  });

  it("retains accepted ticket ownership when the position is not yet confirmed open", async () => {
    const port = bridge();
    port.placeOrder = async (request) => {
      port.calls.push({ kind: "placeOrder", value: request });
      return {
        accepted: true,
        status: "FILLED",
        ticket: "9001",
        message: "accepted but not visible",
      };
    };
    const registry = new InMemoryCustomerFollowerPositionRegistry();
    const executor = new CustomerMt5FollowerExecutor(port, registry, {
      expectedMt5Login: 770001,
      expectedBrokerServer: "Broker-Real",
      reconcileAttempts: 2,
      reconcileDelayMs: 0,
    });

    await expect(executor.execute(openRequest)).rejects.toThrow(
      "FOLLOWER_POSITION_OPEN_NOT_CONFIRMED",
    );
    await expect(registry.get("master-1")).resolves.toBe("9001");
  });

  it("accepts delayed position visibility within the reconciliation window", async () => {
    const port = bridge();
    const registry = new InMemoryCustomerFollowerPositionRegistry();
    let polls = 0;

    port.placeOrder = async (request) => {
      port.calls.push({ kind: "placeOrder", value: request });
      port.positions.push({
        ticket: "9001",
        symbol: request.symbol,
        volume: request.volume,
        stopLoss: request.stopLoss,
        takeProfit: request.takeProfit,
      });
      return {
        accepted: true,
        status: "FILLED",
        ticket: "9001",
        message: "ok",
      };
    };
    port.openPositions = async (symbol) => {
      polls += 1;
      if (polls === 1) return [];
      return port.positions.filter((item) => !symbol || item.symbol === symbol);
    };

    const executor = new CustomerMt5FollowerExecutor(port, registry, {
      expectedMt5Login: 770001,
      expectedBrokerServer: "Broker-Real",
      reconcileAttempts: 2,
      reconcileDelayMs: 0,
    });

    await executor.execute(openRequest);

    expect(polls).toBe(2);
    await expect(registry.get("master-1")).resolves.toBe("9001");
  });

  it("keeps ownership when a full close is not confirmed", async () => {
    const port = bridge();
    const registry = new InMemoryCustomerFollowerPositionRegistry();
    const executor = new CustomerMt5FollowerExecutor(port, registry, {
      expectedMt5Login: 770001,
      expectedBrokerServer: "Broker-Real",
      reconcileAttempts: 2,
      reconcileDelayMs: 0,
    });

    await executor.execute(openRequest);
    port.closePosition = async (ticket, volume, commandId) => {
      port.calls.push({
        kind: "closePosition",
        value: { ticket, volume, commandId },
      });
      return { success: true };
    };

    await expect(
      executor.execute({
        action: "POSITION_CLOSE",
        commandId: "cmd-close-unconfirmed",
        sequence: 2,
        symbol: "XAUUSD",
        masterPositionRef: "master-1",
      }),
    ).rejects.toThrow("FOLLOWER_POSITION_CLOSE_NOT_CONFIRMED");

    await expect(registry.get("master-1")).resolves.toBe("9001");
  });

  it("waits through a stale partial-close snapshot until remaining volume matches", async () => {
    const port = bridge();
    const registry = new InMemoryCustomerFollowerPositionRegistry();
    const executor = new CustomerMt5FollowerExecutor(port, registry, {
      expectedMt5Login: 770001,
      expectedBrokerServer: "Broker-Real",
      reconcileAttempts: 3,
      reconcileDelayMs: 0,
    });

    await executor.execute(openRequest);

    let partialPolls = 0;
    const originalOpenPositions = port.openPositions.bind(port);
    port.closePosition = async (ticket, volume, commandId) => {
      port.calls.push({
        kind: "closePosition",
        value: { ticket, volume, commandId },
      });
      return { success: true };
    };
    port.openPositions = async (symbol) => {
      partialPolls += 1;
      if (partialPolls === 1) {
        return originalOpenPositions(symbol);
      }
      const position = port.positions.find((item) => item.ticket === "9001");
      if (position) position.volume = 0.08;
      return originalOpenPositions(symbol);
    };

    await executor.execute({
      action: "PARTIAL_CLOSE",
      commandId: "cmd-partial-delayed",
      sequence: 2,
      symbol: "XAUUSD",
      masterPositionRef: "master-1",
      volume: 0.04,
    });

    expect(partialPolls).toBe(2);
    expect(port.positions[0]?.volume).toBe(0.08);
  });

  it("rejects a partial close when remaining broker volume is not reconciled", async () => {
    const port = bridge();
    const registry = new InMemoryCustomerFollowerPositionRegistry();
    const executor = new CustomerMt5FollowerExecutor(port, registry, {
      expectedMt5Login: 770001,
      expectedBrokerServer: "Broker-Real",
      reconcileAttempts: 2,
      reconcileDelayMs: 0,
    });

    await executor.execute(openRequest);
    port.closePosition = async (ticket, volume, commandId) => {
      port.calls.push({
        kind: "closePosition",
        value: { ticket, volume, commandId },
      });
      return { success: true };
    };

    await expect(
      executor.execute({
        action: "PARTIAL_CLOSE",
        commandId: "cmd-partial-unreconciled",
        sequence: 2,
        symbol: "XAUUSD",
        masterPositionRef: "master-1",
        volume: 0.04,
      }),
    ).rejects.toThrow("FOLLOWER_PARTIAL_CLOSE_VOLUME_MISMATCH");
  });

  it("rejects invalid partial-close volume without sending a broker mutation", async () => {
    const port = bridge();
    const registry = new InMemoryCustomerFollowerPositionRegistry();
    const executor = new CustomerMt5FollowerExecutor(port, registry, {
      expectedMt5Login: 770001,
      expectedBrokerServer: "Broker-Real",
      reconcileAttempts: 2,
      reconcileDelayMs: 0,
    });

    await executor.execute(openRequest);
    const before = port.calls.length;

    await expect(
      executor.execute({
        action: "PARTIAL_CLOSE",
        commandId: "cmd-bad-partial",
        sequence: 2,
        symbol: "XAUUSD",
        masterPositionRef: "master-1",
        volume: 0.12,
      }),
    ).rejects.toThrow("FOLLOWER_PARTIAL_CLOSE_VOLUME_INVALID");

    expect(port.calls).toHaveLength(before);
  });
  it("rejects unsafe stop loosening for both LONG and SHORT before broker mutation", async () => {
    for (const [side, original, unsafe, safe] of [
      ["LONG", 4190, 4180, 4195],
      ["SHORT", 4210, 4220, 4205],
    ] as const) {
      const port = bridge();
      port.positions.push({ ticket: "9001", symbol: "XAUUSD", side, volume: 0.12, stopLoss: original, takeProfit: 4220 });
      const registry = new InMemoryCustomerFollowerPositionRegistry();
      await registry.set("master-1", "9001");
      const executor = new CustomerMt5FollowerExecutor(port, registry, {
        expectedMt5Login: 770001, expectedBrokerServer: "Broker-Real",
        reconcileAttempts: 1, reconcileDelayMs: 0,
      });
      const request = (stopLoss: number): CustomerFollowerExecutionRequest => ({
        action: "STOP_LOSS_UPDATE", commandId: "sl-risk", sequence: 2,
        symbol: "XAUUSD", masterPositionRef: "master-1", stopLoss,
      });
      await expect(executor.execute(request(unsafe))).rejects.toThrow("FOLLOWER_STOP_LOSS_RISK_INCREASE");
      expect(port.calls).toHaveLength(0);
      await executor.execute(request(safe));
      expect(port.calls.filter((call) => call.kind === "modifyPosition")).toHaveLength(1);
    }
  });

  it("fails closed if the broker side or existing stop is unreliable", async () => {
    for (const position of [
      { ticket: "9001", symbol: "XAUUSD", volume: 0.12, stopLoss: 4190, takeProfit: 4220 },
      { ticket: "9001", symbol: "XAUUSD", side: "LONG" as const, volume: 0.12, stopLoss: Number.NaN, takeProfit: 4220 },
    ]) {
      const port = bridge();
      port.positions.push(position);
      const registry = new InMemoryCustomerFollowerPositionRegistry();
      await registry.set("master-1", "9001");
      const executor = new CustomerMt5FollowerExecutor(port, registry, {
        expectedMt5Login: 770001, expectedBrokerServer: "Broker-Real",
        reconcileAttempts: 1, reconcileDelayMs: 0,
      });
      await expect(executor.execute({
        action: "STOP_LOSS_UPDATE", commandId: "sl-unknown", sequence: 2,
        symbol: "XAUUSD", masterPositionRef: "master-1", stopLoss: 4195,
      })).rejects.toThrow("FOLLOWER_STOP_LOSS_RISK_UNKNOWN");
      expect(port.calls).toHaveLength(0);
    }
  });

  it("allows initial protection when broker position has no stop", async () => {
    const port = bridge();
    port.positions.push({ ticket: "9001", symbol: "XAUUSD", side: "LONG", volume: 0.12, stopLoss: 0, takeProfit: 4220 });
    const registry = new InMemoryCustomerFollowerPositionRegistry();
    await registry.set("master-1", "9001");
    const executor = new CustomerMt5FollowerExecutor(port, registry, {
      expectedMt5Login: 770001, expectedBrokerServer: "Broker-Real",
      reconcileAttempts: 1, reconcileDelayMs: 0,
    });
    await executor.execute({
      action: "STOP_LOSS_UPDATE", commandId: "first-sl", sequence: 2,
      symbol: "XAUUSD", masterPositionRef: "master-1", stopLoss: 4195,
    });
    expect(port.calls.filter((call) => call.kind === "modifyPosition")).toHaveLength(1);
  });

});
