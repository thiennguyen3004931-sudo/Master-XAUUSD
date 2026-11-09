import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IMt5BridgeClient } from "@xauusd/mt5-broker";
import { createCustomerFollowerRuntime } from "./index.js";

const roots: string[] = [];

async function tempStateFile() {
  const root = await mkdtemp(path.join(os.tmpdir(), "xauusd-follower-runtime-"));
  roots.push(root);
  return path.join(root, "state", "positions.json");
}

async function removeWithRetry(root: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 8) {
        await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
      }
    }
  }
  throw lastError;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await removeWithRetry(root);
  }
});

function fakeClient(
  identity: { accountLogin?: number; server?: string } = {
    accountLogin: 770001,
    server: "Broker-Real",
  },
): IMt5BridgeClient & {
  calls: Array<{ kind: string; value: unknown }>;
  positions: Array<{
    ticket: string;
    symbol: string;
    brokerSymbol: string;
    side: "LONG" | "SHORT";
    volume: number;
    entry: number;
    stopLoss: number;
    takeProfit: number;
    profit: number;
    swap: number;
    commission: number;
  }>;
} {
  const calls: Array<{ kind: string; value: unknown }> = [];
  const positions: Array<{
    ticket: string;
    symbol: string;
    brokerSymbol: string;
    side: "LONG" | "SHORT";
    volume: number;
    entry: number;
    stopLoss: number;
    takeProfit: number;
    profit: number;
    swap: number;
    commission: number;
  }> = [];

  return {
    calls,
    positions,
    async health() {
      return {
        status: "ok",
        connected: true,
        tradingEnabled: true,
        terminalTradeAllowed: true,
        expertTradeAllowed: true,
        accountLogin: identity.accountLogin,
        server: identity.server,
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
      positions.push({
        ticket: "F20001",
        symbol: request.symbol,
        brokerSymbol: request.symbol,
        side: request.side === "BUY" ? "LONG" : "SHORT",
        volume: request.volume,
        entry: request.requestedPrice,
        stopLoss: request.stopLoss,
        takeProfit: request.takeProfit,
        profit: 0,
        swap: 0,
        commission: 0,
      });
      return {
        accepted: true,
        status: "FILLED",
        ticket: "F20001",
        message: "simulated",
        brokerTimestamp: 1,
        idempotentReplay: false,
      };
    },
    async cancelOrder() {
      throw new Error("not used");
    },
    async modifyPosition(ticket, stopLoss, takeProfit, commandId) {
      calls.push({
        kind: "modifyPosition",
        value: { ticket, stopLoss, takeProfit, commandId },
      });
      const position = positions.find((item) => item.ticket === ticket);
      if (position) {
        position.stopLoss = stopLoss;
        position.takeProfit = takeProfit ?? 0;
      }
      return {
        commandId,
        success: Boolean(position),
        message: position ? "simulated" : "missing",
        executedAt: 1,
        idempotentReplay: false,
      };
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
    async openPositions(symbol) {
      return positions.filter((item) => !symbol || item.symbol === symbol);
    },
    async pendingOrders() {
      return [];
    },
  };
}

describe("createCustomerFollowerRuntime", () => {
  it("composes injected broker, durable state and executor across restart", async () => {
    const stateFile = await tempStateFile();
    const client = fakeClient();

    const first = createCustomerFollowerRuntime({
      client,
      stateFile,
      mt5Login: 770001,
      brokerServer: "Broker-Real",
    });

    await first.executor.execute({
      action: "POSITION_OPEN",
      commandId: "runtime-open-1",
      sequence: 1,
      symbol: "XAUUSD",
      masterPositionRef: "master-runtime-1",
      side: "BUY",
      volume: 0.12,
      stopLoss: 4190,
      takeProfit: 4220,
    });

    const restarted = createCustomerFollowerRuntime({
      client,
      stateFile,
      mt5Login: 770001,
      brokerServer: "Broker-Real",
    });

    await restarted.executor.execute({
      action: "STOP_LOSS_UPDATE",
      commandId: "runtime-sl-2",
      sequence: 2,
      symbol: "XAUUSD",
      masterPositionRef: "master-runtime-1",
      stopLoss: 4195,
    });

    expect(
      client.calls.some(
        (call) =>
          call.kind === "modifyPosition" &&
          (call.value as { ticket: string }).ticket === "F20001",
      ),
    ).toBe(true);
    await expect(
      restarted.registry.get("master-runtime-1"),
    ).resolves.toBe("F20001");
  });

  it("fails closed on injected client identity mismatch before broker mutation", async () => {
    const stateFile = await tempStateFile();
    const client = fakeClient({
      accountLogin: 770999,
      server: "Broker-Real",
    });
    const runtime = createCustomerFollowerRuntime({
      client,
      stateFile,
      mt5Login: 770001,
      brokerServer: "Broker-Real",
    });

    await expect(
      runtime.executor.execute({
        action: "POSITION_OPEN",
        commandId: "runtime-deny-1",
        sequence: 1,
        symbol: "XAUUSD",
        masterPositionRef: "master-deny-1",
        side: "BUY",
        volume: 0.12,
        stopLoss: 4190,
        takeProfit: 4220,
      }),
    ).rejects.toThrow("FOLLOWER_MT5_ACCOUNT_MISMATCH");

    expect(client.calls).toEqual([]);
  });

  it("rejects invalid composition identity and state inputs", async () => {
    const client = fakeClient();

    expect(() =>
      createCustomerFollowerRuntime({
        client,
        stateFile: " state.json",
        mt5Login: 770001,
        brokerServer: "Broker-Real",
      }),
    ).toThrow("stateFile must be a canonical");

    expect(() =>
      createCustomerFollowerRuntime({
        client,
        stateFile: "state.json",
        mt5Login: 0,
        brokerServer: "Broker-Real",
      }),
    ).toThrow("mt5Login must be a positive");

    expect(() =>
      createCustomerFollowerRuntime({
        client,
        stateFile: "state.json",
        mt5Login: 770001,
        brokerServer: " Broker-Real",
      }),
    ).toThrow("brokerServer must be a canonical");
  });
});
