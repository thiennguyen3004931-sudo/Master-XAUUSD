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

test("zero canonical deals never render realized P&L as $0.00", async () => {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");

    if (req.url?.startsWith("/api/v1/mt5/performance")) {
      res.end(JSON.stringify({ trades: [] }));
      return;
    }

    if (req.url?.startsWith("/api/v1/phase7c-canonical-ledger/position-realized")) {
      res.end(JSON.stringify({
        source: "CANONICAL_MT5_DEAL_LEDGER",
        readOnly: true,
        symbol: "XAUUSD",
        positionId: "ZERO-DEAL-EXIT",
        dealCount: 0,
        realizedNetPnl: 0,
        deals: [],
      }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });

  const address = await listen(server);
  assert.ok(address && typeof address === "object");

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase7c-zero-deal-pnl-"));
  const journalPath = path.join(tempDir, "trend-events.jsonl");
  const statePath = path.join(tempDir, "telegram-state.json");
  const sinkPath = path.join(tempDir, "dry-run-notifications.jsonl");

  fs.writeFileSync(
    journalPath,
    `${JSON.stringify({
      type: "EXIT_EXECUTED",
      timestamp: "2026-08-31T10:00:00.000Z",
      ticket: "ZERO-DEAL-EXIT",
      side: "BUY",
      reason: "ZERO_DEAL_REGRESSION",
    })}\n`,
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

  assert.equal(notifications.length, 1, "EXIT must emit exactly one notification");
  const text = String(notifications[0].text ?? "");
  assert.doesNotMatch(
    text,
    /\$0\.00/,
    "dealCount=0 means realized P&L is unknown, not zero",
  );
  assert.match(
    text,
    /đang đồng bộ MT5 deal canonical/i,
    "zero-deal EXIT must remain pending canonical MT5 synchronization",
  );
});
