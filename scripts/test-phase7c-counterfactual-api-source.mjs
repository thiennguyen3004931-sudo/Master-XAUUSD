import assert from "node:assert/strict";
import fs from "node:fs";

function read(path) {
  assert.equal(fs.existsSync(path), true, `Missing required P4 API source file: ${path}`);
  return fs.readFileSync(path, "utf8");
}

const routePath = "apps/api/src/routes/phase7c-counterfactual-intelligence.route.ts";
const appPath = "apps/api/src/app.ts";
const route = read(routePath);
const app = read(appPath);

assert.match(route, /getPhase7CCounterfactualIntelligence/);
assert.match(route, /router\.get\("\/"/);
assert.doesNotMatch(route, /router\.(post|put|patch|delete)\s*\(/i);
assert.match(route, /127\.0\.0\.1/);
assert.match(route, /::1/);
assert.match(route, /::ffff:127\.0\.0\.1/);
assert.match(route, /cache-control/i);
assert.match(route, /no-store/i);
assert.match(route, /days must be an integer between 7 and 365/);
assert.match(route, /limit must be an integer between 1 and 200/);

assert.match(app, /phase7c-counterfactual-intelligence\.route/);
assert.match(app, /\/api\/v1\/phase7c\/counterfactual-intelligence/);

console.log("P4_COUNTERFACTUAL_API_SOURCE_TEST=PASS");
console.log("P4_COUNTERFACTUAL_API=GET_ONLY_LOCALHOST");
console.log("P4_COUNTERFACTUAL_API_CACHE=NO_STORE");
