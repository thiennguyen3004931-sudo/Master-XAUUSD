import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { transformPhase7CSemiTrendRuntimeSource } from "./phase7c-semi-trend-runtime-source-adapter.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const notifierPath = path.join(scriptsDir, "run-phase7b-telegram-notifier.mjs");
const controllerPath = path.join(scriptsDir, "run-phase7b-demo-controller.ts");

async function runNotifier(events, label) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `phase7c-entry-resolution-${label}-`));
  const journalPath = path.join(tempDir, "trend.jsonl");
  const statePath = path.join(tempDir, "state.json");
  const sinkPath = path.join(tempDir, "sink.jsonl");

  fs.writeFileSync(
    journalPath,
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );

  const child = spawn(process.execPath, [notifierPath], {
    env: {
      ...process.env,
      ZIQ_TELEGRAM_BOT_TOKEN: "synthetic-token-not-used",
      ZIQ_TELEGRAM_CHAT_ID: "synthetic-chat-not-used",
      ZIQ_TELEGRAM_JOURNAL_PATH: journalPath,
      ZIQ_TELEGRAM_STATE_PATH: statePath,
      ZIQ_TELEGRAM_SYMBOL: "XAUUSD",
      ZIQ_PHASE7C_ACCOUNT_MODE: "LIVE",
      ZIQ_TELEGRAM_REPLAY_EXISTING: "true",
      ZIQ_TELEGRAM_SEND_STARTUP: "false",
      ZIQ_TELEGRAM_ONCE: "true",
      ZIQ_TELEGRAM_DRY_RUN: "true",
      ZIQ_TELEGRAM_DRY_RUN_SINK: sinkPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  assert.equal(status, 0, `notifier failed\nstdout=${stdout}\nstderr=${stderr}`);

  return fs.existsSync(sinkPath)
    ? fs.readFileSync(sinkPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    : [];
}

test("accepted-but-not-yet-resolved is transient on Telegram and recovered fill is canonical", async () => {
  const notifications = await runNotifier([
    {
      type: "ENTRY_SUBMIT",
      timestamp: "2026-09-14T08:04:35.000Z",
      side: "SELL",
      pattern: "ENGULFING",
      signalEntry: 4315.95,
      stopLoss: 4322.93,
      stopDistance: 6.98,
      volume: 0.12,
      fvgConfirmedAtEntry: false,
    },
    {
      type: "ENTRY_ACCEPTED_POSITION_PENDING_RESOLUTION",
      timestamp: "2026-09-14T08:04:35.200Z",
      ticket: "ORDER-1",
      fillPrice: 4315.95,
    },
    {
      type: "ENTRY_FILLED",
      timestamp: "2026-09-14T08:04:37.000Z",
      recoveredFromPending: true,
      fvgConfirmedAtEntry: false,
      position: {
        ticket: "POSITION-1",
        side: "SHORT",
        entry: 4315.95,
        stopLoss: 4322.93,
        volume: 0.12,
      },
    },
  ], "transient-recovery");

  assert.equal(notifications.length, 2);
  assert.match(notifications[0].text, /SELL PENDING/);
  assert.match(notifications[0].text, /CHỜ MT5 XÁC NHẬN/);
  assert.doesNotMatch(notifications[0].text, /CHƯA VÀO MT5/);
  assert.doesNotMatch(notifications[0].text, /Position chưa resolve/i);
  assert.match(notifications[1].text, /SELL FILLED/);
  assert.match(notifications[1].text, /POSITION-1/);
});

test("only actual pending-entry expiry produces the unresolved operator warning", async () => {
  const notifications = await runNotifier([
    {
      type: "PENDING_ENTRY_EXPIRED_NO_POSITION",
      timestamp: "2026-09-14T08:05:35.000Z",
      orderId: "ORDER-EXPIRED-1",
      brokerTicket: "BROKER-EXPIRED-1",
      ageMs: 60000,
    },
    {
      type: "ENTRY_ACCEPTED_POSITION_NOT_RESOLVED",
      timestamp: "2026-09-14T08:05:35.001Z",
      message: "Position không resolve sau 60 giây",
      orderId: "ORDER-EXPIRED-1",
      ticket: "BROKER-EXPIRED-1",
      ageMs: 60000,
    },
  ], "expiry");

  assert.equal(notifications.length, 1);
  assert.match(notifications[0].text, /ENTRY/i);
  assert.match(notifications[0].text, /Position không resolve sau 60 giây/i);
});

test("Trend runtime adapter converts transient unresolved state into recoverable lifecycle", () => {
  const legacySource = fs.readFileSync(controllerPath, "utf8");
  const source = transformPhase7CSemiTrendRuntimeSource(legacySource);

  assert.match(source, /journal\("ENTRY_ACCEPTED_POSITION_PENDING_RESOLUTION"/);
  assert.equal(
    (source.match(/journal\("ENTRY_ACCEPTED_POSITION_NOT_RESOLVED"/g) ?? []).length,
    1,
    "the only Telegram-visible unresolved marker must be the post-timeout warning",
  );
  assert.match(source, /message: "Position không resolve sau 60 giây"/);
  assert.match(source, /fvgConfirmedAtEntry: pending\.fvgConfirmedAtEntry \?\? false/);

  const recoveryStart = source.indexOf('journal("PENDING_ENTRY_RECOVERED"');
  assert.notEqual(recoveryStart, -1, "pending recovery audit event must exist");

  const recoveryWindow = source.slice(recoveryStart, recoveryStart + 2200);
  assert.match(
    recoveryWindow,
    /journal\("ENTRY_FILLED"/,
    "recovered pending position must emit the same canonical fill lifecycle event as immediate resolution",
  );
  assert.match(recoveryWindow, /recoveredFromPending: true/);
});

test("Trend runtime adapter accepts CRLF source from Windows checkout", () => {
  const canonicalSource = fs.readFileSync(controllerPath, "utf8");
  const windowsSource = canonicalSource.replace(/\r?\n/g, "\r\n");
  const source = transformPhase7CSemiTrendRuntimeSource(windowsSource);

  assert.match(source, /SEMI_MANUAL_POSITION_ADOPTED/);
  assert.match(source, /journal\("ENTRY_ACCEPTED_POSITION_PENDING_RESOLUTION"/);
  assert.match(source, /recoveredFromPending: true/);
});


test("runtime transform attaches pending and unresolved events to the correct lifecycle blocks", () => {
  const legacySource = fs.readFileSync(controllerPath, "utf8");
  const source = transformPhase7CSemiTrendRuntimeSource(legacySource);

  assert.match(
    source,
    /if \(!opened\) \{[\s\S]*?journal\("ENTRY_ACCEPTED_POSITION_PENDING_RESOLUTION"/,
    "accepted-but-not-yet-visible position must remain a transient pending event",
  );
  assert.match(
    source,
    /journal\("PENDING_ENTRY_EXPIRED_NO_POSITION"[\s\S]*?journal\("ENTRY_ACCEPTED_POSITION_NOT_RESOLVED"/,
    "only the actual pending-entry expiry block may emit the unresolved warning",
  );
});

test("accepted Trend position recovery uses exact MT5 magic/comment provenance before broker-normalized prices", () => {
  const controllerSource = fs.readFileSync(controllerPath, "utf8");
  const gatewayPath = path.join(
    scriptsDir,
    "..",
    "packages",
    "mt5-broker",
    "bridge",
    "mt5_bridge",
    "mt5_gateway.py",
  );
  const gatewaySource = fs.readFileSync(gatewayPath, "utf8");

  const matcherStart = controllerSource.indexOf("function matchPendingTrendPosition(");
  const matcherEnd = controllerSource.indexOf("function managedFromPending(", matcherStart);
  assert.notEqual(matcherStart, -1, "pending-position matcher must exist");
  assert.notEqual(matcherEnd, -1, "managed-from-pending boundary must exist");
  const matcher = controllerSource.slice(matcherStart, matcherEnd);

  assert.match(matcher, /PENDING_MAGIC_MISMATCH/);
  assert.match(matcher, /PENDING_COMMENT_MISMATCH/);
  assert.match(matcher, /PENDING_POSITION_MATCHED_BY_BROKER_PROVENANCE/);
  assert.match(matcher, /phase7CBrokerComment\(pending\.orderId\)/);
  assert.ok(
    matcher.indexOf("PENDING_POSITION_MATCHED_BY_BROKER_PROVENANCE") <
      matcher.indexOf("const priceTolerance"),
    "exact bot provenance must resolve ownership before SL/TP normalization checks",
  );

  assert.match(gatewaySource, /"magic": int\(getattr\(row, "magic"/);
  assert.match(gatewaySource, /"comment": str\(getattr\(row, "comment"/);
  assert.match(gatewaySource, /expected_magic = int\(request\.magicNumber\)/);
  assert.match(gatewaySource, /expected_comment = self\._comment\(request\.clientOrderId\)/);
});

test("pending Trend recovery matches the broker TP actually sent when fixed TP is enabled", () => {
  const source = fs.readFileSync(controllerPath, "utf8");
  const matcherStart = source.indexOf("function matchPendingTrendPosition(");
  const matcherEnd = source.indexOf("function managedFromPending(", matcherStart);

  assert.notEqual(matcherStart, -1, "pending-position matcher must exist");
  assert.notEqual(matcherEnd, -1, "managed-from-pending boundary must exist");

  const matcher = source.slice(matcherStart, matcherEnd);

  assert.match(
    matcher,
    /pending\.fixedTpEnabled[\s\S]*pending\.fixedTpPrice[\s\S]*pending\.takeProfit/,
    "fixed-TP recovery must derive the broker TP expectation from the same fixed-TP snapshot used for order submission",
  );
  assert.match(
    matcher,
    /position\.takeProfit\s*-\s*expectedTakeProfit/,
    "pending-position TP comparison must use the derived broker TP expectation",
  );
});
