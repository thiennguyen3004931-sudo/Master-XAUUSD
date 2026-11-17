import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const notifierPath = path.join(scriptsDir, "run-phase7b-telegram-notifier.mjs");

const reversalLifecycleEvents = [
  {
    type: "ENTRY_FILLED",
    timestamp: "2026-10-05T13:30:00.000Z",
    entryPolicy: "REVERSAL_CHOCH_PATTERN_STRUCTURE_NO_SUPERTREND",
    reversalContext: {
      direction: "BULLISH",
      side: "BUY",
      chochTimestamp: 1791206100000,
      level: 4138.5,
    },
    position: {
      ticket: "REVERSAL-SYNTHETIC-1",
      side: "LONG",
      entry: 4147.27,
      stopLoss: 4137.07,
      volume: 0.12,
    },
    fvgConfirmedAtEntry: false,
  },
];

const lifecycleEvents = [
  {
    type: "ENTRY_FILLED",
    timestamp: "2026-08-26T04:00:00.000Z",
    position: {
      ticket: "SYNTHETIC-1",
      side: "LONG",
      entry: 4700,
      stopLoss: 4692,
      volume: 0.12,
    },
    fvgConfirmedAtEntry: false,
  },
  {
    type: "FVG_HOLD_CONFIRMED",
    timestamp: "2026-08-26T04:01:00.000Z",
    ticket: "SYNTHETIC-1",
    side: "BUY",
    favorable: 4,
    stopLoss: 4692,
    m15CloseTime: 1787716860000,
  },
  {
    type: "PLUS6_SL_TO_ENTRY",
    timestamp: "2026-08-26T04:02:00.000Z",
    ticket: "SYNTHETIC-1",
    side: "BUY",
    favorable: 6,
    stopLoss: 4700,
  },
  {
    type: "PLUS10_PARTIAL_ONE_THIRD",
    timestamp: "2026-08-26T04:03:00.000Z",
    ticket: "SYNTHETIC-1",
    side: "BUY",
    favorable: 10,
    stopLoss: 4700,
    closedVolume: 0.04,
    remainingVolume: 0.08,
  },
  {
    type: "EXIT_EXECUTED",
    timestamp: "2026-08-26T04:04:00.000Z",
    ticket: "SYNTHETIC-1",
    side: "BUY",
    reason: "TEST_SYNTHETIC_EXIT",
  },
];

const sidewayLifecycleEvents = [
  {
    type: "ENTRY_FILLED",
    timestamp: "2026-08-26T05:00:00.000Z",
    position: {
      ticket: "SIDEWAY-SYNTHETIC-1",
      side: "LONG",
      entry: 4700,
      stopLoss: 4692,
      takeProfit: 4720,
      volume: 0.12,
    },
    management: {
      side: "BUY",
      entry: 4700,
      initialVolume: 0.12,
      expectedRemainingVolume: 0.12,
      stopLoss: 4692,
      tp1: 4710,
      tp1Kind: "FIXED_PLUS_10",
      tp2: 4720,
      breakEvenApplied: false,
      partialApplied: false,
      dailyMode: "NORMAL",
    },
  },
  {
    type: "PLUS6_SL_TO_ENTRY",
    timestamp: "2026-08-26T05:01:00.000Z",
    ticket: "SIDEWAY-SYNTHETIC-1",
    side: "BUY",
    favorable: 6,
    stopLoss: 4700,
  },
  {
    type: "PLUS10_PARTIAL_ONE_THIRD",
    timestamp: "2026-08-26T05:02:00.000Z",
    ticket: "SIDEWAY-SYNTHETIC-1",
    side: "BUY",
    favorable: 10,
    stopLoss: 4700,
    closedVolume: 0.04,
    remainingVolume: 0.08,
  },
  {
    type: "POSITION_CLOSED",
    timestamp: "2026-08-26T05:03:00.000Z",
    ticket: "SIDEWAY-SYNTHETIC-1",
    side: "BUY",
    reason: "TP2_OPPOSITE_RANGE",
  },
];

