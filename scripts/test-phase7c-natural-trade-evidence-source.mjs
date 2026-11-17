import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

const schema = read("apps", "api", "src", "contracts", "phase7c-performance-effectiveness.schema.ts");
const service = read("apps", "api", "src", "services", "phase7c-performance-management-evidence.service.ts");
const trend = read("scripts", "run-phase7b-demo-controller.ts");

for (const field of ["favorablePrice", "closedVolume", "remainingVolume"]) {
  assert.ok(schema.includes(`${field}: number | null;`), `schema missing ${field}`);
}

assert.match(service, /favorablePrice:\s*finiteNumber\(raw\.favorable\)/);
assert.match(service, /closedVolume:\s*finiteNumber\(raw\.closedVolume\)/);
assert.match(service, /remainingVolume:\s*finiteNumber\(raw\.remainingVolume\)/);

assert.match(trend, /journal\("PLUS6_SL_TO_ENTRY"[\s\S]*?favorable[\s\S]*?stopLoss:\s*beStop/,
  "Trend +6 journal must retain favorable move and BE stop evidence");
assert.match(trend, /journal\("PLUS10_PARTIAL_ONE_THIRD"[\s\S]*?favorable[\s\S]*?closedVolume:\s*closeVolume[\s\S]*?remainingVolume:\s*managed\.expectedRemainingVolume/,
  "Trend +10 journal must retain partial volume evidence");

assert.doesNotMatch(service, /\b(?:writeFileSync|appendFileSync|rmSync|unlinkSync|renameSync)\b/,
  "P3 management evidence service must remain filesystem read-only");
assert.doesNotMatch(service, /\b(?:fetch|axios|Invoke-RestMethod|POST|PUT|PATCH|DELETE)\b/,
  "P3 management evidence service must not issue broker/API mutations");

console.log("PHASE7C_NATURAL_TRADE_EVIDENCE_SOURCE=PASS");
console.log("NATURAL_TRADE_EVIDENCE_FIELDS=FAVORABLE_CLOSED_REMAINING_VOLUME");
console.log("NATURAL_TRADE_EVIDENCE_MUTATION=NONE");
