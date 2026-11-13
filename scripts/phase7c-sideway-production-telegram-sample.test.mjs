import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const samplePath = path.join(
  scriptsDir,
  "send-phase7c-sideway-production-telegram-sample.mjs",
);

test("Sideway production Telegram sample uses the real notifier for the complete six-card LIVE lifecycle", () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "phase7c-sideway-production-telegram-sample-"),
  );
  const envPath = path.join(tempDir, ".env.phase7b-telegram");
  const sinkPath = path.join(tempDir, "notifications.jsonl");

  fs.writeFileSync(
    envPath,
    [
      "ZIQ_TELEGRAM_BOT_TOKEN=synthetic-token-not-used",
      "ZIQ_TELEGRAM_CHAT_ID=synthetic-chat-not-used",
      "ZIQ_TELEGRAM_TRADE_BOT_TOKEN=synthetic-trade-token-not-used",
      "ZIQ_TELEGRAM_TRADE_CHAT_ID=synthetic-trade-chat-not-used",
      "ZIQ_TELEGRAM_SYMBOL=XAUUSD",
    ].join("\n") + "\n",
    "utf8",
  );

  const result = spawnSync(
    process.execPath,
    [
      samplePath,
      "--dry-run",
      "--account-mode",
      "LIVE",
      "--env-file",
      envPath,
      "--sink",
      sinkPath,
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
    },
  );

  assert.equal(
    result.status,
    0,
    `production sample must exit cleanly\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.ok(fs.existsSync(sinkPath), "production sample must create the notifier dry-run sink");

  const notifications = fs
    .readFileSync(sinkPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  assert.equal(notifications.length, 6, "real Sideway lifecycle sample must emit six production-format trade cards");

  for (const [index, notification] of notifications.entries()) {
    assert.equal(notification.route, "trade");
    if (index === 4) {
      assert.doesNotMatch(notification.text, /PHASE 7C · LIVE/);
    } else {
      assert.match(notification.text, /PHASE 7C · LIVE/);
    }
  }

  assert.match(notifications[0].text, /SIDEWAY PENDING/);
  // Pending means MT5 has not yet confirmed the fill; match current LIVE notifier wording.
  assert.match(notifications[0].text, /CHỜ MT5 XÁC NHẬN/);
  assert.match(notifications[1].text, /SIDEWAY FILLED/);
  assert.match(notifications[1].text, /\+6 → BE/);
  assert.match(notifications[1].text, /\+10 → chốt 1\/3/i);
  assert.match(notifications[1].text, /SL không dưới BE/i);
  assert.match(notifications[1].text, /TP2 biên đối diện/i);
  assert.match(notifications[2].text, /\+6 → BE/);
  assert.match(notifications[2].text, /SL:/);
  assert.match(notifications[3].text, /CHỐT 1\/3/);
  assert.match(notifications[3].text, /Đóng:/);
  assert.match(notifications[3].text, /P&L runner:/);
  assert.match(notifications[4].text, /BUY · HOLD/);
  assert.match(notifications[4].text, /SIDEWAY-PRODUCTION-SAMPLE-1/);
  assert.match(notifications[4].text, /GIỮ LỆNH: Biên sideway vẫn còn hiệu lực/);
  assert.doesNotMatch(notifications[4].text, /Regime:/);
  assert.doesNotMatch(notifications[4].text, /Entry:/);
  assert.doesNotMatch(notifications[4].text, /SL:/);
  assert.doesNotMatch(notifications[4].text, /TP:/);
  assert.doesNotMatch(notifications[4].text, /Lot:/);
  assert.match(notifications[5].text, /CHỐT LỆNH/);
  assert.match(notifications[5].text, /P&L tổng:/);
  assert.match(notifications[5].text, /TP2|biên đối diện|OPPOSITE/i);

  const output = result.stdout + result.stderr;
  assert.match(output, /SIDEWAY_PRODUCTION_TELEGRAM_SAMPLE_PRODUCTION_NOTIFIER=True/);
  assert.match(output, /PHASE7B_TELEGRAM_ORDER_PERMISSION=NONE_READ_ONLY_JOURNAL_AND_MONITOR/);
  assert.match(output, /SIDEWAY_PRODUCTION_TELEGRAM_SAMPLE_BROKER_ORDER_SEND=False/);
  assert.match(output, /SIDEWAY_PRODUCTION_TELEGRAM_SAMPLE_POSITION_MUTATION=False/);
  assert.match(output, /SIDEWAY_PRODUCTION_TELEGRAM_SAMPLE_BOT_MODE_MUTATION=False/);
  assert.match(output, /SIDEWAY_PRODUCTION_TELEGRAM_SAMPLE_LIVE_ARM_MUTATION=False/);
  assert.doesNotMatch(output, /\/v1\/orders/);
});
