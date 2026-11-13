import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const notifierPath = path.join(scriptsDir, "run-phase7b-telegram-notifier.mjs");
const trendControllerPath = path.join(scriptsDir, "run-phase7b-demo-controller.ts");
const sidewayControllerPath = path.join(scriptsDir, "run-phase7c-sideway-controller.mjs");

const TREND_HOLD = Object.freeze({
  reasonCode: "HOLD_TREND_STRUCTURE_INTACT",
  reason: "GIỮ LỆNH: Cấu trúc xu hướng M15 vẫn còn hiệu lực; chưa có điều kiện thoát lệnh.",
});

function holdEvent({
  ticket = "TICKET-M15",
  timestamp,
  m15CloseTime,
  reasonCode = TREND_HOLD.reasonCode,
  reason = TREND_HOLD.reason,
  side = "BUY",
}) {
  return {
    type: "HOLD_POSITION",
    timestamp,
    m15CloseTime,
    ticket,
    side,
    reasonCode,
    reason,
  };
}

function createFixture(label) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `phase7c-hold-m15-${label}-`));
  return {
    trendJournal: path.join(tempDir, "trend-events.jsonl"),
    sidewayJournal: path.join(tempDir, "sideway-events.jsonl"),
    statePath: path.join(tempDir, "telegram-state.json"),
    sinkPath: path.join(tempDir, "notifications.jsonl"),
  };
}

function appendEvents(file, events) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(
    file,
    events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : ""),
    "utf8",
  );
}

function runNotifier(fixture) {
  if (!fs.existsSync(fixture.trendJournal)) fs.writeFileSync(fixture.trendJournal, "", "utf8");
  if (!fs.existsSync(fixture.sidewayJournal)) fs.writeFileSync(fixture.sidewayJournal, "", "utf8");

  const result = spawnSync(process.execPath, [notifierPath], {
    env: {
      ...process.env,
      ZIQ_TELEGRAM_BOT_TOKEN: "synthetic-token-not-used",
      ZIQ_TELEGRAM_CHAT_ID: "synthetic-chat-not-used",
      ZIQ_TELEGRAM_JOURNAL_PATH: fixture.trendJournal,
      ZIQ_TELEGRAM_SIDEWAY_JOURNAL_PATH: fixture.sidewayJournal,
      ZIQ_TELEGRAM_STATE_PATH: fixture.statePath,
      ZIQ_TELEGRAM_SYMBOL: "XAUUSD",
      ZIQ_PHASE7C_ACCOUNT_MODE: "DEMO",
      ZIQ_TELEGRAM_REPLAY_EXISTING: "true",
      ZIQ_TELEGRAM_SEND_STARTUP: "false",
      ZIQ_TELEGRAM_ONCE: "true",
      ZIQ_TELEGRAM_DRY_RUN: "true",
      ZIQ_TELEGRAM_DRY_RUN_SINK: fixture.sinkPath,
      ZIQ_TELEGRAM_MONITOR_API_URL: "http://127.0.0.1:9",
    },
    encoding: "utf8",
    timeout: 30_000,
  });

  assert.equal(
    result.status,
    0,
    [
      "notifier synthetic process must exit cleanly",
      `stdout=${result.stdout}`,
      `stderr=${result.stderr}`,
    ].join("\n"),
  );

  return result;
}

function notifications(fixture) {
  if (!fs.existsSync(fixture.sinkPath)) return [];
  return fs
    .readFileSync(fixture.sinkPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function persistedState(fixture) {
  return JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
}

test("HOLD Telegram sends at most once inside one M15 candle and sends again on the next M15 candle", () => {
  const fixture = createFixture("next-candle");
  const firstM15 = 1787961600000;
  const nextM15 = firstM15 + 15 * 60_000;

  appendEvents(fixture.trendJournal, [
    holdEvent({
      timestamp: "2026-08-29T02:40:01.000Z",
      m15CloseTime: firstM15,
    }),
    holdEvent({
      timestamp: "2026-08-29T02:41:01.000Z",
      m15CloseTime: firstM15,
    }),
    holdEvent({
      timestamp: "2026-08-29T02:55:01.000Z",
      m15CloseTime: nextM15,
    }),
  ]);

  runNotifier(fixture);

  const sent = notifications(fixture);
  assert.equal(
    sent.length,
    2,
    "same ticket/reason must be suppressed only within the same M15 candle, not forever",
  );

  const state = persistedState(fixture);
  assert.equal(Number(state?.hold?.lastM15CloseTime), nextM15);
});

test("HOLD Telegram dedupe survives notifier restart for the same M15 candle", () => {
  const fixture = createFixture("restart-same-candle");
  const m15CloseTime = 1787961600000;

  appendEvents(fixture.trendJournal, [
    holdEvent({
      timestamp: "2026-08-29T02:40:01.000Z",
      m15CloseTime,
    }),
  ]);
  runNotifier(fixture);
  assert.equal(notifications(fixture).length, 1);

  appendEvents(fixture.trendJournal, [
    holdEvent({
      timestamp: "2026-08-29T02:41:01.000Z",
      m15CloseTime,
    }),
  ]);
  runNotifier(fixture);

  assert.equal(
    notifications(fixture).length,
    1,
    "restart must not resend a HOLD already sent for the same ticket/reason/M15 candle",
  );
});

function holdJournalBlocks(source) {
  const marker = 'journal("HOLD_POSITION", {';
  const blocks = [];
  let cursor = 0;

  while (true) {
    const start = source.indexOf(marker, cursor);
    if (start < 0) break;
    const end = source.indexOf("});", start);
    assert.notEqual(end, -1, "HOLD_POSITION journal block must terminate");
    blocks.push(source.slice(start, end + 3));
    cursor = end + 3;
  }

  return blocks;
}

for (const [name, controllerPath] of [
  ["Trend", trendControllerPath],
  ["Sideway", sidewayControllerPath],
]) {
  test(`${name} HOLD_POSITION producer stamps canonical M15 candle identity`, () => {
    const source = fs.readFileSync(controllerPath, "utf8");
    const blocks = holdJournalBlocks(source);

    assert.ok(blocks.length >= 2, `${name} must expose normal and recovery HOLD paths`);
    for (const block of blocks) {
      assert.match(
        block,
        /m15CloseTime\s*:/,
        `${name} HOLD_POSITION must carry m15CloseTime so downstream dedupe is candle-scoped`,
      );
    }
  });
}

test("HOLD M15 replacement fully removes superseded legacy dedupe state and process-memory keys", () => {
  const notifier = fs.readFileSync(notifierPath, "utf8");
  const trend = fs.readFileSync(trendControllerPath, "utf8");
  const sideway = fs.readFileSync(sidewayControllerPath, "utf8");

  assert.match(notifier, /holdM15ByTicketReason/, "notifier must retain restart-safe M15 dedupe state");
  assert.match(trend, /lastHoldM15Key/, "Trend must retain persisted M15 HOLD key");
  assert.match(sideway, /lastHoldM15Key/, "Sideway must retain persisted M15 HOLD key");

  assert.doesNotMatch(
    notifier,
    /\bholdSentKeys\b/,
    "legacy notifier holdSentKeys state must be removed after M15 replacement is GREEN",
  );
  assert.doesNotMatch(
    trend,
    /\blastHoldObservationKey\b/,
    "legacy Trend process-memory HOLD dedupe must be removed after persisted M15 replacement is GREEN",
  );
  assert.doesNotMatch(
    sideway,
    /\blastHoldObservationKey\b/,
    "legacy Sideway process-memory HOLD dedupe must be removed after persisted M15 replacement is GREEN",
  );
});
