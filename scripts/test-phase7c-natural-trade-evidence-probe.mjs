import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const probePath = path.resolve(process.cwd(), "scripts", "probe-phase7c-natural-trade-evidence-readonly-local.ps1");
const source = fs.readFileSync(probePath, "utf8");

for (const invariant of [
  "READ_ONLY=TRUE",
  "HTTP_METHODS=GET_ONLY",
  "MODE_MUTATION=NONE",
  "ARM_MUTATION=NONE",
  "ORDER_MUTATION=NONE",
  "POSITION_MUTATION=NONE",
  "LIVE_TEST_ORDER=NONE",
]) {
  assert.ok(source.includes(invariant), `missing read-only invariant ${invariant}`);
}

assert.ok(source.includes("/api/v1/phase7c/performance-effectiveness?symbol=XAUUSD"), "probe must use canonical P3 GET endpoint");
assert.ok(source.includes("EXACT"), "probe must require exact evidence for runtime proof");
assert.ok(source.includes("BREAK_EVEN"), "probe must inspect BE events");
assert.ok(source.includes("PARTIAL_CLOSE"), "probe must inspect partial events");
assert.ok(source.includes("FAST_MOVE_TIGHTEN"), "probe must inspect FastMove events");
assert.ok(source.includes("FAST_MOVE_HANDOFF_M5_STRUCTURE"), "probe must inspect one-way handoff evidence");
assert.ok(source.includes("M5_STRUCTURAL_TIGHTEN"), "probe must inspect M5 tightening evidence");
assert.ok(source.includes("NO_NATURAL_TRADE_EVIDENCE"), "no evidence must be distinguished from trading failure");
assert.ok(source.includes("PARTIAL_EVIDENCE"), "partial coverage must be explicit");
assert.ok(source.includes("COVERAGE_PASS"), "full observable coverage must have an explicit verdict");
assert.ok(source.includes("OBSERVED_CONTRACT_VIOLATION"), "observed safety/management violations must have an explicit fail-closed verdict");
assert.ok(source.includes("BROKER_STEP_LEGALITY_UNPROVEN"), "one-third proof must fail closed when broker-step evidence is unavailable");
assert.ok(source.includes("PEAK_PERSISTENCE_RUNTIME=NOT_PROVEN_BY_P3_V1"), "P3 v1 must not overclaim peak persistence runtime proof");
assert.match(source, /if \(\$classification -eq 'OBSERVED_CONTRACT_VIOLATION'\) \{ exit 2 \}/,
  "observed FastMove-after-handoff or SL-widening violations must exit nonzero");
assert.doesNotMatch(source, /-Method\s+(?:Post|Put|Patch|Delete)/i, "probe must never issue mutating HTTP methods");
assert.doesNotMatch(source, /\b(?:Stop-Process|Start-Process|Stop-ScheduledTask|Start-ScheduledTask|Set-Content|Add-Content|Remove-Item|Move-Item|Copy-Item)\b/i, "probe must not mutate local runtime state");

console.log("PHASE7C_NATURAL_TRADE_EVIDENCE_PROBE_CONTRACT=PASS");
