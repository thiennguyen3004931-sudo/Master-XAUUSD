import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const notifierPath = path.join(scriptsDir, "run-phase7b-telegram-notifier.mjs");

function runNotifier(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [notifierPath], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function recoveryCloseEvent(ticket, eventTimestamp) {
  return {
    type: "MANAGED_POSITION_CLOSED",
    timestamp: eventTimestamp,
    ticket,
    side: "SELL",
    dailyMode: "RECOVERY_TP",
    dailyNetPnlAtEntry: -95.88,
    recoveryTargetNetPnl: 1,
    recoveryTpDistance: 7.85,
    recoveryTakeProfit: 4343.23,
    lastKnownState: {
      entry: 4351.08,
      stopLoss: 4351.08,
      initialVolume: 0.12,
      expectedRemainingVolume: 0.12,
      recoveryTakeProfit: 4343.23,
    },
  };
}

async function runRecoveryCloseScenario({ ticket, eventTimestamp, server }) {
  const address = await listen(server);
  assert.ok(address && typeof address === "object");

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase7c-recovery-close-daily-sync-"));
  const journalPath = path.join(tempDir, "trend-events.jsonl");
  const statePath = path.join(tempDir, "telegram-state.json");
  const sinkPath = path.join(tempDir, "dry-run-notifications.jsonl");

  fs.writeFileSync(
    journalPath,
    `${JSON.stringify(recoveryCloseEvent(ticket, eventTimestamp))}\n`,
    "utf8",
  );

  let result;
  try {
    result = await runNotifier({
      ...process.env,
      ZIQ_TELEGRAM_BOT_TOKEN: "synthetic-token-not-used",
      ZIQ_TELEGRAM_CHAT_ID: "synthetic-chat-not-used",
      ZIQ_TELEGRAM_JOURNAL_PATH: journalPath,
      ZIQ_TELEGRAM_STATE_PATH: statePath,
      ZIQ_TELEGRAM_SYMBOL: "XAUUSD",
      ZIQ_PHASE7C_ACCOUNT_MODE: "LIVE",
      ZIQ_TELEGRAM_INTERVAL_MS: "1000",
      ZIQ_TELEGRAM_REPLAY_EXISTING: "true",
      ZIQ_TELEGRAM_SEND_STARTUP: "false",
      ZIQ_TELEGRAM_ONCE: "true",
      ZIQ_TELEGRAM_DRY_RUN: "true",
      ZIQ_TELEGRAM_DRY_RUN_SINK: sinkPath,
      ZIQ_TELEGRAM_MONITOR_API_URL: `http://127.0.0.1:${address.port}`,
    });
  } finally {
    await close(server);
  }

  assert.equal(
    result.code,
    0,
    `notifier must exit cleanly\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.ok(fs.existsSync(sinkPath), "dry-run notification sink must exist");

  const notifications = fs
    .readFileSync(sinkPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  assert.equal(notifications.length, 1, "Recovery close must emit exactly one notification");
  return String(notifications[0].text ?? "");
}

test("Recovery close refreshes canonical deal before reading Daily P/L", async () => {
  const ticket = "RECOVERY-CLOSE-SYNC-1";
  const eventTimestamp = "2026-09-02T00:08:00.000Z";
  const eventAt = Date.parse(eventTimestamp);
  let canonicalBackfillObserved = false;
  const requestOrder = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.setHeader("content-type", "application/json");

    if (url.pathname === "/api/v1/mt5/performance") {
      requestOrder.push("performance");
      res.end(JSON.stringify({
        trades: [
          {
            id: `LIVE:${ticket}`,
            ownership: "SYSTEM",
            side: "SELL",
            entry: 4351.08,
            exit: 4345.09,
            netPnl: 71.4,
            closedAt: eventAt,
          },
        ],
      }));
      return;
    }

    if (url.pathname === "/api/v1/phase7c-canonical-ledger/position-realized") {
      requestOrder.push("canonical");
      canonicalBackfillObserved = true;
      res.end(JSON.stringify({
        source: "CANONICAL_MT5_DEAL_LEDGER",
        readOnly: true,
        symbol: "XAUUSD",
        positionId: ticket,
        dealCount: 1,
        realizedNetPnl: 71.4,
        deals: [
          {
            ticket: "RECOVERY-CLOSE-DEAL-1",
            positionId: ticket,
            timestamp: eventAt,
            volume: 0.12,
            netPnl: 71.4,
          },
        ],
      }));
      return;
    }

    if (url.pathname === "/api/v1/phase7c/daily-recovery") {
      requestOrder.push(canonicalBackfillObserved ? "daily-fresh" : "daily-stale");
      res.end(JSON.stringify({
        source: "MT5_LIVE_READ_ONLY",
        readOnly: true,
        symbol: "XAUUSD",
        dealCount: canonicalBackfillObserved ? 4 : 3,
        dailyNetPnl: canonicalBackfillObserved ? -24.48 : -95.88,
        dailyMode: "RECOVERY_TP",
      }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });

  const text = await runRecoveryCloseScenario({ ticket, eventTimestamp, server });

  assert.ok(
    requestOrder.indexOf("canonical") >= 0,
    `canonical realized endpoint must be consulted; order=${requestOrder.join(" -> ")}`,
  );
  assert.ok(
    requestOrder.indexOf("daily-fresh") > requestOrder.indexOf("canonical"),
    `Daily Recovery must be read after canonical close backfill; order=${requestOrder.join(" -> ")}`,
  );
  assert.match(text, /P&L lệnh:<\/b> <b>\+\$71\.40<\/b>/);
  assert.match(text, /Daily P\/L sau đóng:<\/b> <b>−\$24\.48<\/b>/);
  assert.doesNotMatch(text, /Daily P\/L sau đóng:<\/b> <b>−\$95\.88<\/b>/);
});

test("Recovery close does not confirm stale Daily P/L while canonical close deal is still missing", async () => {
  const ticket = "RECOVERY-CLOSE-PENDING-1";
  const eventTimestamp = "2026-09-02T00:10:00.000Z";
  const eventAt = Date.parse(eventTimestamp);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.setHeader("content-type", "application/json");

    if (url.pathname === "/api/v1/mt5/performance") {
      res.end(JSON.stringify({
        trades: [
          {
            id: `LIVE:${ticket}`,
            ownership: "SYSTEM",
            side: "SELL",
            entry: 4351.08,
            exit: 4345.09,
            netPnl: 71.4,
            closedAt: eventAt,
          },
        ],
      }));
      return;
    }

    if (url.pathname === "/api/v1/phase7c-canonical-ledger/position-realized") {
      res.end(JSON.stringify({
        source: "CANONICAL_MT5_DEAL_LEDGER",
        readOnly: true,
        symbol: "XAUUSD",
        positionId: ticket,
        dealCount: 0,
        realizedNetPnl: 0,
        deals: [],
      }));
      return;
    }

    if (url.pathname === "/api/v1/phase7c/daily-recovery") {
      res.end(JSON.stringify({
        source: "MT5_LIVE_READ_ONLY",
        readOnly: true,
        symbol: "XAUUSD",
        dealCount: 3,
        dailyNetPnl: -95.88,
        dailyMode: "RECOVERY_TP",
      }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });

  const text = await runRecoveryCloseScenario({ ticket, eventTimestamp, server });

  assert.match(text, /P&L lệnh:<\/b> <b>đang đồng bộ MT5 deal canonical<\/b>/i);
  assert.match(text, /Daily P\/L sau đóng:<\/b> <b>đang đồng bộ MT5 deal canonical<\/b>/i);
  assert.doesNotMatch(text, /Daily P\/L sau đóng:<\/b> <b>−\$95\.88<\/b>/);
});