const sidewayRecoveryEvents = [
  {
    type: "ENTRY_FILLED",
    timestamp: "2026-08-26T06:00:00.000Z",
    position: {
      ticket: "SIDEWAY-RECOVERY-1",
      side: "LONG",
      entry: 4700,
      stopLoss: 4692,
      takeProfit: 4708,
      volume: 0.12,
    },
    management: {
      side: "BUY",
      entry: 4700,
      initialVolume: 0.12,
      expectedRemainingVolume: 0.12,
      stopLoss: 4692,
      tp1: 4710,
      tp2: 4708,
      dailyMode: "RECOVERY_TP",
      recoveryTpDistance: 8,
      recoveryTakeProfit: 4708,
    },
    dailyMode: "RECOVERY_TP",
    dailyNetPnlAtEntry: -4,
    recoveryTargetNetPnl: 1,
    recoveryTpDistance: 8,
    recoveryTakeProfit: 4708,
  },
  {
    type: "PLUS6_SL_TO_ENTRY",
    timestamp: "2026-08-26T06:01:00.000Z",
    ticket: "SIDEWAY-RECOVERY-1",
    side: "BUY",
    favorable: 6,
    stopLoss: 4700,
    dailyMode: "RECOVERY_TP",
  },
];

const recoveryZeroPlaceholderEvents = [
  {
    type: "ENTRY_FILLED",
    timestamp: "2026-08-26T07:00:00.000Z",
    position: {
      ticket: "RECOVERY-ZERO-1",
      side: "SHORT",
      entry: 0,
      stopLoss: 0,
      takeProfit: 0,
      volume: 0,
    },
    management: {
      side: "SELL",
      entry: 4435.5,
      initialVolume: 0.03,
      expectedRemainingVolume: 0.03,
      stopLoss: 4443.5,
      dailyMode: "RECOVERY_TP",
      recoveryTpDistance: 10.49,
      recoveryTakeProfit: 4425.01,
      tp2: 4425.01,
    },
    dailyMode: "RECOVERY_TP",
    dailyNetPnlAtEntry: -30,
    recoveryTargetNetPnl: 1,
    recoveryTpDistance: 10.49,
    recoveryTakeProfit: 0,
  },
  {
    type: "FVG_HOLD_CONFIRMED",
    timestamp: "2026-08-26T07:01:00.000Z",
    ticket: "RECOVERY-ZERO-1",
    side: "SELL",
    position: {
      entry: 0,
      stopLoss: 0,
      takeProfit: 0,
      volume: 0,
    },
    stopLoss: 0,
    favorable: 3.5,
    recoveryTakeProfit: 0,
    management: {
      entry: 4435.5,
      stopLoss: 4443.5,
      expectedRemainingVolume: 0.03,
      recoveryTakeProfit: 4425.01,
      tp2: 4425.01,
      dailyMode: "RECOVERY_TP",
    },
    dailyMode: "RECOVERY_TP",
    m15CloseTime: 1787727660000,
  },
];

const rejectedEntryEvents = [
  {
    type: "ENTRY_SUBMIT",
    timestamp: "2026-08-26T10:00:00.000Z",
    side: "SELL",
    pattern: "M15_BEARISH_ENGULFING",
    signalEntry: 4720,
    stopLoss: 4728,
    stopDistance: 8,
    volume: 0.12,
  },
  {
    type: "ENTRY_REJECTED",
    timestamp: "2026-08-26T10:00:00.200Z",
    side: "SELL",
    message: "ARM_FILE_MISSING",
    reason: "ARM_FILE_MISSING",
    retcode: 423,
  },
];

