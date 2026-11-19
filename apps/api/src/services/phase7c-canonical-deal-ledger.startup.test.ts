import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  phase7CCanonicalDealLedgerStatePath,
  warmPhase7CCanonicalDealLedgerOnStartup,
} from "./phase7c-canonical-deal-ledger.service";

const DAY_MS = 24 * 60 * 60 * 1000;
const BROKER_NOW = Date.UTC(2026, 7, 29, 12, 0, 0);

function telemetry() {
  return {
    enabled: true,
    configured: true,
    reachable: true,
    status: "HEALTHY",
    message: "synthetic connected",
    latencyMs: 1,
    bridgeBaseUrl: "http://127.0.0.1:9",
    accountLogin: 10001,
    health: {
      status: "ok",
      connected: true,
      tradingEnabled: true,
      terminalTradeAllowed: true,
      expertTradeAllowed: true,
      accountMode: "real",
      accountBalance: 5000,
      accountEquity: 5000,
      accountMargin: 0,
      accountFreeMargin: 5000,
      accountProfit: 0,
      accountLeverage: 100,
      accountCurrency: "USD",
      server: "DBGMarkets-Live",
      lastError: null,
      reconnecting: false,
      reconnectCount: 0,
      lastReconnectAt: null,
    },
    quote: {
      symbol: "XAUUSD",
      bid: 4700,
      ask: 4700.2,
      spread: 0.2,
      timestamp: BROKER_NOW,
    },
    spec: null,
    positions: [],
    checkedAt: BROKER_NOW,
  } as any;
}

function liveState() {
  return {
    version: 1,
    accountMode: "LIVE",
    liveExecutionEnabled: true,
    envFile: null,
    updatedAt: null,
    updatedBy: "synthetic",
    valid: true,
    source: "RUNTIME_STATE",
    error: null,
  } as any;
}

function deal(ticket: string, timestamp: number) {
  return {
    ticket,
    orderId: `O-${ticket}`,
    positionId: "P-STARTUP",
    symbol: "XAUUSD",
    side: "BUY",
    entry: "OUT",
    volume: 0.04,
    price: 4705,
    profit: ticket === "OLDER" ? 2 : 10,
    commission: -1,
    swap: -0.5,
    fee: -0.25,
    netPnl: 999,
    magic: 270715,
    comment: "phase7c-startup-test",
    timestamp,
    isTradingDeal: true,
  } as any;
}

test("startup warm-backfill persists canonical deals, restores after restart, and accepts older history idempotently", async () => {
  const originalRuntimeRoot = process.env.PHASE7C_RUNTIME_ROOT;
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "phase7c-ledger-startup-a-"));
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "phase7c-ledger-startup-b-"));
  const newer = deal("NEWER", BROKER_NOW - 60_000);
  const older = deal("OLDER", BROKER_NOW - 2 * DAY_MS);
  let history = [newer];
  const requestedWindows: Array<{ fromMs: number; toMs: number; symbol?: string }> = [];

  const deps = {
    telemetryReader: async () => telemetry(),
    accountModeReader: () => liveState(),
    historyReader: async (fromMs: number, toMs: number, symbol?: string) => {
      requestedWindows.push({ fromMs, toMs, symbol });
      return history;
    },
  };

  try {
    process.env.PHASE7C_RUNTIME_ROOT = rootA;
    const first = await warmPhase7CCanonicalDealLedgerOnStartup(deps);
    assert.equal(first.status, "BACKFILLED");
    assert.equal(first.inserted, 1);
    assert.equal(first.total, 1);
    assert.equal(first.fromMs, BROKER_NOW - 365 * DAY_MS);
    assert.equal(first.toMs, BROKER_NOW);

    const firstState = JSON.parse(fs.readFileSync(phase7CCanonicalDealLedgerStatePath(), "utf8"));
    assert.equal(firstState.deals.length, 1);
    assert.equal(firstState.deals[0].ticket, "NEWER");
    assert.equal(firstState.deals[0].account, "REAL:DBGMarkets-Live:10001");
    assert.equal(firstState.deals[0].netPnl, 8.25, "canonical netPnl must ignore bridge-provided netPnl=999");

    const replay = await warmPhase7CCanonicalDealLedgerOnStartup(deps);
    assert.equal(replay.inserted, 0);
    assert.equal(replay.total, 1);

    // Switch to another runtime root so the process cache opens another ledger,
    // then return to rootA to simulate a restart/restore of the original durable file.
    process.env.PHASE7C_RUNTIME_ROOT = rootB;
    history = [];
    await warmPhase7CCanonicalDealLedgerOnStartup(deps);

    process.env.PHASE7C_RUNTIME_ROOT = rootA;
    history = [newer, older, newer];
    const restarted = await warmPhase7CCanonicalDealLedgerOnStartup(deps);
    assert.equal(restarted.status, "BACKFILLED");
    assert.equal(restarted.inserted, 1, "restart backfill must insert only the newly discovered older ticket");
    assert.equal(restarted.total, 2);

    const restoredState = JSON.parse(fs.readFileSync(phase7CCanonicalDealLedgerStatePath(), "utf8"));
    assert.deepEqual(
      restoredState.deals.map((item: any) => item.ticket),
      ["OLDER", "NEWER"],
      "older history must merge after newer history without a timestamp cursor",
    );
    assert.equal(new Set(restoredState.deals.map((item: any) => item.ticket)).size, 2);
    assert.ok(requestedWindows.length >= 4);
    for (const window of requestedWindows) {
      assert.equal(window.fromMs, BROKER_NOW - 365 * DAY_MS);
      assert.equal(window.toMs, BROKER_NOW);
      assert.equal(window.symbol, "XAUUSD");
    }
  } finally {
    if (originalRuntimeRoot === undefined) delete process.env.PHASE7C_RUNTIME_ROOT;
    else process.env.PHASE7C_RUNTIME_ROOT = originalRuntimeRoot;
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  }
});

test("startup warm-backfill skips account mismatch without reading deal history", async () => {
  let historyCalls = 0;
  const result = await warmPhase7CCanonicalDealLedgerOnStartup({
    telemetryReader: async () => telemetry(),
    accountModeReader: () => ({ ...liveState(), accountMode: "DEMO", liveExecutionEnabled: false }),
    historyReader: async () => {
      historyCalls += 1;
      return [];
    },
  });

  assert.equal(result.status, "SKIPPED");
  assert.equal(result.reason, "ACCOUNT_MODE_MISMATCH");
  assert.equal(historyCalls, 0);
});
