import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  PHASE7C_LOT_LIMITS,
  Phase7CLotSettingsService,
  validatePhase7CLotSettings,
} from "../apps/api/dist/services/phase7c-lot-settings.service.js";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptsDir, "..");

test("lot settings default safely and require an armed matching executor", () => {
  const root = mkdtempSync(path.join(tmpdir(), "phase7c-lot-settings-"));
  try {
    const settingsPath = path.join(root, "settings.json");
    const activePath = path.join(root, "active.json");
    const supervisorPidPath = path.join(root, "supervisor.pid");
    const service = new Phase7CLotSettingsService(settingsPath, activePath);

    const initial = service.get();
    assert.equal(initial.state.version, 2);
    assert.equal(initial.state.trendFixedLot, 0.03);
    assert.equal(initial.state.sidewayRiskPercent, 0.25);
    assert.equal(initial.state.sidewayMaxLot, 0.03);
    assert.equal(initial.state.trendFixedTpEnabled, false);
    assert.equal(initial.state.trendFixedTpDistance, 0);
    assert.equal(initial.state.sidewayFixedTpEnabled, false);
    assert.equal(initial.state.sidewayFixedTpDistance, 0);
    assert.equal(initial.restartRequired, true);

    const saved = service.set({
      trendFixedLot: 0.06,
      sidewayRiskPercent: 0.4,
      sidewayMaxLot: 0.03,
    }, "test");
    assert.equal(saved.state.version, 2);
    assert.equal(saved.state.trendFixedLot, 0.06);
    assert.equal(saved.state.sidewayRiskPercent, 0.4);
    assert.equal(saved.state.sidewayMaxLot, 0.03);
    assert.equal(saved.state.trendFixedTpEnabled, false);
    assert.equal(saved.state.trendFixedTpDistance, 0);
    assert.equal(saved.state.sidewayFixedTpEnabled, false);
    assert.equal(saved.state.sidewayFixedTpDistance, 0);
    assert.equal(saved.restartRequired, true);

    writeFileSync(activePath, JSON.stringify({
      version: 1,
      trendFixedLot: 0.06,
      sidewayRiskPercent: 0.4,
      sidewayMaxLot: 0.03,
      armed: true,
      supervisorPid: process.pid,
      appliedAt: new Date().toISOString(),
    }));
    writeFileSync(supervisorPidPath, `${process.pid}\n`, "utf8");

    const active = service.get();
    assert.equal(active.activeAlive, true);
    assert.equal(active.active?.version, 2);
    assert.equal(active.active?.trendFixedTpEnabled, false);
    assert.equal(active.active?.trendFixedTpDistance, 0);
    assert.equal(active.active?.sidewayFixedTpEnabled, false);
    assert.equal(active.active?.sidewayFixedTpDistance, 0);
    assert.equal(active.restartRequired, false);
    assert.equal(active.safety.existingPositionMutation, false);
    assert.equal(active.safety.recoveryLotEscalation, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale active lot record cannot claim alive without canonical supervisor ownership", () => {
  const root = mkdtempSync(path.join(tmpdir(), "phase7c-active-supervisor-identity-"));
  try {
    const settingsPath = path.join(root, "settings.json");
    const activePath = path.join(root, "active.json");
    const supervisorPidPath = path.join(root, "supervisor.pid");
    const service = new Phase7CLotSettingsService(settingsPath, activePath);

    writeFileSync(activePath, JSON.stringify({
      version: 2,
      accountMode: "DEMO",
      trendFixedLot: 0.03,
      sidewayRiskPercent: 0.25,
      sidewayMaxLot: 0.03,
      trendFixedTpEnabled: false,
      trendFixedTpDistance: 0,
      sidewayFixedTpEnabled: false,
      sidewayFixedTpDistance: 0,
      armed: true,
      supervisorPid: process.pid,
      appliedAt: new Date().toISOString(),
    }), "utf8");

    const stale = service.get();
    assert.equal(
      stale.activeAlive,
      false,
      "a live unrelated PID must not make stale active-lot metadata authoritative when supervisor.pid is absent",
    );
    assert.equal(stale.restartRequired, true);

    writeFileSync(supervisorPidPath, `${process.pid + 1}\n`, "utf8");
    const mismatched = service.get();
    assert.equal(
      mismatched.activeAlive,
      false,
      "a mismatched canonical supervisor.pid must fail closed",
    );
    assert.equal(mismatched.restartRequired, true);

    writeFileSync(supervisorPidPath, `${process.pid}\n`, "utf8");
    const owned = service.get();
    assert.equal(owned.activeAlive, true);
    assert.equal(owned.restartRequired, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lot settings reject non-third-compatible Trend lots and excessive risk", () => {
  const root = mkdtempSync(path.join(tmpdir(), "phase7c-lot-settings-invalid-"));
  try {
    const service = new Phase7CLotSettingsService(
      path.join(root, "settings.json"),
      path.join(root, "active.json"),
    );
    assert.throws(() => service.set({
      trendFixedLot: 0.05,
      sidewayRiskPercent: 0.25,
      sidewayMaxLot: 0.03,
    }), /0\.03 increments/);
    assert.throws(() => service.set({
      trendFixedLot: 0.03,
      sidewayRiskPercent: 1.01,
      sidewayMaxLot: 0.03,
    }), /between 0\.01% and 1\.00%/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("canonical lot bounds allow Trend and Sideway from 0.03 to 1.20 in 0.03 increments", () => {
  assert.equal(PHASE7C_LOT_LIMITS.maxDemoLot, 1.2);
  assert.equal(PHASE7C_LOT_LIMITS.maxManagedLot, 1.2);
  assert.equal(PHASE7C_LOT_LIMITS.maxTrendLot, 1.2);
  assert.equal(PHASE7C_LOT_LIMITS.maxSidewayLot, 1.2);
  for (const lot of [0.03, 0.06, 0.3, 0.6, 1.17, 1.2]) {
    assert.deepEqual(validatePhase7CLotSettings({ trendFixedLot: lot, sidewayRiskPercent: 0.25, sidewayMaxLot: lot }), {
      trendFixedLot: lot,
      sidewayRiskPercent: 0.25,
      sidewayMaxLot: lot,
      trendFixedTpEnabled: false,
      trendFixedTpDistance: 0,
      sidewayFixedTpEnabled: false,
      sidewayFixedTpDistance: 0,
    });
  }
  for (const lot of [0.04, 0.05, 1.21, 1.23]) {
    assert.throws(() => validatePhase7CLotSettings({ trendFixedLot: lot, sidewayRiskPercent: 0.25, sidewayMaxLot: 0.03 }), /0\.03.*1\.20|0\.03 increments/i);
    assert.throws(() => validatePhase7CLotSettings({ trendFixedLot: 0.03, sidewayRiskPercent: 0.25, sidewayMaxLot: lot }), /0\.03.*1\.20|0\.03 increments/i);
  }
});

test("execution boundaries enforce the shared 1.20 ceiling and 0.03 increments", () => {
  const supervisor = readFileSync(path.join(scriptsDir, "run-phase7c-executors-local.ps1"), "utf8");
  const trendLauncher = readFileSync(path.join(scriptsDir, "run-phase7c-trend-controller-local.ps1"), "utf8");
  const sidewayLauncher = readFileSync(path.join(scriptsDir, "run-phase7c-sideway-controller-local.ps1"), "utf8");
  const accountModeLibrary = readFileSync(path.join(scriptsDir, "lib", "phase7c-account-mode.ps1"), "utf8");
  const trendController = readFileSync(path.join(scriptsDir, "run-phase7b-demo-controller.ts"), "utf8");
  const sidewayController = readFileSync(path.join(scriptsDir, "run-phase7c-sideway-controller.mjs"), "utf8");
  assert.match(supervisor, /\$TrendFixedVolume\s+-gt\s+1\.2/);
  assert.match(supervisor, /\$SidewayMaxLot\s+-gt\s+1\.2/);
  assert.match(supervisor, /\$TrendFixedVolume\s*\/\s*0\.03/);
  assert.match(supervisor, /\$SidewayMaxLot\s*\/\s*0\.03/);
  assert.match(trendLauncher, /\$FixedVolume\s+-gt\s+1\.2/);
  assert.match(trendLauncher, /\$FixedVolume\s*\/\s*0\.03/);
  assert.match(sidewayLauncher, /\$MaxLot\s+-gt\s+1\.2/);
  assert.match(sidewayLauncher, /\$MaxLot\s*\/\s*0\.03/);
  assert.match(accountModeLibrary, /\$trend\s*\/\s*0\.03/);
  assert.match(accountModeLibrary, /\$maxLot\s*\/\s*0\.03/);
  assert.match(trendController, /MAX_TREND_FIXED_VOLUME\s*=\s*1\.2/);
  assert.match(sidewayController, /MAX_SIDEWAY_LOT\s*=\s*1\.2/);
  assert.match(sidewayController, /rawMaxLot\s*\/\s*0\.03/);
});

test("activation path preserves the shared 1.20 step-0.03 contract", () => {
  const activation = readFileSync(path.join(scriptsDir, "activate-phase7c-local.ps1"), "utf8");
  const safeActivation = readFileSync(path.join(scriptsDir, "activate-phase7c-safe-local.ps1"), "utf8");
  assert.match(activation, /\$TrendFixedVolume\s+-gt\s+1\.2/);
  assert.match(activation, /\$SidewayMaxLot\s+-gt\s+1\.2/);
  assert.match(activation, /\$TrendFixedVolume\s*\/\s*0\.03/);
  assert.match(activation, /\$SidewayMaxLot\s*\/\s*0\.03/);
  assert.match(safeActivation, /\$activationArgs\.SidewayMaxLot\s*=\s*\$SidewayMaxLot/);
  assert.match(safeActivation, /PHASE7C_SAFE_ACTIVATE_FINAL_MODE=PAUSE/);
});

test("API route keeps exact one-third compatibility for Trend and Sideway max lot", () => {
  const route = readFileSync(path.join(projectRoot, "apps", "api", "src", "routes", "phase7c.route.ts"), "utf8");
  assert.match(route, /Trend fixed lot[^\n]*exact one-third partial close/s);
  assert.match(route, /Sideway max lot[^\n]*exact one-third partial close/s);
});

test("canonical Account & Risk lot controls expose the shared bounds and managed 0.03 step", () => {
  const web = readFileSync(path.join(projectRoot, "apps", "web", "src", "pages", "Phase7BOpsPage.tsx"), "utf8");
  assert.match(web, /const\s+MANAGED_LOT_STEP\s*=\s*0\.03/);
  assert.match(web, /label="Trend fixed lot"[\s\S]*?inputProps=\{\{\s*min:\s*0\.03,\s*max:\s*1\.2,\s*step:\s*MANAGED_LOT_STEP\s*\}\}/);
  assert.match(web, /label="Sideway risk percent"[\s\S]*?inputProps=\{\{\s*min:\s*0\.01,\s*max:\s*1,\s*step:\s*0\.01\s*\}\}/);
  assert.match(web, /label="Sideway max lot"[\s\S]*?inputProps=\{\{\s*min:\s*0\.03,\s*max:\s*1\.2,\s*step:\s*MANAGED_LOT_STEP\s*\}\}/);
});

test("Telegram dry-run preserves journal numeric precision and remains orderPermission=NONE", () => {
  const root = mkdtempSync(path.join(tmpdir(), "phase7c-telegram-journal-precision-"));
  try {
    const journalPath = path.join(root, "trend-events.jsonl");
    const statePath = path.join(root, "telegram-state.json");
    const sinkPath = path.join(root, "notifications.jsonl");
    const exactEntry = 4712.12345678;

    writeFileSync(journalPath, `${JSON.stringify({
      type: "ENTRY_SUBMIT",
      timestamp: "2026-08-28T01:00:00.000Z",
      side: "BUY",
      pattern: "M15_BULLISH_ENGULFING",
      signalEntry: exactEntry,
      stopLoss: 4704.12345678,
      stopDistance: 8,
      volume: 0.03,
    })}\n`, "utf8");

    const result = spawnSync(process.execPath, [path.join(scriptsDir, "run-phase7b-telegram-notifier.mjs")], {
      env: {
        ...process.env,
        ZIQ_TELEGRAM_BOT_TOKEN: "synthetic-token-not-used",
        ZIQ_TELEGRAM_CHAT_ID: "synthetic-chat-not-used",
        ZIQ_TELEGRAM_JOURNAL_PATH: journalPath,
        ZIQ_TELEGRAM_STATE_PATH: statePath,
        ZIQ_TELEGRAM_SYMBOL: "XAUUSD",
        ZIQ_PHASE7C_ACCOUNT_MODE: "DEMO",
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
      `notifier dry-run must exit cleanly\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );

    const notifications = readFileSync(sinkPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    assert.equal(notifications.length, 1, "one journal event must produce one dry-run notification");
    assert.equal(notifications[0].orderPermission, "NONE", "notifier must remain read-only");
    assert.match(result.stdout, /PHASE7B_TELEGRAM_ORDER_PERMISSION=NONE_READ_ONLY_JOURNAL_AND_MONITOR/);
    assert.ok(
      notifications[0].text.includes(String(exactEntry)),
      `Telegram must preserve exact journal numeric precision ${exactEntry}; actual=${notifications[0].text}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
