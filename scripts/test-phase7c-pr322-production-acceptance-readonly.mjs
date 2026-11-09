import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const probePath = resolve(process.cwd(), "scripts", "probe-phase7c-pr322-production-acceptance-readonly-local.ps1");
const source = readFileSync(probePath, "utf8");

for (const invariant of [
  "READ_ONLY=TRUE",
  "HTTP_METHODS=GET_ONLY",
  "GIT_MUTATION=NONE",
  "TASK_MUTATION=NONE",
  "PROCESS_MUTATION=NONE",
  "MODE_MUTATION=NONE",
  "ARM_MUTATION=NONE",
  "ORDER_MUTATION=NONE",
  "POSITION_MUTATION=NONE",
  "LIVE_TEST_ORDER=NONE",
  "BRIDGE_RESTART=NONE",
]) {
  assert.ok(source.includes(invariant), `missing safety invariant ${invariant}`);
}

for (const endpoint of [
  "/api/v1/phase7c/bot-mode",
  "/api/v1/phase7c/decision-monitor?symbol=XAUUSD",
  "/api/v1/phase7c/lifecycle",
  "/api/v1/phase7c/runtime-source-attestation",
  "/api/v1/phase7c-live-arm-control/capability",
]) {
  assert.ok(source.includes(endpoint), `missing canonical GET endpoint ${endpoint}`);
}

assert.ok(source.includes("preflight-phase7c-production-readonly-local.ps1"), "PR322 acceptance must reuse the canonical production read-only preflight");
assert.ok(source.includes("CANONICAL_PREFLIGHT_RESULT"), "probe must expose canonical preflight result");
assert.ok(source.includes("CANONICAL_PREFLIGHT_FAIL"), "canonical preflight failure must fail PR322 acceptance closed");
assert.ok(source.includes("state.updatedAt"), "AUTO activation freshness must use bot-mode.state.updatedAt");
assert.ok(source.includes("engine.checkedAt"), "decision freshness must use decision-monitor.engine.checkedAt");
assert.ok(source.includes("lastCandleCloseTime"), "probe must expose M15 candle evidence");
assert.ok(source.includes("DECISION_AFTER_AUTO"), "probe must report decision-after-AUTO evidence");
assert.ok(source.includes("M15_AFTER_AUTO"), "probe must require a post-AUTO M15 candle");
assert.ok(source.includes("DECISION_FRESH"), "probe must report decision freshness");
assert.ok(source.includes("PENDING_FRESH_DECISION"), "probe must fail closed when no post-AUTO decision exists");
assert.ok(source.includes("$verdict = 'PASS'"), "probe must define an explicit PASS verdict branch");
assert.ok(source.includes("$verdict = 'FAIL'"), "probe must define explicit FAIL verdict branches");
assert.ok(source.includes('PR322_PRODUCTION_ACCEPTANCE=$verdict'), "probe must emit its final PR322 acceptance verdict");
assert.ok(source.includes("UI_GENERATED_AT_REFERENCE_ONLY"), "generatedAt may be reported only as reference evidence");

assert.doesNotMatch(source, /generatedAt\s*(?:-gt|-ge|>|>=)\s*\$?mode/i, "generatedAt must not establish decision freshness");
assert.doesNotMatch(source, /Invoke-(?:RestMethod|WebRequest)[^\n]*-Method\s+(?:Post|Put|Patch|Delete)/i, "probe must never issue mutating HTTP methods");
assert.doesNotMatch(source, /\b(?:Stop-Process|Start-Process|Stop-ScheduledTask|Start-ScheduledTask|Set-Content|Add-Content|Remove-Item|Move-Item|Copy-Item)\b/i, "probe must not mutate process/task/filesystem state");

console.log("PHASE7C_PR322_PRODUCTION_ACCEPTANCE_READONLY_CONTRACT=PASS");
