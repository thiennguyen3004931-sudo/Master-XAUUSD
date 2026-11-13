import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const servicePath = path.join(root, "apps/api/src/services/phase7c-performance-intelligence.service.ts");
const coreServicePath = path.join(root, "apps/api/src/services/phase7c-performance-intelligence-core.service.ts");
const correlationServicePath = path.join(root, "apps/api/src/services/phase7c-performance-correlation.service.ts");
const schemaPath = path.join(root, "apps/api/src/contracts/phase7c-performance-correlation.schema.ts");
const routePath = path.join(root, "apps/api/src/routes/phase7c-performance-intelligence.route.ts");
const appPath = path.join(root, "apps/api/src/app.ts");
const webApiPath = path.join(root, "apps/web/src/phase7c-performance-intelligence-api.ts");
const webTypesPath = path.join(root, "apps/web/src/phase7c-performance-intelligence-types.ts");
const webCardPath = path.join(root, "apps/web/src/ui/Phase7CPerformanceIntelligenceCard.tsx");
const webShellPath = path.join(root, "apps/web/src/pages/Phase7CControlCenterShellPage.tsx");
const workflowPath = path.join(root, ".github/workflows/phase7c-performance-intelligence-ci.yml");

function fail(message) {
  console.error(`P2_PERFORMANCE_INTELLIGENCE_SOURCE_CONTRACT=FAIL ${message}`);
  process.exit(1);
}

function mustContain(text, needle, label) {
  if (!text.includes(needle)) fail(`${label} missing ${needle}`);
}

function mustNotContain(text, needle, label) {
  if (text.includes(needle)) fail(`${label} contains stale ${needle}`);
}

for (const [filePath, label] of [
  [servicePath, "service wrapper"],
  [coreServicePath, "service core"],
  [correlationServicePath, "correlation service"],
  [schemaPath, "correlation schema"],
  [routePath, "route"],
  [appPath, "app"],
  [webApiPath, "web API"],
  [webTypesPath, "web types"],
  [webCardPath, "web card"],
  [webShellPath, "web shell"],
  [workflowPath, "workflow"],
]) {
  if (!fs.existsSync(filePath)) fail(`${label} file missing`);
}

const serviceWrapper = fs.readFileSync(servicePath, "utf8");
const serviceCore = fs.readFileSync(coreServicePath, "utf8");
const service = `${serviceWrapper}\n${serviceCore}`;
const correlationService = fs.readFileSync(correlationServicePath, "utf8");
const schema = fs.readFileSync(schemaPath, "utf8");
const route = fs.readFileSync(routePath, "utf8");
const app = fs.readFileSync(appPath, "utf8");
const webApi = fs.readFileSync(webApiPath, "utf8");
const webTypes = fs.readFileSync(webTypesPath, "utf8");
const webCard = fs.readFileSync(webCardPath, "utf8");
const webShell = fs.readFileSync(webShellPath, "utf8");
const workflow = fs.readFileSync(workflowPath, "utf8");

mustContain(serviceWrapper, 'phase7c-performance-intelligence-core.service', "service wrapper");
mustContain(serviceWrapper, 'runPhase7CSingleFlight', "service wrapper");
mustContain(service, 'getMt5PerformanceSnapshot', "service");
mustContain(service, 'EXACT', "service");
mustContain(service, 'AMBIGUOUS', "service");
mustContain(service, 'UNMATCHED', "service");
mustContain(service, 'correlationCoverage', "service");
mustContain(service, 'readOnly: true', "service");
mustContain(service, 'strategyMutation: false', "service");
mustContain(service, 'riskMutation: false', "service");
mustContain(service, 'orderMutation: false', "service");
mustContain(service, 'positionMutation: false', "service");
mustContain(service, 'autoRetune: false', "service");
mustContain(service, 'version: 2', "service");
mustContain(service, 'PerformanceStrategy = Strategy | "REVERSAL"', "service");
mustContain(service, 'entryPolicy', "service");
mustContain(service, 'performanceStrategy', "service");
mustContain(service, 'filterAuditSourcesByWindow', "service");
mustContain(service, 'occurredAtMs', "service");
mustContain(service, 'entryFunnel: buildEntryFunnel(windowedAuditSources)', "service");
mustContain(service, 'confirmationAgeBars', "service");
mustContain(service, 'sidewayM5Confirmation', "service");
mustContain(service, '"M5_CARRY_1"', "service");
mustContain(service, 'aggregateSidewayM5ConfirmationAge', "service");
mustContain(service, 'for (const source of windowedAuditSources)', "service");
mustContain(service, 'blockedReasons', "service");
mustContain(service, 'blockReasons', "service");
mustContain(service, 'entryBlockReasonsOf', "service");
mustContain(service, 'eventName.startsWith("ENTRY_")', "service");

mustContain(correlationService, 'buildPhase7CPerformanceCorrelationBackfill', "correlation service");
mustContain(correlationService, 'PHASE7C_PERFORMANCE_CORRELATION_SCHEMA_VERSION', "correlation service");
mustContain(correlationService, 'getPhase7CPerformanceIntelligence', "correlation service");
mustContain(correlationService, 'runtimeMutation: false', "correlation service");
mustContain(correlationService, 'candidatePositionCount', "correlation service");
mustContain(correlationService, 'no timestamp or price proximity matching is introduced', "correlation service");

