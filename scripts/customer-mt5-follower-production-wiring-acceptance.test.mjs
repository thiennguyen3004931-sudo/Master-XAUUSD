import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { signCopyCommand } from "../packages/copy-protocol/dist/index.js";
import {
  CustomerCopyCommandVerifier,
  CustomerFollowerExecutionAdapter,
  CustomerMt5FollowerExecutor,
  InMemoryCustomerFollowerPositionRegistry,
} from "../packages/customer-agent/dist/index.js";
import { FileCustomerFollowerPositionRegistry } from "../packages/customer-follower-state/dist/index.js";

async function removeWithRetry(root) {
  let lastError;
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

const NOW = 100_000_000;

test("signed COPY_FOLLOWER command reaches simulated MT5 bridge through production wiring chain", async () => {
  const pair = generateKeyPairSync("ed25519");
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();

  const positions = [];
  const mutations = [];

  const bridge = {
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
      mutations.push({ action: "OPEN", request });
      positions.push({
        ticket: "F90001",
        symbol: request.symbol,
        volume: request.volume,
        stopLoss: request.stopLoss,
        takeProfit: request.takeProfit,
      });
      return { accepted: true, status: "FILLED", ticket: "F90001", message: "simulated" };
    },
    async modifyPosition(ticket, stopLoss, takeProfit, commandId) {
      mutations.push({ action: "MODIFY", ticket, stopLoss, takeProfit, commandId });
      return { success: true };
    },
    async closePosition(ticket, volume, commandId) {
      mutations.push({ action: "CLOSE", ticket, volume, commandId });
      return { success: true };
    },
    async openPositions(symbol) {
      return positions.filter((position) => !symbol || position.symbol === symbol);
    },
  };

  const verifier = new CustomerCopyCommandVerifier(
    {
      licenseId: "license-prod-wire-001",
      installationId: "install-prod-wire-001",
      mt5Login: 770001,
      brokerServer: "Broker-Real",
      allowedSymbols: ["XAUUSD"],
    },
    new Map([["master-key-prod-wire", publicKey]]),
    { now: () => NOW },
  );

  const executor = new CustomerMt5FollowerExecutor(
    bridge,
    new InMemoryCustomerFollowerPositionRegistry(),
    {
      expectedMt5Login: 770001,
      expectedBrokerServer: "Broker-Real",
    },
  );
  const adapter = new CustomerFollowerExecutionAdapter(executor);

  const command = signCopyCommand(
    {
      version: 1,
      commandId: "prod-wire-open-001",
      sequence: 1,
      licenseId: "license-prod-wire-001",
      installationId: "install-prod-wire-001",
      mt5Login: 770001,
      brokerServer: "Broker-Real",
      symbol: "XAUUSD",
      action: "POSITION_OPEN",
      payload: {
        side: "BUY",
        volume: 0.12,
        stopLoss: 4190,
        takeProfit: 4220,
      },
      masterPositionRef: "master-prod-wire-001",
      issuedAt: NOW - 100,
      expiresAt: NOW + 30_000,
      keyId: "master-key-prod-wire",
    },
    privateKey,
  );

  const decision = verifier.accept(command);
  assert.equal(decision.ok, true);

  const result = await adapter.dispatch(decision);
  assert.equal(result.ok, true);
  assert.equal(result.code, "FORWARDED_TO_EXECUTOR");
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].action, "OPEN");
  assert.equal(mutations[0].request.idempotencyKey, "prod-wire-open-001");
  assert.equal(mutations[0].request.symbol, "XAUUSD");
  assert.equal(mutations[0].request.volume, 0.12);

  assert.deepEqual(verifier.accept(command), {
    ok: false,
    code: "REPLAYED_COMMAND",
  });
});

test("production wiring remains simulated and source-only", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile("packages/customer-agent/src/mt5-follower-executor.ts", "utf8"),
  );

  for (const forbidden of [
    "@xauusd/mt5-broker",
    "node:child_process",
    "MetaTrader5",
    "order_send",
    "127.0.0.1",
    "localhost",
  ]) {
    assert.equal(
      source.includes(forbidden),
      false,
      "production wiring source contains forbidden direct LIVE integration marker: " + forbidden,
    );
  }
});


test("durable follower registry survives executor restart in simulated production wiring", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xauusd-follower-wiring-"));
  const stateFile = path.join(root, "state", "positions.json");

  const positions = [{
    ticket: "F91001",
    symbol: "XAUUSD",
    side: "LONG",
    volume: 0.12,
    stopLoss: 4190,
    takeProfit: 4220,
  }];
  const mutations = [];

  const bridge = {
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
    async placeOrder() {
      throw new Error("unexpected OPEN after restart");
    },
    async modifyPosition(ticket, stopLoss, takeProfit, commandId) {
      mutations.push({ action: "MODIFY", ticket, stopLoss, takeProfit, commandId });
      const position = positions.find((item) => item.ticket === ticket);
      if (position) {
        position.stopLoss = stopLoss;
        position.takeProfit = takeProfit;
      }
      return { success: true };
    },
    async closePosition() {
      throw new Error("unexpected CLOSE");
    },
    async openPositions(symbol) {
      return positions.filter((position) => !symbol || position.symbol === symbol);
    },
  };

  try {
    const firstRegistry = new FileCustomerFollowerPositionRegistry(stateFile);
    await firstRegistry.set("master-restart-001", "F91001");

    const restartedRegistry = new FileCustomerFollowerPositionRegistry(stateFile);
    const restartedExecutor = new CustomerMt5FollowerExecutor(
      bridge,
      restartedRegistry,
      {
        expectedMt5Login: 770001,
        expectedBrokerServer: "Broker-Real",
      },
    );

    await restartedExecutor.execute({
      commandId: "restart-sl-001",
      symbol: "XAUUSD",
      action: "STOP_LOSS_UPDATE",
      masterPositionRef: "master-restart-001",
      stopLoss: 4195,
    });

    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].ticket, "F91001");
    assert.equal(mutations[0].stopLoss, 4195);
    assert.equal(
      await restartedRegistry.get("master-restart-001"),
      "F91001",
    );
  } finally {
    await removeWithRetry(root);
  }
});


