import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimePath = path.join(root, "scripts/run-phase7b-api-runtime-local.ps1");
const source = fs.readFileSync(runtimePath, "utf8");

assert.match(
  source,
  /phase7c-account-mode\.json/,
  "API runtime bootstrap must consult canonical Phase7C account-mode state",
);
assert.match(
  source,
  /Test-Path\s+-LiteralPath\s+\$AccountStatePath/,
  "canonical account state must be optional only as an explicit legacy/fallback case",
);
assert.match(
  source,
  /\$accountState\.version[\s\S]{0,160}(?:-ne|!=)\s*1/,
  "canonical account-mode state version must be validated",
);
assert.match(
  source,
  /\$accountState\.accountMode/,
  "API bootstrap must read canonical accountMode",
);
assert.match(
  source,
  /liveExecutionEnabled/,
  "API bootstrap must validate canonical LIVE/DEMO execution consistency",
);
assert.match(
  source,
  /\$accountState\.envFile/,
  "API bootstrap must select envFile from canonical account state",
);
assert.match(
  source,
  /\$bridgeEnvSource\s*=\s*["']ACCOUNT_MODE_STATE["']/,
  "canonical account state must select ACCOUNT_MODE_STATE provenance",
);
assert.match(
  source,
  /\$bridgeEnvSource\s*=\s*["']TASK_FALLBACK["']/,
  "legacy task BridgeEnv must remain explicitly labeled TASK_FALLBACK",
);
assert.match(
  source,
  /Write-Host\s+["']PHASE7B_API_BRIDGE_ENV_SOURCE=\$bridgeEnvSource["']/,
  "runtime must expose the selected non-secret bridge env provenance",
);
assert.doesNotMatch(
  source,
  /MT5_(?:API_KEY|MAGIC_NUMBER) in the DEMO bridge env/,
  "API bootstrap validation must not assume the selected bridge env is DEMO",
);

const stateLookup = source.indexOf("phase7c-account-mode.json");
const firstEnvRead = source.indexOf('Read-EnvValue "MT5_API_KEY"');
assert.ok(stateLookup >= 0 && firstEnvRead > stateLookup, "canonical env resolution must occur before reading MT5 credentials");

console.log("PHASE7C_API_CANONICAL_ACCOUNT_ENV_BOOTSTRAP_TEST=PASS");
