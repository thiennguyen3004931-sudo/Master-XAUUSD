import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflow = readFileSync(
  resolve(process.cwd(), ".github", "workflows", "phase7c-final-strategy-runtime-readiness-readonly.yml"),
  "utf8",
);
const wrapper = readFileSync(
  resolve(process.cwd(), "scripts", "phase7c-final-strategy-runtime-readiness-readonly.ps1"),
  "utf8",
);
const combined = workflow + "\n" + wrapper;

for (const required of [
  "Phase7C Final Strategy Runtime Readiness Read-Only",
  "preflight-phase7c-production-readonly-local.ps1",
  "Read-only current-main runtime target check",
  "READ_ONLY_DIAGNOSTIC=TRUE",
  "DEPLOYMENT_MUTATION=NONE",
  "BOT_MODE_MUTATION=NONE",
  "ARM_MUTATION=NONE",
  "MT5_ORDER_MUTATION=NONE",
  "ACCOUNT_SWITCH=NONE",
  "FINAL_STRATEGY_TARGET_EXACT",
  "FINAL_STRATEGY_DEPLOYMENT_READY_WITHOUT_ARM_MUTATION",
  "$arm -eq 'DISARMED'",
  "$botMode -eq 'PAUSE'",
  "$positions -eq '0'",
  "$pending -eq '0'",
  "FINAL_STRATEGY_TASK_OWNERSHIP",
  "FINAL_STRATEGY_TASK_DRIFT",
  "FINAL_STRATEGY_TASK_READY",
  "FINAL_STRATEGY_TASK_PROBE_PROVIDER",
  "FINAL_STRATEGY_TASK_PROBE_RUNNER_HASH",
  "FINAL_STRATEGY_TASK_PROBE_OWNERSHIP_REASON",
  "FINAL_STRATEGY_TASK_PROBE_DRIFT",
  "FINAL_STRATEGY_TASK_READ_STATUS",
  "FINAL_STRATEGY_TASK_OWNERSHIP_EVALUATION",
  "FINAL_STRATEGY_TASK_RUNNER_HASH_STATUS",
  "FINAL_STRATEGY_TASK_RUNNER_PATH_STATUS",
  "FINAL_STRATEGY_TASK_RUNNER_SHA_STATUS",
  "FINAL_STRATEGY_TASK_RUNNER_MISSING_COMMAND",
  "FINAL_STRATEGY_TASK_ACTION_OWNERSHIP_STATUS",
  "FINAL_STRATEGY_TASK_DRIFT_EVALUATION_STATUS",
  "FINAL_STRATEGY_TASK_PRINCIPAL_EVALUATION_STATUS",
  "FINAL_STRATEGY_TASK_OWNERSHIP_ERROR_STAGE",
  "FINAL_STRATEGY_TASK_OWNERSHIP_ERROR_TYPE",
  "FINAL_STRATEGY_TASK_PROBE_PRINCIPAL_CANONICAL",
  "FINAL_STRATEGY_RAW_ACCOUNT_IDENTITY_PRINTED=FALSE",
]) {
  assert.ok(combined.includes(required), `missing runtime-readiness safety contract: ${required}`);
}

for (const forbidden of [
  "DISARM_LIVE",
  "ARM_LIVE",
  "lifecycle/stop",
  "lifecycle/start",
  "switch-phase7c-account-mode-local.ps1",
  "rollout-phase7c-production-source-transition-local.ps1",
  "recover-phase7c-runtime-ready-stable-deploy",
  "/v1/orders",
  "/v1/positions/",
  "-Method Post",
  "-Method Patch",
  "-Method Put",
  "-Method Delete",
  "git reset --hard",
  "git checkout main",
  "git pull",
  "git merge",
]) {
  assert.equal(
    combined.includes(forbidden),
    false,
    `read-only runtime-readiness path must not contain mutation primitive: ${forbidden}`,
  );
}

assert.match(
  workflow,
  /EXPECTED_MAIN:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\|\|\s*github\.sha\s*\}\}/,
  "read-only diagnostic must pin expected source to PR base/main SHA",
);
assert.match(workflow, /persist-credentials:\s*false/);
assert.match(wrapper, /RedirectStandardOutput/);
assert.match(wrapper, /RedirectStandardError/);
assert.match(wrapper, /Remove-Item -LiteralPath \$stdout,\$stderr/);
assert.match(wrapper, /\$proc\.ExitCode -notin @\(0,2\)/);
assert.match(wrapper, /\$runtimeOverall -eq 'EXACT_MATCH'/);
assert.match(wrapper, /\$classification -eq 'NO_RECOVERY_REQUIRED'/);
assert.match(wrapper, /\$taskOwnership -eq 'CANONICAL_SYSTEM'/);
assert.match(wrapper, /\$taskDrift -eq 'NONE'/);
assert.match(wrapper, /Get-ScheduledTask -TaskName 'XAUUSD-Phase7C-Executors'/);
assert.match(wrapper, /Test-Phase7CExecutorTaskActionOwnership/);
assert.match(wrapper, /Get-Phase7CExecutorTaskDrift/);

console.log("PHASE7C_FINAL_STRATEGY_RUNTIME_READINESS_READONLY_CONTRACT=PASS");
