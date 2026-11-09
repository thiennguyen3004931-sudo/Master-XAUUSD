import assert from "node:assert/strict";
import fs from "node:fs";

const activationPath = "scripts/activate-phase7c-local.ps1";
const source = fs.readFileSync(activationPath, "utf8");

const freezeStart = source.indexOf('Write-Host "PHASE7C_ACTIVATE_ENTRY_FREEZE=START"');
const preflightStart = source.indexOf('Write-Host "PHASE7C_ACTIVATE_PREFLIGHT=START"');

assert.ok(freezeStart >= 0, "Activation entry-freeze block is missing.");
assert.ok(preflightStart > freezeStart, "Activation preflight must run after entry freeze.");

const freezeBlock = source.slice(freezeStart, preflightStart);

assert.equal(
  freezeBlock.includes("/api/v1/phase7c/bot-mode"),
  false,
  "Activation entry freeze must not mutate the canonical bot mode; AUTO/TREND/SIDEWAY/PAUSE is the operator's persistent selection.",
);
assert.equal(
  freezeBlock.includes('mode = "PAUSE"'),
  false,
  "Activation safety must not implement its freeze by overwriting the persistent bot mode with PAUSE.",
);
assert.match(
  freezeBlock,
  /Stop-TaskSafe\s+\$LegacyBotTask/,
  "Activation must stop the legacy entry-capable task before preflight.",
);
assert.match(
  freezeBlock,
  /ExecutorStopper[\s\S]*-WorkDir\s+\$WorkDir/,
  "Activation must stop Phase 7C executors before preflight.",
);
assert.match(
  freezeBlock,
  /PHASE7C_ACTIVATE_ENTRY_FREEZE_MODE=PERSISTENT_BOT_MODE_PRESERVED/,
  "Activation diagnostics must explicitly confirm that the persistent bot mode was preserved.",
);

console.log("PHASE7C_ACTIVATION_PRESERVES_BOT_MODE_TEST=PASS");
