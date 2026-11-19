import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IMt5BridgeClient } from "@xauusd/mt5-broker";
import {
  bindCustomerFollowerRuntime,
  type CustomerMt5BridgeClientFactory,
} from "./index.js";

const roots: string[] = [];

async function tempStateFile() {
  const root = await mkdtemp(path.join(os.tmpdir(), "xauusd-mt5-binding-"));
  roots.push(root);
  return path.join(root, "state", "positions.json");
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      try {
        await rm(root, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 8) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
      }
    }
  }
});

function fakeClient(): IMt5BridgeClient {
  return {
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
      return {
        accepted: true,
        status: "FILLED",
        ticket: "F30001",
        message: "simulated",
        brokerTimestamp: 1,
        idempotentReplay: false,
      };
    },
    async cancelOrder() {
      throw new Error("not used");
    },
    async closePosition(_ticket, _volume, commandId) {
      return {
        commandId,
        success: true,
        message: "simulated",
        executedAt: 1,
        idempotentReplay: false,
      };
    },
    async modifyPosition(_ticket, _stopLoss, _takeProfit, commandId) {
      return {
        commandId,
        success: true,
        message: "simulated",
        executedAt: 1,
        idempotentReplay: false,
      };
    },
    async openPositions() {
      return [];
    },
    async pendingOrders() {
      return [];
    },
  };
}

describe("bindCustomerFollowerRuntime", () => {
  it("creates runtime only after validating a loopback binding spec", async () => {
    const stateFile = await tempStateFile();
    const calls: unknown[] = [];
    const factory: CustomerMt5BridgeClientFactory = {
      create(spec) {
        calls.push(spec);
        return fakeClient();
      },
    };

    const runtime = bindCustomerFollowerRuntime(
      {
        bridgeBaseUrl: "http://127.0.0.1:8765",
        credentialRef: "windows-credential:xauusd-customer-001",
        mt5Login: 770001,
        brokerServer: "Broker-Real",
        stateFile,
      },
      factory,
    );

    expect(calls).toEqual([
      {
        bridgeBaseUrl: "http://127.0.0.1:8765",
        credentialRef: "windows-credential:xauusd-customer-001",
      },
    ]);
    await expect(runtime.bridge.health()).resolves.toMatchObject({
      connected: true,
      accountLogin: 770001,
      server: "Broker-Real",
    });
  });

  it("rejects remote or credential-bearing bridge URLs before client creation", async () => {
    const calls: unknown[] = [];
    const factory: CustomerMt5BridgeClientFactory = {
      create(spec) {
        calls.push(spec);
        return fakeClient();
      },
    };

    expect(() =>
      bindCustomerFollowerRuntime(
        {
          bridgeBaseUrl: "https://bridge.example.com:8765",
          credentialRef: "cred-1",
          mt5Login: 770001,
          brokerServer: "Broker-Real",
          stateFile: "state.json",
        },
        factory,
      ),
    ).toThrow("bridgeBaseUrl must target loopback only");

    expect(() =>
      bindCustomerFollowerRuntime(
        {
          bridgeBaseUrl: "http://user:secret@127.0.0.1:8765",
          credentialRef: "cred-1",
          mt5Login: 770001,
          brokerServer: "Broker-Real",
          stateFile: "state.json",
        },
        factory,
      ),
    ).toThrow("bridgeBaseUrl must not embed credentials");

    expect(calls).toEqual([]);
  });

  it("rejects invalid identity or credential references before client creation", async () => {
    const calls: unknown[] = [];
    const factory: CustomerMt5BridgeClientFactory = {
      create(spec) {
        calls.push(spec);
        return fakeClient();
      },
    };

    expect(() =>
      bindCustomerFollowerRuntime(
        {
          bridgeBaseUrl: "http://localhost:8765",
          credentialRef: " cred-1",
          mt5Login: 770001,
          brokerServer: "Broker-Real",
          stateFile: "state.json",
        },
        factory,
      ),
    ).toThrow("credentialRef must be a canonical");

    expect(() =>
      bindCustomerFollowerRuntime(
        {
          bridgeBaseUrl: "http://localhost:8765",
          credentialRef: "cred-1",
          mt5Login: 0,
          brokerServer: "Broker-Real",
          stateFile: "state.json",
        },
        factory,
      ),
    ).toThrow("mt5Login must be a positive");

    expect(calls).toEqual([]);
  });
});