test("production wiring rejects simulated MT5 identity mismatch before mutation", async () => {
  const mutations = [];
  const bridge = {
    async health() {
      return {
        connected: true,
        tradingEnabled: true,
        terminalTradeAllowed: true,
        expertTradeAllowed: true,
        accountLogin: 770999,
        server: "Broker-Real",
      };
    },
    async quote() {
      mutations.push("QUOTE");
      return { bid: 4199.5, ask: 4200.5 };
    },
    async placeOrder() {
      mutations.push("OPEN");
      throw new Error("must not reach placeOrder");
    },
    async modifyPosition() {
      mutations.push("MODIFY");
      throw new Error("must not reach modifyPosition");
    },
    async closePosition() {
      mutations.push("CLOSE");
      throw new Error("must not reach closePosition");
    },
    async openPositions() {
      mutations.push("POSITIONS");
      return [];
    },
  };

  const executor = new CustomerMt5FollowerExecutor(
    bridge,
    new InMemoryCustomerFollowerPositionRegistry(),
    {
      expectedMt5Login: 770001,
      expectedBrokerServer: "Broker-Real",
    },
  );

  await assert.rejects(
    executor.execute({
      action: "POSITION_OPEN",
      commandId: "identity-deny-001",
      sequence: 1,
      symbol: "XAUUSD",
      masterPositionRef: "master-identity-deny-001",
      side: "BUY",
      volume: 0.12,
      stopLoss: 4190,
      takeProfit: 4220,
    }),
    /FOLLOWER_MT5_ACCOUNT_MISMATCH/,
  );
  assert.deepEqual(mutations, []);
});


test("accepted follower OPEN is not bound until broker position is reconciled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xauusd-follower-open-reconcile-"));
  const stateFile = path.join(root, "state", "positions.json");
  const registry = new FileCustomerFollowerPositionRegistry(stateFile);
  const mutations = [];

  const bridge = {
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
      mutations.push({ action: "OPEN", request });
      return {
        accepted: true,
        status: "FILLED",
        ticket: "F92001",
        message: "accepted but not visible",
      };
    },
    async modifyPosition() {
      throw new Error("unexpected MODIFY");
    },
    async closePosition() {
      throw new Error("unexpected CLOSE");
    },
    async openPositions() {
      return [];
    },
  };

  try {
    const executor = new CustomerMt5FollowerExecutor(bridge, registry, {
      expectedMt5Login: 770001,
      expectedBrokerServer: "Broker-Real",
      reconcileAttempts: 2,
      reconcileDelayMs: 0,
    });

    await assert.rejects(
      executor.execute({
        action: "POSITION_OPEN",
        commandId: "open-reconcile-deny-001",
        sequence: 1,
        symbol: "XAUUSD",
        masterPositionRef: "master-open-reconcile-001",
        side: "BUY",
        volume: 0.12,
        stopLoss: 4190,
        takeProfit: 4220,
      }),
      /FOLLOWER_POSITION_OPEN_NOT_CONFIRMED/,
    );

    assert.equal(mutations.length, 1);
    assert.equal(
      await registry.get("master-open-reconcile-001"),
      "F92001",
    );
  } finally {
    await removeWithRetry(root);
  }
});

test("follower ownership is retained until broker CLOSE is reconciled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xauusd-follower-close-reconcile-"));
  const stateFile = path.join(root, "state", "positions.json");
  const registry = new FileCustomerFollowerPositionRegistry(stateFile);
  await registry.set("master-close-reconcile-001", "F93001");

  const positions = [{
    ticket: "F93001",
    symbol: "XAUUSD",
    volume: 0.12,
    stopLoss: 4190,
    takeProfit: 4220,
  }];

  const bridge = {
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
    async placeOrder() {
      throw new Error("unexpected OPEN");
    },
    async modifyPosition() {
      throw new Error("unexpected MODIFY");
    },
    async closePosition() {
      return { success: true };
    },
    async openPositions(symbol) {
      return positions.filter((position) => !symbol || position.symbol === symbol);
    },
  };

  try {
    const executor = new CustomerMt5FollowerExecutor(bridge, registry, {
      expectedMt5Login: 770001,
      expectedBrokerServer: "Broker-Real",
      reconcileAttempts: 2,
      reconcileDelayMs: 0,
    });

    await assert.rejects(
      executor.execute({
        action: "POSITION_CLOSE",
        commandId: "close-reconcile-deny-001",
        sequence: 2,
        symbol: "XAUUSD",
        masterPositionRef: "master-close-reconcile-001",
      }),
      /FOLLOWER_POSITION_CLOSE_NOT_CONFIRMED/,
    );

    assert.equal(
      await registry.get("master-close-reconcile-001"),
      "F93001",
    );
  } finally {
    await removeWithRetry(root);
  }
});
