import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  transformPhase7CSidewayM5TrailingSource,
  transformPhase7CTrendM5TrailingSource,
} from "./phase7c-m5-structural-trailing-source-adapter.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const notifierPath = path.join(scriptsDir, "run-phase7b-telegram-notifier.mjs");

function runNotifier(event, label, source = "TREND") {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `phase7c-telegram-compact-m5-${label}-`));
  const trendJournal = path.join(tempDir, "trend-events.jsonl");
  const sidewayJournal = path.join(tempDir, "sideway-events.jsonl");
  const statePath = path.join(tempDir, "telegram-state.json");
  const sinkPath = path.join(tempDir, "notifications.jsonl");

  fs.writeFileSync(
    trendJournal,
    source === "TREND" ? `${JSON.stringify(event)}\n` : "",
    "utf8",
  );
  fs.writeFileSync(
    sidewayJournal,
    source === "SIDEWAY" ? `${JSON.stringify(event)}\n` : "",
    "utf8",
  );

  const result = spawnSync(process.execPath, [notifierPath], {
    env: {
      ...process.env,
      ZIQ_TELEGRAM_BOT_TOKEN: "synthetic-token-not-used",
      ZIQ_TELEGRAM_CHAT_ID: "synthetic-chat-not-used",
      ZIQ_TELEGRAM_JOURNAL_PATH: trendJournal,
      ZIQ_TELEGRAM_SIDEWAY_JOURNAL_PATH: sidewayJournal,
      ZIQ_TELEGRAM_STATE_PATH: statePath,
      ZIQ_TELEGRAM_SYMBOL: "XAUUSD",
      ZIQ_PHASE7C_ACCOUNT_MODE: "LIVE",
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
    `notifier must exit cleanly\nstdout=${result.stdout}\nstderr=${result.stderr}`,
  );

  return fs.existsSync(sinkPath)
    ? fs.readFileSync(sinkPath, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)
    : [];
}

function assertCompactHold(text, { side, ticket, reason }) {
  assert.match(text, new RegExp(`<b>${side} · HOLD<\\/b>`));
  assert.match(text, new RegExp(`Ticket:<\\/b> <b>${ticket}<\\/b>`));
  assert.ok(text.includes(reason));
  assert.doesNotMatch(text, /PHASE 7C ·/);
  assert.doesNotMatch(text, /Regime:/);
  assert.doesNotMatch(text, /Entry:/);
  assert.doesNotMatch(text, /SL:/);
  assert.doesNotMatch(text, /TP:/);
  assert.doesNotMatch(text, /Lot:/);
  assert.doesNotMatch(text, /0\.00/);
  assert.doesNotMatch(text, /— lot/);
}

test("Trend HOLD Telegram is ticket plus reason only", () => {
  const reason = "GIỮ LỆNH: Cấu trúc xu hướng M15 vẫn còn hiệu lực; chưa có điều kiện thoát lệnh.";
  const notifications = runNotifier({
    type: "HOLD_POSITION",
    timestamp: "2026-09-02T13:30:00.000Z",
    ticket: "304590358",
    side: "BUY",
    reasonCode: "HOLD_TREND_STRUCTURE_INTACT",
    reason,
  }, "trend-hold");

  assert.equal(notifications.length, 1);
  assertCompactHold(notifications[0].text, { side: "BUY", ticket: "304590358", reason });
});

test("Recovery HOLD Telegram is ticket plus reason only", () => {
  const reason = "GIỮ LỆNH: Recovery TP đang hoạt động; giữ toàn bộ vị thế đến Adaptive TP hoặc SL/BE.";
  const notifications = runNotifier({
    type: "HOLD_POSITION",
    timestamp: "2026-09-02T13:31:00.000Z",
    ticket: "304587517",
    side: "SELL",
    dailyMode: "RECOVERY_TP",
    reasonCode: "HOLD_RECOVERY_TP_ACTIVE",
    reason,
  }, "recovery-hold");

  assert.equal(notifications.length, 1);
  assertCompactHold(notifications[0].text, { side: "SELL", ticket: "304587517", reason });
});

test("Sideway HOLD Telegram is ticket plus reason only", () => {
  const reason = "GIỮ LỆNH: Biên sideway vẫn còn hiệu lực; tiếp tục giữ đến TP2 hoặc khi có điều kiện thoát.";
  const notifications = runNotifier({
    type: "HOLD_POSITION",
    timestamp: "2026-09-02T13:31:30.000Z",
    ticket: "304590999",
    side: "BUY",
    reasonCode: "HOLD_SIDEWAY_RANGE_INTACT",
    reason,
  }, "sideway-hold", "SIDEWAY");

  assert.equal(notifications.length, 1);
  assertCompactHold(notifications[0].text, { side: "BUY", ticket: "304590999", reason });
});

for (const [label, source, type, side, ticket] of [
  ["trend-m5", "TREND", "M5_STRUCTURAL_SL_TIGHTEN", "BUY", "304590358"],
  ["sideway-m5", "SIDEWAY", "SIDEWAY_M5_STRUCTURAL_SL_TIGHTEN", "SELL", "304590999"],
]) {
  test(`${label} successful structure move shows exact old to new SL`, () => {
    const notifications = runNotifier({
      type,
      timestamp: "2026-09-02T13:32:00.000Z",
      ticket,
      side,
      previousStopLoss: 4339.62,
      stopLoss: 4346.20,
      structurePrice: 4347.20,
      m5CloseTime: 1788355920000,
    }, label, source);

    assert.equal(notifications.length, 1);
    const text = notifications[0].text;
    assert.match(text, new RegExp(`<b>${side} · SL → STRUCTURE M5<\\/b>`));
    assert.match(text, new RegExp(`Ticket:<\\/b> <b>${ticket}<\\/b>`));
    assert.match(text, /4339\.62 → 4346\.20/);
    assert.match(text, /Dời StopLoss theo cấu trúc M5 đã xác nhận/);
    assert.doesNotMatch(text, /PHASE 7C ·/);
    assert.doesNotMatch(text, /Regime:/);
    assert.doesNotMatch(text, /Entry:/);
    assert.doesNotMatch(text, /TP:/);
    assert.doesNotMatch(text, /Lot:/);
  });
}

test("M5 source adapters preserve previousStopLoss only on successful modify journals", () => {
  const trendSource = fs.readFileSync(path.join(scriptsDir, "run-phase7b-demo-controller.ts"), "utf8");
  const sidewaySource = fs.readFileSync(path.join(scriptsDir, "run-phase7c-sideway-controller.mjs"), "utf8");
  const transformedTrend = transformPhase7CTrendM5TrailingSource(trendSource);
  const transformedSideway = transformPhase7CSidewayM5TrailingSource(sidewaySource);

  for (const [name, transformed, eventType] of [
    ["Trend", transformedTrend, "M5_STRUCTURAL_SL_TIGHTEN"],
    ["Sideway", transformedSideway, "SIDEWAY_M5_STRUCTURAL_SL_TIGHTEN"],
  ]) {
    const journalIndex = transformed.indexOf(`journal("${eventType}"`);
    assert.notEqual(journalIndex, -1, `${name} successful M5 journal must exist`);
    const successIndex = transformed.lastIndexOf("if (response.success)", journalIndex);
    assert.notEqual(successIndex, -1, `${name} M5 journal must remain behind response.success`);
    const block = transformed.slice(successIndex, journalIndex + 700);
    assert.match(block, /previousStopLoss\s*:\s*position\.stopLoss/);
    assert.match(block, /stopLoss\s*:\s*m5Trail\.stopLoss/);
  }
});
