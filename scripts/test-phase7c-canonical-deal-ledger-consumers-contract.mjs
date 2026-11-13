import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

const ledgerServicePath = "apps/api/src/services/phase7c-canonical-deal-ledger.service.ts";
const dailyRecoveryPath = "apps/api/src/services/phase7c-daily-recovery-view.service.ts";
const performancePath = "apps/api/src/services/mt5-performance.service.ts";
const notifierPath = "scripts/run-phase7b-telegram-notifier.mjs";

test("API owns one durable canonical deal ledger adapter with account identity and replay backfill", () => {
  assert.ok(
    fs.existsSync(path.join(repoRoot, ledgerServicePath)),
    `${ledgerServicePath} must exist so API consumers share one durable ledger`,
  );

  const source = read(ledgerServicePath);
  assert.match(source, /CanonicalDealLedger/);
  assert.match(source, /mergeBackfill/);
  assert.match(source, /accountLogin/);
  assert.match(source, /PHASE7C_RUNTIME_ROOT/);
  assert.doesNotMatch(source, /lastTimestamp|timestampCursor|cursorTimestamp/i);
});

test("Daily Recovery reads canonical ledger accounting instead of aggregating bridge history itself", () => {
  const source = read(dailyRecoveryPath);
  assert.match(source, /phase7c-canonical-deal-ledger\.service/);
  assert.doesNotMatch(source, /summarizeBrokerDayRealizedPnl/);
  assert.doesNotMatch(source, /\/v1\/history\/deals/);
});

test("Web performance reads the same canonical ledger source instead of a separate history/accounting path", () => {
  const source = read(performancePath);
  assert.match(source, /phase7c-canonical-deal-ledger\.service/);
  assert.doesNotMatch(source, /getMt5DealHistory/);
});

test("Web performance uses the same account-mode-aware Phase7C owned magic contract as Daily Recovery", () => {
  const source = read(performancePath);
  assert.match(source, /resolvePhase7CDailyRecoveryMagicNumbers/);
  assert.doesNotMatch(source, /defaultMt5BrokerConfig/);
  assert.doesNotMatch(source, /process\.env\.MT5_MAGIC_NUMBER/);
});

test("Telegram partial and exit accounting never estimate realized P&L from market movement", () => {
  const source = read(notifierPath);
  assert.doesNotMatch(source, /partialPnlEstimate/);
  assert.doesNotMatch(source, /realizedPnlEstimate/);
  assert.doesNotMatch(source, /estimatePnlFromPriceMove/);
  assert.match(source, /canonical.{0,80}realized|realized.{0,80}canonical/is);
});
