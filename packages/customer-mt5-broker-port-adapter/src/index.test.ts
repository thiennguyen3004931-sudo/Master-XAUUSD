import { describe, expect, it } from "vitest";
import type { IMt5BridgeClient } from "@xauusd/mt5-broker";
import { CustomerMt5BrokerPortAdapter } from "./index.js";

function fakeClient(): IMt5BridgeClient & {
  calls: Array<{ kind: string; value: unknown }>;
} {
  const calls: Array<{ kind: string; value: unknown }> = [];

  return {
    calls,
    async health() {
      return {
        status: "ok",
        connected: true,
        tradingEnabled: true,
        terminalTradeAllowed: true,
        expertTradeAllowed: true,
        accountLogin: 770001,
        server: "Broker-Real",
        timestamp: 1,
      };
    },
    async quote(symbol) {
      calls.push({ kind: "quote", value: symbol });
      return {
        symbol,
        brokerSymbol: symbol,
        bid: 4199.5,
        ask: 4200.5,
        spread: 1,
        timestamp: 1,
      };
    },
    async symbolSpec() {
      throw new Error("not used");
    },
    async placeOrder(request) {
      calls.push({ kind: "placeOrder", value: request });
      return {
        accepted: true,
        status: "FILLED",
        ticket: "F10001",
        message: "simulated",
        brokerTimestamp: 1,
        idempotentReplay: false,
      };
    },
    async cancelOrder() {
      throw new Error("not used");
    },
    async closePosition(ticket, volume, commandId) {
      calls.push({
        kind: "closePosition",
        value: { ticket, volume, commandId },
      });
      return {
        commandId,
        success: true,
        message: "simulated",
        executedAt: 1,
        idempotentReplay: false,
      };
    },
    async modifyPosition(ticket, stopLoss, takeProfit, commandId) {
      calls.push({
        kind: "modifyPosition",
        value: { ticket, stopLoss, takeProfit, commandId },
      });
      return {
        commandId,
        success: true,
        message: "simulated",
        executedAt: 1,
        idempotentReplay: false,
      };
    },
    async openPositions(symbol) {
      calls.push({ kind: "openPositions", value: symbol });
      return [
        {
          ticket: "F10001",
          symbol: "XAUUSD",
          brokerSymbol: "XAUUSD",
          side: "LONG",
          volume: 0.12,
          entry: 4200,
          stopLoss: 4190,
          takeProfit: 4220,
          profit: 0,
          swap: 0,
          commission: 0,
        },
      ];
    },
    async pendingOrders() {
      return [];
    },
  };
}

describe("CustomerMt5BrokerPortAdapter", () => {
  it("maps broker health identity and quote to the customer follower port", async () => {
    const client = fakeClient();
    const adapter = new CustomerMt5BrokerPortAdapter(client);

    await expect(adapter.health()).resolves.toEqual({
      connected: true,
      tradingEnabled: true,
      terminalTradeAllowed: true,
      expertTradeAllowed: true,
      accountLogin: 770001,
      server: "Broker-Real",
    });
    await expect(adapter.quote("XAUUSD")).resolves.toEqual({
      bid: 4199.5,
      ask: 4200.5,
    });
  });

  it("forwards only explicit follower mutations to the injected broker client", async () => {
    const client = fakeClient();
    const adapter = new CustomerMt5BrokerPortAdapter(client);

    const request = {
      symbol: "XAUUSD",
      side: "BUY" as const,
      orderType: "MARKET" as const,
      timeInForce: "GTC" as const,
      volume: 0.12,
      requestedPrice: 4200.5,
      stopLoss: 4190,
      takeProfit: 4220,
      deviationPoints: 30,
      magicNumber: 770701,
      comment: "xauusd-copy-follower",
      clientOrderId: "cmd-1",
      idempotencyKey: "cmd-1",
    };

    await adapter.placeOrder(request);
    await adapter.modifyPosition("F10001", 4195, 4220, "cmd-2");
    await adapter.closePosition("F10001", 0.04, "cmd-3");

    expect(client.calls).toEqual([
      { kind: "placeOrder", value: request },
      {
        kind: "modifyPosition",
        value: {
          ticket: "F10001",
          stopLoss: 4195,
          takeProfit: 4220,
          commandId: "cmd-2",
        },
      },
      {
        kind: "closePosition",
        value: {
          ticket: "F10001",
          volume: 0.04,
          commandId: "cmd-3",
        },
      },
    ]);
  });

  it("maps open positions to the minimal customer follower shape", async () => {
    const adapter = new CustomerMt5BrokerPortAdapter(fakeClient());

    await expect(adapter.openPositions("XAUUSD")).resolves.toEqual([
      {
        ticket: "F10001",
        symbol: "XAUUSD",
        volume: 0.12,
        stopLoss: 4190,
        takeProfit: 4220,
        side: "LONG",
      },
    ]);
  });
});