function runJournal(accountMode, events, label, journalSource = "TREND") {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `phase7c-trade-notifier-${label}-${accountMode.toLowerCase()}-`),
  );
  const trendJournalPath = path.join(tempDir, "trend-events.jsonl");
  const sidewayJournalPath = path.join(tempDir, "sideway-events.jsonl");
  const statePath = path.join(tempDir, "telegram-state.json");
  const sinkPath = path.join(tempDir, "dry-run-notifications.jsonl");

  const serialized = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  fs.writeFileSync(
    trendJournalPath,
    journalSource === "TREND" ? serialized : "",
    "utf8",
  );
  fs.writeFileSync(
    sidewayJournalPath,
    journalSource === "SIDEWAY" ? serialized : "",
    "utf8",
  );

  const result = spawnSync(process.execPath, [notifierPath], {
    env: {
      ...process.env,
      ZIQ_TELEGRAM_BOT_TOKEN: "synthetic-token-not-used",
      ZIQ_TELEGRAM_CHAT_ID: "synthetic-chat-not-used",
      ZIQ_TELEGRAM_JOURNAL_PATH: trendJournalPath,
      ZIQ_TELEGRAM_SIDEWAY_JOURNAL_PATH: sidewayJournalPath,
      ZIQ_TELEGRAM_STATE_PATH: statePath,
      ZIQ_TELEGRAM_SYMBOL: "XAUUSD",
      ZIQ_PHASE7C_ACCOUNT_MODE: accountMode,
      ZIQ_TELEGRAM_INTERVAL_MS: "1000",
      ZIQ_TELEGRAM_REPLAY_EXISTING: "true",
      ZIQ_TELEGRAM_SEND_STARTUP: "false",
      ZIQ_TELEGRAM_ONCE: "true",
      ZIQ_TELEGRAM_DRY_RUN: "true",
      ZIQ_TELEGRAM_DRY_RUN_SINK: sinkPath,
      ZIQ_TELEGRAM_MONITOR_API_URL: "http://127.0.0.1:9",
    },
    encoding: "utf8",
    timeout: 30_000,
  });

  assert.equal(
    result.status,
    0,
    `notifier process must exit cleanly in synthetic once mode\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.ok(
    fs.existsSync(sinkPath),
    `synthetic dry-run sink must be created; stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );

  const notifications = fs
    .readFileSync(sinkPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  assert.match(result.stdout, /PHASE7B_TELEGRAM_ORDER_PERMISSION=NONE_READ_ONLY_JOURNAL_AND_MONITOR/);
  assert.doesNotMatch(result.stdout + result.stderr, /\/v1\/orders/);

  return notifications;
}

