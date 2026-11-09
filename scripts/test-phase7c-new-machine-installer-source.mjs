import fs from "node:fs";
import assert from "node:assert/strict";

const source = fs.readFileSync("scripts/install-phase7c-new-machine-local.ps1", "utf8");

const required = [
  'ExpectedCommit = "800ab441ffa1eec45488f7b7ff92c15b3a44846e"',
  "Node.js 24.x is required to match the production CI toolchain.",
  "Telegram env must contain ZIQ_TELEGRAM_BOT_TOKEN and ZIQ_TELEGRAM_CHAT_ID.",
  "[switch]$ConfirmOldMachineStopped",
  "Refusing new-machine LIVE bootstrap until -ConfirmOldMachineStopped is supplied.",
  '"clone", "--no-checkout"',
  '"checkout", "-B", "main", $ExpectedCommit',
  'Assert-GitIgnored -Root $ProjectRoot -RelativePath ".runtime/"',
  'Add-Content -LiteralPath $localExcludePath -Value "/.runtime/" -Encoding ascii',
  'mode = "PAUSE"',
  'Remove-Item -LiteralPath $armPath -Force -ErrorAction SilentlyContinue',
  "Write-Phase7CLiveAuthorizationState",
  'XAUUSD-Phase7C-Bridge',
  'XAUUSD-Phase7B-Web',
  'XAUUSD-Phase7C-Executors',
  "recover-phase7c-runtime-ready-stable-deploy-local.ps1",
  "PHASE7C_NEW_MACHINE_SOURCE_ATTESTATION=EXACT_MATCH",
  "PHASE7C_NEW_MACHINE_BOT_MODE=PAUSE",
  "PHASE7C_NEW_MACHINE_ARM=DISARMED",
  "PHASE7C_NEW_MACHINE_LIVE_TEST_ORDER=NONE",
  "PHASE7C_NEW_MACHINE_NEXT_ACTION=VERIFY_THEN_MANUAL_AUTO_AND_ARM",
];

for (const marker of required) {
  assert.ok(source.includes(marker), `missing new-machine bootstrap safety marker: ${marker}`);
}

const forbidden = [
  'confirmation = "ARM_LIVE"',
  'action = "ARM_LIVE"',
  'mode = "AUTO"',
  'Copy-Item -LiteralPath "$ProjectRoot\\.runtime"',
  "git push",
];

for (const marker of forbidden) {
  assert.ok(!source.includes(marker), `forbidden new-machine bootstrap behavior present: ${marker}`);
}

assert.match(
  source,
  /Assert-FlatBroker[\s\S]*BRIDGE_PREFLIGHT[\s\S]*Assert-FlatBroker[\s\S]*PRE_ACCEPTANCE[\s\S]*Assert-FlatBroker[\s\S]*FINAL/,
  "bootstrap must prove flat broker before and after runtime acceptance",
);

assert.match(
  source,
  /liveArmStatus -ne "DISARMED"[\s\S]*liveExecutionArmed/,
  "bootstrap must explicitly verify DISARMED state",
);

const uniquePhaseMarkers = [
  "$bridgeTaskInstaller =",
  "$executorTaskInstaller =",
  "$recovery = Join-Path",
  "PHASE7C_NEW_MACHINE_STATUS=PASS",
];

for (const marker of uniquePhaseMarkers) {
  assert.equal(
    source.split(marker).length - 1,
    1,
    `new-machine bootstrap phase must occur exactly once: ${marker}`,
  );
}

console.log("PHASE7C_NEW_MACHINE_BOOTSTRAP_SOURCE_CONTRACT=PASS");
