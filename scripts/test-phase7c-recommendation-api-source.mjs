import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const exists = (relative) => fs.existsSync(path.join(root, relative));

const routePath = "apps/api/src/routes/phase7c-recommendation-intelligence.route.ts";
assert.equal(exists(routePath), true, `missing ${routePath}`);

const route = read(routePath);
const app = read("apps/api/src/app.ts");

assert.match(route, /router\.get\("\/"/);
assert.doesNotMatch(route, /router\.(post|put|patch|delete)\(/i);
assert.match(route, /cache-control/i);
assert.match(route, /no-store/i);
assert.match(route, /Recommendation intelligence is restricted to localhost\./);
assert.match(app, /phase7c\/recommendation-intelligence/);
assert.match(app, /phase7cRecommendationIntelligenceRouter/);

const normalized = route.toLowerCase();
for (const forbidden of [
  "router.post",
  "router.put",
  "router.patch",
  "router.delete",
  "applyrecommendation",
  "retunerecommendation",
  "starts-scheduledtask",
  "stop-scheduledtask",
]) {
  assert.equal(normalized.includes(forbidden), false, `forbidden P5 API mutation surface: ${forbidden}`);
}

for (const forbiddenPath of ["/apply", "/retune", "/save", "/strategy", "/risk", "/arm", "/mode"]) {
  assert.equal(normalized.includes(`\"${forbiddenPath}`), false, `forbidden P5 route path: ${forbiddenPath}`);
}

console.log("PHASE7C_RECOMMENDATION_API_SOURCE_CONTRACT=PASS");
