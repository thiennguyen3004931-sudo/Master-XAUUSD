import assert from "node:assert/strict";
import fs from "node:fs";

function read(path) {
  assert.equal(fs.existsSync(path), true, `Missing required P3 source file: ${path}`);
  return fs.readFileSync(path, "utf8");
}

const routePath = "apps/api/src/routes/phase7c-performance-effectiveness.route.ts";
const servicePath = "apps/api/src/services/phase7c-performance-effectiveness.service.ts";
const coreServicePath = "apps/api/src/services/phase7c-performance-effectiveness-core.service.ts";
const appPath = "apps/api/src/app.ts";
const typesPath = "apps/web/src/phase7c-performance-effectiveness-types.ts";
const apiPath = "apps/web/src/phase7c-performance-effectiveness-api.ts";
const cardPath = "apps/web/src/ui/Phase7CPerformanceEffectivenessCard.tsx";
const shellPath = "apps/web/src/pages/Phase7CControlCenterShellPage.tsx";
const workflowPath = ".github/workflows/phase7c-performance-effectiveness-ci.yml";

const route = read(routePath);
const serviceWrapper = read(servicePath);
const serviceCore = read(coreServicePath);
const service = `${serviceWrapper}\n${serviceCore}`;
const app = read(appPath);
const types = read(typesPath);
const api = read(apiPath);
const card = read(cardPath);
const shell = read(shellPath);
const workflow = read(workflowPath);

assert.match(route, /router\.get\("\/"/);
assert.doesNotMatch(route, /router\.(post|put|patch|delete)\s*\(/i);
assert.match(route, /127\.0\.0\.1/);
assert.match(route, /::1/);
assert.match(route, /cache-control/i);
assert.match(route, /no-store/i);
assert.match(route, /getPhase7CPerformanceEffectivenessSnapshot/);

assert.match(app, /phase7c-performance-effectiveness\.route/);
assert.match(app, /\/api\/v1\/phase7c\/performance-effectiveness/);

assert.match(api, /method:\s*"GET"/);
assert.match(api, /cache:\s*"no-store"/);
assert.match(api, /\/api\/v1\/phase7c\/performance-effectiveness/);
assert.doesNotMatch(api, /method:\s*"(POST|PUT|PATCH|DELETE)"/);

assert.match(types, /phase7c-performance-effectiveness-v1/);
assert.match(types, /"REVERSAL"/);
assert.match(types, /readOnly:\s*true/);
assert.match(types, /autoRetune:\s*false/);
assert.match(types, /liveTestOrder:\s*false/);

assert.match(card, /useState\(false\)/);
assert.match(card, /READ ONLY/);
assert.match(card, /SHADOW_ONLY/);
assert.match(card, /Hiện chi tiết/);
assert.match(card, /Ẩn chi tiết/);
assert.match(card, /TREND \+10 \/ giveback 10/);
assert.match(card, /SIDEWAY \+10 \/ giveback 10/);
assert.match(card, /REVERSAL expectancy/);
assert.doesNotMatch(card, /TREND \+10 \/ giveback 6/);
assert.doesNotMatch(card, /SIDEWAY \+10 \/ giveback 4/);
assert.doesNotMatch(card, /\b(Lưu|Áp dụng|Apply|Retune|Tự tối ưu)\b/i);
assert.doesNotMatch(card, /method:\s*"(POST|PUT|PATCH|DELETE)"/);

assert.match(shell, /Phase7CPerformanceEffectivenessCard/);

assert.match(serviceWrapper, /phase7c-performance-effectiveness-core\.service/);
assert.match(serviceWrapper, /runPhase7CSingleFlight/);
assert.match(service, /runtimeMutation:\s*false/);
assert.match(service, /strategyMutation:\s*false/);
assert.match(service, /riskMutation:\s*false/);
assert.match(service, /orderMutation:\s*false/);
assert.match(service, /positionMutation:\s*false/);
assert.match(service, /modeMutation:\s*false/);
assert.match(service, /armMutation:\s*false/);
assert.match(service, /autoRetune:\s*false/);
assert.match(service, /liveTestOrder:\s*false/);
assert.match(service, /givebackPrice:\s*10/);
assert.match(service, /performanceStrategy/);
assert.match(service, /executionStrategy/);
assert.doesNotMatch(service, /givebackPrice:\s*strategy\s*===\s*"TREND"\s*\?\s*6\s*:\s*4/);
assert.doesNotMatch(service, /fetch\([^\n]+\{[^}]*method:\s*"(POST|PUT|PATCH|DELETE)"/is);

assert.match(workflow, /apps\/api\/src\/services\/phase7c-performance-effectiveness-core\.service\.ts/);
assert.match(workflow, /apps\/api\/src\/services\/phase7c-single-flight\.ts/);

console.log("P3_PERFORMANCE_EFFECTIVENESS_SOURCE_TEST=PASS");
console.log("P3_API=GET_ONLY_LOCALHOST");
console.log("P3_UI_MUTATION=NONE");
console.log("P3_FAST_MOVE_CURRENT_CONTRACT=ACTIVATION_10_GIVEBACK_10");
console.log("P3_FAST_MOVE_SHADOW=SHADOW_ONLY");