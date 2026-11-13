import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const servicePath = "apps/api/src/services/phase7c-canonical-deal-ledger.service.ts";
const indexPath = "apps/api/src/index.ts";

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("API startup must invoke best-effort canonical ledger historical backfill", () => {
  const service = read(servicePath);
  const index = read(indexPath);

  assert.match(
    service,
    /export\s+async\s+function\s+warmPhase7CCanonicalDealLedgerOnStartup\s*\(/,
    "RED_TARGET_STARTUP_BACKFILL: canonical ledger service must export startup warm-backfill",
  );
  assert.match(service, /backfillPhase7CCanonicalDealLedger\s*\(/);
  assert.match(service, /accountModeAllowsBroker\s*\(/);
  assert.match(service, /const\s+STARTUP_BACKFILL_DAYS\s*=\s*365\s*;/);
  assert.match(service, /toMs\s*-\s*STARTUP_BACKFILL_DAYS\s*\*\s*DAY_MS/);
  assert.doesNotMatch(service, /timestampCursor|cursorTimestamp|lastTimestamp/i);

  assert.match(index, /warmPhase7CCanonicalDealLedgerOnStartup/);
  assert.match(
    index,
    /void\s+warmPhase7CCanonicalDealLedgerOnStartup\s*\(/,
    "startup warm-backfill must be non-blocking",
  );
  assert.match(
    index,
    /warmPhase7CCanonicalDealLedgerOnStartup[\s\S]{0,700}\.catch\s*\(/,
    "startup backfill failure must be caught so API startup remains fail-safe",
  );
});

test("startup backfill source remains observation-only", () => {
  const service = read(servicePath);
  const index = read(indexPath);
  const combined = `${service}\n${index}`;

  assert.doesNotMatch(combined, /\/v1\/orders(?:\/|\?|\"|'|`)/i);
  assert.doesNotMatch(combined, /placeOrder|closePosition|modifyPosition|cancelOrder|order_send/i);
  assert.doesNotMatch(combined, /ARM_CHANGE|setPhase7CAccountModeFromWebAutoDetection/);
});
