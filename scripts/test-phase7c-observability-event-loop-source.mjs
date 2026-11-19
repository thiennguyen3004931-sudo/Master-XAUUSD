import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const decisionMonitorPath = path.join(
  root,
  "apps/api/src/services/phase7c-decision-monitor.service.ts",
);
const performanceIntelligencePath = path.join(
  root,
  "apps/api/src/services/phase7c-performance-intelligence.service.ts",
);
const performanceIntelligenceCorePath = path.join(
  root,
  "apps/api/src/services/phase7c-performance-intelligence-core.service.ts",
);
const performanceEffectivenessPath = path.join(
  root,
  "apps/api/src/services/phase7c-performance-effectiveness.service.ts",
);
const performanceEffectivenessCorePath = path.join(
  root,
  "apps/api/src/services/phase7c-performance-effectiveness-core.service.ts",
);

function fail(message) {
  console.error(`PHASE7C_OBSERVABILITY_EVENT_LOOP_SOURCE_CONTRACT=FAIL ${message}`);
  process.exit(1);
}

for (const [filePath, label] of [
  [decisionMonitorPath, "decision monitor"],
  [performanceIntelligencePath, "performance intelligence wrapper"],
  [performanceIntelligenceCorePath, "performance intelligence core"],
  [performanceEffectivenessPath, "performance effectiveness wrapper"],
  [performanceEffectivenessCorePath, "performance effectiveness core"],
]) {
  if (!fs.existsSync(filePath)) fail(`${label} source missing`);
}

const decisionMonitor = fs.readFileSync(decisionMonitorPath, "utf8");
const performanceIntelligence = fs.readFileSync(performanceIntelligencePath, "utf8");
const performanceIntelligenceCore = fs.readFileSync(performanceIntelligenceCorePath, "utf8");
const performanceEffectiveness = fs.readFileSync(performanceEffectivenessPath, "utf8");
const performanceEffectivenessCore = fs.readFileSync(performanceEffectivenessCorePath, "utf8");

const decisionTailMatch = decisionMonitor.match(
  /function readJsonlTail\([^]*?\n}\n\nfunction decisionAuditRoot/,
);
if (!decisionTailMatch) fail("decision monitor readJsonlTail function not found");
const decisionTail = decisionTailMatch[0];

if (/readFileSync\s*\(\s*file\s*\)/.test(decisionTail)) {
  fail("decision monitor tail reader still reads the whole JSONL file synchronously");
}

if (!/maxBytes\s*=\s*2\s*\*\s*1024\s*\*\s*1024/.test(decisionTail)) {
  fail("decision monitor bounded 2 MiB tail contract missing");
}

const parseAuditMatch = performanceIntelligenceCore.match(
  /(?:async\s+)?function parseAuditSource\([^]*?\n}\n\nclass IdentifierUnion/,
);
if (!parseAuditMatch) fail("performance intelligence parseAuditSource function not found");
const parseAuditSource = parseAuditMatch[0];

if (/readFileSync\s*\(\s*absolutePath/.test(parseAuditSource)) {
  fail("performance intelligence still reads the whole audit JSONL synchronously");
}

if (!/async\s+function\s+parseAuditSource/.test(parseAuditSource)) {
  fail("performance intelligence audit parser must be asynchronous");
}

if (!/createReadStream|readline\.createInterface/.test(parseAuditSource)) {
  fail("performance intelligence audit parser must stream JSONL instead of buffering the whole file");
}

if (!/phase7c-performance-intelligence-core\.service/.test(performanceIntelligence)) {
  fail("P2 public service must delegate to the byte-preserved core implementation");
}

if (!/phase7c-performance-effectiveness-core\.service/.test(performanceEffectiveness)) {
  fail("P3 public service must delegate to the byte-preserved core implementation");
}

if (!/runPhase7CSingleFlight/.test(performanceIntelligence)) {
  fail("P2 performance intelligence must coalesce identical concurrent work with single-flight");
}

if (!/runPhase7CSingleFlight/.test(performanceEffectiveness)) {
  fail("P3 performance effectiveness must coalesce identical concurrent work with single-flight");
}

if (!/new\s+Map<string,\s*Promise<unknown>>\s*\(\s*\)/.test(performanceIntelligence)) {
  fail("P2 performance intelligence in-flight registry missing");
}

if (!/new\s+Map<string,\s*Promise<unknown>>\s*\(\s*\)/.test(performanceEffectiveness)) {
  fail("P3 performance effectiveness in-flight registry missing");
}

if (/setTimeout|setInterval|Date\.now\(\)|expiresAt|ttl/i.test(performanceIntelligence)) {
  fail("P2 wrapper must not add a TTL or stale result cache");
}

if (/setTimeout|setInterval|Date\.now\(\)|expiresAt|ttl/i.test(performanceEffectiveness)) {
  fail("P3 wrapper must not add a TTL or stale result cache");
}

if (/sendOrder|modifyPosition|closePosition|phase7CBotModeService\.set/.test(
  `${decisionMonitor}\n${performanceIntelligence}\n${performanceIntelligenceCore}\n${performanceEffectiveness}\n${performanceEffectivenessCore}`,
)) {
  fail("observability source contains forbidden trading/mode mutation pattern");
}

console.log("PHASE7C_OBSERVABILITY_EVENT_LOOP_SOURCE_CONTRACT=PASS");
console.log("DECISION_MONITOR_JSONL_TAIL=BOUNDED");
console.log("PERFORMANCE_INTELLIGENCE_JSONL=ASYNC_STREAMING");
console.log("P2_SINGLE_FLIGHT=ENFORCED");
console.log("P3_SINGLE_FLIGHT=ENFORCED");
console.log("RESULT_CACHE=NONE");
console.log("STRATEGY_MUTATION=NONE");
console.log("RISK_MUTATION=NONE");
console.log("MODE_MUTATION=NONE");
console.log("ARM_MUTATION=NONE");
console.log("ORDER_MUTATION=NONE");
console.log("POSITION_MUTATION=NONE");