mustContain(service, 'decisionAuditRoot', "service");
mustContain(service, '"phase7c-executors", "decision-observability"', "service");
mustContain(service, 'accountMode.toLowerCase()', "service");
mustContain(service, '"trend-decisions.jsonl"', "service");
mustContain(service, '"sideway-decisions.jsonl"', "service");
mustNotContain(service, 'phase7b-live-forward-decision-audit.jsonl', "service");
mustNotContain(service, 'phase7c-sideway-decision-observability.jsonl', "service");

mustContain(service, '"entryState"', "service");
mustContain(service, 'record.conditions', "service");
mustContain(service, 'status === "PASS"', "service");
mustContain(service, 'status === "FAIL"', "service");

mustContain(service, 'EXPLICIT_IDENTITY_GRAPH', "service");
mustContain(service, '"POSITION"', "service");
mustContain(service, '"ORDER"', "service");
mustContain(service, '"SIGNAL"', "service");
mustContain(service, 'no timestamp or price proximity matching is used', "service");

mustContain(schema, 'phase7c-performance-correlation-v1', "schema");
mustContain(schema, 'Phase7CPerformanceCorrelationRow', "schema");
mustContain(schema, 'candidatePositionCount', "schema");
mustContain(schema, 'EXACT', "schema");
mustContain(schema, 'AMBIGUOUS', "schema");
mustContain(schema, 'UNMATCHED', "schema");
mustContain(schema, 'MT5_ACCOUNT_READ_ONLY', "schema");

mustContain(route, 'router.get("/"', "route");
mustContain(route, 'router.get("/correlations"', "route");
if (/router\.(post|put|patch|delete)\s*\(/i.test(route)) fail("route must be GET-only");
mustContain(route, 'getPhase7CPerformanceIntelligence', "route");
mustContain(route, 'buildPhase7CPerformanceCorrelationBackfill', "route");

mustContain(app, 'phase7c-performance-intelligence.route', "app");
mustContain(app, 'app.use("/api/v1/phase7c/performance-intelligence"', "app");

mustContain(webApi, '/api/v1/phase7c/performance-intelligence', "web API");
mustContain(webApi, 'method: "GET"', "web API");
mustContain(webApi, 'cache: "no-store"', "web API");
mustNotContain(webApi.toLowerCase(), 'method: "post"', "web API");
mustNotContain(webApi.toLowerCase(), 'method: "put"', "web API");
mustNotContain(webApi.toLowerCase(), 'method: "patch"', "web API");
mustNotContain(webApi.toLowerCase(), 'method: "delete"', "web API");
mustContain(webTypes, 'Phase7CPerformanceIntelligenceSnapshot', "web types");
mustContain(webTypes, 'version: 2', "web types");
mustContain(webTypes, '"REVERSAL"', "web types");
mustContain(webTypes, 'entryFunnel', "web types");
mustContain(webTypes, 'sidewayM5Confirmation', "web types");
mustContain(webTypes, 'confirmationAgeBars', "web types");
mustContain(webTypes, 'Phase7CPerformanceCorrelationRow', "web types");
mustContain(webCard, 'Performance Intelligence v2', "web card");
mustContain(webCard, 'Entry funnel / blocked reasons', "web card");
mustContain(webCard, 'Sideway M5 confirmation age', "web card");
mustContain(webCard, 'READ ONLY', "web card");
mustContain(webCard, 'refetchInterval: 15000', "web card");
mustContain(webShell, 'Phase7CPerformanceIntelligenceCard', "web shell");

mustContain(workflow, 'apps/api/src/services/phase7c-performance-intelligence-core.service.ts', "workflow");
mustContain(workflow, 'apps/api/src/services/phase7c-single-flight.ts', "workflow");
mustContain(workflow, 'apps/web/src/ui/Phase7CPerformanceIntelligenceCard.tsx', "workflow");
mustContain(workflow, 'scripts/phase7c-performance-correlation-schema.test.ts', "workflow");
mustContain(workflow, 'Build web dependency graph', "workflow");

const forbiddenServicePatterns = [
  /sendOrder/i,
  /modifyPosition/i,
  /closePosition/i,
  /phase7CBotModeService\.set/,
  /Write-Phase7CLiveArmState/,
];
for (const [label, text] of [["service", service], ["correlation service", correlationService]]) {
  for (const pattern of forbiddenServicePatterns) {
    if (pattern.test(text)) fail(`${label} contains forbidden mutation pattern ${pattern}`);
  }
}

console.log("P2_PERFORMANCE_INTELLIGENCE_SOURCE_CONTRACT=PASS");
console.log("P2_PERFORMANCE_INTELLIGENCE_ROUTE=GET_ONLY");
console.log("P2_PERFORMANCE_INTELLIGENCE_ACCOUNTING=REUSES_MT5_PERFORMANCE");
console.log("P2_PERFORMANCE_INTELLIGENCE_AUDIT_PATH=CANONICAL_ACCOUNT_AWARE");
console.log("P2_PERFORMANCE_INTELLIGENCE_RULE_EVIDENCE=CANONICAL_ENTRY_CONDITIONS");
console.log("P2_PERFORMANCE_INTELLIGENCE_CORRELATION=EXPLICIT_IDENTITY_GRAPH_FAIL_CLOSED");
console.log("P2_PERFORMANCE_INTELLIGENCE_SCHEMA=VERSIONED_CANONICAL_V2");
console.log("P2_PERFORMANCE_INTELLIGENCE_UI=READ_ONLY");
console.log("P2_PERFORMANCE_INTELLIGENCE_RUNTIME_MUTATION=NONE");