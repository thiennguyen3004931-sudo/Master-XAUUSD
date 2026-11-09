import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const probePath = resolve(
  process.cwd(),
  "scripts",
  "probe-phase7c-production-historical-acceptance-readonly-local.ps1",
);

assert.ok(
  existsSync(probePath),
  "production historical acceptance read-only probe must exist",
);

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

assert.ok(
  source.includes("preflight-phase7c-production-readonly-local.ps1"),
  "historical acceptance must reuse the canonical production read-only preflight",
);
assert.ok(source.includes("CANONICAL_PREFLIGHT_RESULT"), "probe must expose canonical preflight result");
assert.ok(source.includes("CANONICAL_PREFLIGHT_FAIL"), "canonical preflight failure must fail acceptance closed");
assert.ok(
  source.includes("PREFLIGHT_CLASSIFICATION=NO_RECOVERY_REQUIRED"),
  "historical acceptance must require canonical preflight to prove no recovery is required",
);
assert.ok(
  source.includes("CANONICAL_RUNTIME_SOURCE=EXACT"),
  "probe must expose that the deployed runtime source is exact before candle acceptance",
);
assert.ok(
  source.includes("RUNTIME_SOURCE_NOT_EXACT"),
  "probe must fail closed when canonical preflight passes only because recovery is allowed",
);

for (const productionMarker of [
  "ACCOUNT_MODE=LIVE",
  "BRIDGE_ACCOUNT_MODE_MATCH=True",
  "BRIDGE_ACCOUNT_IDENTITY_MATCH=True",
  "LIVE_AUTHORIZATION_VALID=True",
  "UNRESOLVED_MUTATING_REQUESTS=0",
  "LIVE_EXECUTION_ARMED=False",
]) {
  assert.ok(
    source.includes(productionMarker),
    `historical acceptance must require stable LIVE production evidence ${productionMarker}`,
  );
}

for (const failClosedReason of [
  "PRODUCTION_LIVE_ACCOUNT_REQUIRED",
  "UNRESOLVED_MUTATING_REQUESTS_PRESENT",
  "LIVE_EXECUTION_ARMED_NOT_FALSE",
]) {
  assert.ok(source.includes(failClosedReason), `missing fail-closed reason ${failClosedReason}`);
}

for (const endpoint of [
  "/v1/candles/XAUUSD",
  "/v1/history/candles/XAUUSD",
  "/v1/positions?symbol=XAUUSD",
  "/v1/orders?symbol=XAUUSD",
]) {
  assert.ok(source.includes(endpoint), `missing canonical bridge GET endpoint ${endpoint}`);
}

for (const marker of [
  "TIMEFRAME=M5",
  "SAMPLE_COUNT=3",
  "MODE=PAUSE",
  "ARM=DISARMED",
  "XAUUSD_POSITIONS=0",
  "XAUUSD_PENDING_ORDERS=0",
  "OPEN_TIME=EXACT",
  "CLOSE_TIME=EXACT",
  "OPEN=EXACT",
  "HIGH=EXACT",
  "LOW=EXACT",
  "CLOSE=EXACT",
  "PHASE7C_PRODUCTION_HISTORICAL_ACCEPTANCE=$verdict",
]) {
  assert.ok(source.includes(marker), `missing historical acceptance marker ${marker}`);
}

for (const field of ["openTime", "closeTime", "open", "high", "low", "close"]) {
  assert.ok(source.includes(field), `historical parity must compare ${field}`);
}

assert.ok(source.includes("$verdict = 'PASS'"), "probe must define an explicit PASS verdict branch");
assert.ok(source.includes("$verdict = 'FAIL'"), "probe must define explicit FAIL verdict branches");

assert.ok(
  source.includes("$parsed = $raw | ConvertFrom-Json"),
  "Read-BridgeArray must materialize ConvertFrom-Json output before enumeration so Windows PowerShell 5.1 JSON arrays are flattened candle-by-candle",
);
assert.match(
  source,
  /\$parsed\s*\|\s*Where-Object\s*\{\s*\$null\s*-ne\s*\$_\s*\}/,
  "Read-BridgeArray must enumerate the materialized parsed array before returning rows",
);
assert.doesNotMatch(
  source,
  /\$raw\s*\|\s*ConvertFrom-Json\s*\|\s*Where-Object/,
  "Read-BridgeArray must not pipe ConvertFrom-Json directly into Where-Object because Windows PowerShell 5.1 can preserve the JSON array as one Object[] pipeline object",
);

assert.doesNotMatch(
  source,
  /Invoke-(?:RestMethod|WebRequest)[^\n]*-Method\s+(?:Post|Put|Patch|Delete)/i,
  "probe must never issue mutating HTTP methods",
);
assert.doesNotMatch(
  source,
  /\b(?:Stop-Process|Start-Process|Stop-ScheduledTask|Start-ScheduledTask|Set-Content|Add-Content|Remove-Item|Move-Item|Copy-Item)\b/i,
  "probe must not mutate process/task/filesystem state",
);
assert.doesNotMatch(
  source,
  /(?:10800|10_?800|3\s*\*\s*60\s*\*\s*60|AddHours\s*\(\s*3\s*\))/i,
  "probe must not hard-code a GMT+3 broker offset",
);
assert.doesNotMatch(
  source,
  /20\d{2}[-\/]\d{1,2}[-\/]\d{1,2}/,
  "probe must not depend on a fixed historical date",
);

console.log("PHASE7C_PRODUCTION_HISTORICAL_ACCEPTANCE_READONLY_CONTRACT=PASS");
