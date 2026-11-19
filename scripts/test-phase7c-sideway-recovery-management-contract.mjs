import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(
  fileURLToPath(import.meta.url),
);

const sidewayPath = path.join(
  here,
  "run-phase7c-sideway-controller.mjs",
);

const source = fs.readFileSync(
  sidewayPath,
  "utf8",
);

/*
 * Operator-accepted contract after disabling Daily Recovery for NEW entries:
 * - Do not reinterpret old RECOVERY_TP positions or mutate their broker TP/SL.
 * - A preexisting position still receives +6 BE and M5 stop tightening.
 * - No software time/regime/recovery/partial/fixed TP2 close is reachable.
 * - New negative-day SIDEWAY plans remain native via the canonical pause gate.
 */
const manageStart = source.indexOf("async function managePosition(");
const manageEnd = source.indexOf("async function closeAll(", manageStart);
assert.ok(manageStart >= 0 && manageEnd > manageStart);
const manage = source.slice(manageStart, manageEnd);
const plus6Index = manage.indexOf("if (!managed.breakEvenApplied && favorable >= 6)");
const recoveryGuardIndex = manage.indexOf('if (managed.dailyMode === "RECOVERY_TP")');
const partialIndex = manage.indexOf("if (!brokerTpSlTrailOnly && managed.breakEvenApplied");
const holdIndex = manage.indexOf('journal("SIDEWAY_HOLD_BROKER_TP_SL_TRAIL_ONLY"');
const lastSoftwareClose = manage.lastIndexOf("if (await closeFixedTpIfTriggered(position, quote)) return;");

assert.match(source, /const brokerTpSlTrailOnly = true;/);
assert.match(source, /pauseDailyRecoveryForNewEntry\("SIDEWAY", \{[\s\S]*?mode: "RECOVERY_TP"/);
assert.ok(plus6Index >= 0, "Sideway +6 BE must remain reachable.");
assert.ok(recoveryGuardIndex > plus6Index, "Legacy Recovery path remains after BE and is never active.");
assert.match(manage.slice(plus6Index, partialIndex),
  /if \(!brokerTpSlTrailOnly\)\s*\{\s*if \(managed\.dailyMode === "RECOVERY_TP"\)/);
assert.ok(partialIndex > recoveryGuardIndex, "Legacy partial is still present but gated OFF.");
assert.ok(holdIndex > partialIndex && lastSoftwareClose > holdIndex,
  "Broker-only post-fill HOLD must return before discretionary close paths.");
assert.match(manage.slice(holdIndex, lastSoftwareClose), /\breturn\s*;/,
  "Broker-only post-fill handler must return rather than submit a software close.");


console.log(
  "SIDEWAY_RECOVERY_MANAGEMENT_CONTRACT=PASS",
);

console.log(
  "SIDEWAY_RECOVERY_PLUS6_BE_PRESERVED=PASS",
);

console.log(
  "SIDEWAY_RECOVERY_PARTIAL_DISABLED=PASS",
);

console.log(
  "SIDEWAY_RECOVERY_FULL_POSITION=PASS",
);
