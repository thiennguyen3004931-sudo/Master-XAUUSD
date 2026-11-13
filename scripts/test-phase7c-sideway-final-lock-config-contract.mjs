import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const finalLockPath = path.join(here, "run-phase7c-sideway-locked.mjs");
const source = fs.readFileSync(finalLockPath, "utf8");

// The final wrapper is a control/account/execution-safety boundary. Market strategy
// composition belongs to the canonical Sideway controller, where each configurable
// condition can be PASS/FAIL/IGNORED and the config version is rechecked before order.
assert.match(
  source,
  /resolveSidewayPermission\(modePayload\?\.state\?\.mode,\s*["']SIDEWAY["']\)/,
  "RED_TARGET_MODE_ONLY_GATE: final lock must gate active control mode without reusing market recommendation as policy",
);

assert.doesNotMatch(
  source,
  /regime\?\.regime\s*!==\s*["']RANGING["']/,
  "RED_TARGET_CONFIGURABLE_RANGING: final lock must not hard-code configurable rangingRegime",
);
assert.doesNotMatch(
  source,
  /regime\?\.recommendedMode\s*!==\s*["']SIDEWAY["']/,
  "RED_TARGET_CONFIGURABLE_RECOMMENDATION: final lock must not hard-code configurable recommendedModeSideway",
);
assert.doesNotMatch(
  source,
  /REGIME_CONFIDENCE_BELOW_MINIMUM|SIDEWAY_MIN_REGIME_CONFIDENCE|minRegimeConfidence/,
  "RED_TARGET_CONFIGURABLE_CONFIDENCE: final lock must not hard-code configurable minimumRegimeConfidence",
);

// Independent final safety boundaries must remain present and fail closed.
assert.match(source, /acquireExecutionLock\(\{\s*owner:\s*["']SIDEWAY["']\s*\}\)/);
assert.match(source, /evaluatePhase7CAccountHealth\(health,\s*accountRuntime,\s*\{\s*armed:\s*true\s*\}\)/);
assert.match(source, /POSITION_PRESENT_UNDER_LOCK/);
assert.match(source, /FINAL_LOCK_RECHECK_ERROR_FAIL_CLOSED/);
assert.match(source, /await\s+nativeFetch\(input,\s*init\)/);
assert.match(source, /lock\.release\(\)/);

console.log("PHASE7C_SIDEWAY_FINAL_LOCK_CONFIG_CONTRACT=PASS");