function runLifecycle(accountMode) {
  const notifications = runJournal(accountMode, lifecycleEvents, "lifecycle");

  assert.equal(notifications.length, 5, "ENTRY → HOLD → BE → partial → EXIT must emit exactly five trade notifications");

  const expectedFragments = [
    "FILLED",
    "HOLD",
    "+6 → BE",
    "CHỐT 1/3",
    "CHỐT LỆNH",
  ];

  for (let index = 0; index < expectedFragments.length; index += 1) {
    assert.equal(notifications[index].route, "trade", `notification ${index + 1} must use the trade route`);
    assert.match(notifications[index].text, new RegExp(expectedFragments[index].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    if (index === 1) {
      assert.doesNotMatch(notifications[index].text, /PHASE 7C ·/);
    } else {
      assert.ok(
        notifications[index].text.includes(`PHASE 7C · ${accountMode}`),
        `notification ${index + 1} must display PHASE 7C · ${accountMode}`,
      );
    }
  }

  return notifications;
}

test("LIVE synthetic journal lifecycle uses production notifier with PHASE 7C · LIVE", () => {
  runLifecycle("LIVE");
});

test("DEMO synthetic journal lifecycle uses production notifier with PHASE 7C · DEMO", () => {
  runLifecycle("DEMO");
});

test("REVERSAL entry Telegram displays REVERSAL instead of hard-coded TREND", () => {
  const notifications = runJournal(
    "LIVE",
    reversalLifecycleEvents,
    "reversal-regime-label",
    "TREND",
  );

  assert.equal(notifications.length, 1);
  assert.match(notifications[0].text, /Regime:<\/b> <b>REVERSAL<\/b>/i);
  assert.doesNotMatch(notifications[0].text, /Regime:<\/b> <b>TREND<\/b>/i);
});

test("Sideway lifecycle is ENTRY → +6 BE → +10 close one-third → TP2 exit with canonical events", () => {
  const notifications = runJournal(
    "LIVE",
    sidewayLifecycleEvents,
    "sideway-lifecycle",
    "SIDEWAY",
  );

  assert.equal(
    notifications.length,
    4,
    "Sideway canonical lifecycle must emit ENTRY, +6 BE, +10 partial, and EXIT",
  );
  assert.match(notifications[0].text, /SIDEWAY FILLED/);
  assert.match(notifications[0].text, /\+6 → BE/);
  assert.match(notifications[0].text, /\+10 → chốt 1\/3/i);
  assert.match(notifications[0].text, /SL không dưới BE/i);
  assert.match(notifications[0].text, /TP2 biên đối diện/i);
  assert.doesNotMatch(notifications[0].text, /TP1 → chốt 1\/3 → BE/i);
  assert.match(notifications[1].text, /\+6 → BE/);
  assert.match(notifications[2].text, /CHỐT 1\/3/);
  assert.match(notifications[3].text, /CHỐT LỆNH|CLOSED/i);
});

test("Sideway Recovery keeps +6 BE but disables native +10 partial", () => {
  const notifications = runJournal(
    "LIVE",
    sidewayRecoveryEvents,
    "sideway-recovery",
    "SIDEWAY",
  );

  assert.equal(notifications.length, 2, "Recovery Sideway must notify ENTRY and +6 BE");
  assert.match(notifications[0].text, /DAILY RECOVERY/);
  assert.match(notifications[0].text, /\+6 → BE/);
  assert.match(notifications[0].text, /full-position Recovery TP/i);
  assert.match(notifications[0].text, /không \+10 partial/i);
  assert.doesNotMatch(notifications[0].text, /bỏ native TP1 partial\/BE/i);
  assert.match(notifications[1].text, /\+6 → BE/);
});

test("Recovery Telegram skips zero placeholders for Entry, SL, TP, and Lot", () => {
  const notifications = runJournal(
    "LIVE",
    recoveryZeroPlaceholderEvents,
    "recovery-zero-context",
  );

  assert.equal(notifications.length, 2, "Recovery entry + HOLD must emit exactly two notifications");

  const hold = notifications[1].text;
  assert.match(hold, /SELL · HOLD/);
  assert.match(hold, /RECOVERY-ZERO-1/);
  assert.match(hold, /Recovery TP đang hoạt động/);
  assert.doesNotMatch(hold, /PHASE 7C ·/);
  assert.doesNotMatch(hold, /Entry:/);
  assert.doesNotMatch(hold, /SL:/);
  assert.doesNotMatch(hold, /TP:/);
  assert.doesNotMatch(hold, /Lot:/);
  assert.doesNotMatch(hold, /Entry:<\/b> <code>0\.00<\/code>/);
  assert.doesNotMatch(hold, /SL:<\/b> <code>0\.00<\/code>/);
  assert.doesNotMatch(hold, /TP:<\/b> <code>0\.00<\/code>/);
  assert.doesNotMatch(hold, /Lot:<\/b> <code>— lot<\/code>/);
});

test("ENTRY_SUBMIT is pending truthfully and ARM_FILE_MISSING rejection says MT5 did not enter", () => {
  const notifications = runJournal("LIVE", rejectedEntryEvents, "entry-truth");

  assert.equal(notifications.length, 2, "submit + reject must emit exactly two trade notifications");
  assert.equal(notifications[0].route, "trade");
  assert.match(notifications[0].text, /🟡/);
  assert.match(notifications[0].text, /PENDING|ĐANG GỬI/i);
  assert.match(notifications[0].text, /CHỜ MT5 XÁC NHẬN/i);
  assert.doesNotMatch(notifications[0].text, /CHƯA VÀO MT5/i);
  assert.doesNotMatch(notifications[0].text, /FILLED/i);

  assert.equal(notifications[1].route, "trade");
  assert.match(notifications[1].text, /⛔/);
  assert.match(notifications[1].text, /KHÔNG VÀO MT5/i);
  assert.match(notifications[1].text, /ARM_FILE_MISSING/);
  assert.match(notifications[1].text, /423/);
});
