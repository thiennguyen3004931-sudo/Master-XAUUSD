import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptsDir, "..");

const trend = readFileSync(path.join(scriptsDir, "run-phase7c-trend-controller.mjs"), "utf8");
const sideway = readFileSync(path.join(scriptsDir, "run-phase7c-sideway-locked.mjs"), "utf8");
const route = readFileSync(path.join(projectRoot, "apps", "api", "src", "routes", "phase7c.route.ts"), "utf8");
const service = readFileSync(path.join(projectRoot, "apps", "api", "src", "services", "phase7c-bot-mode.service.ts"), "utf8");

test("Trend rechecks bot mode after position recheck and immediately before broker submit", () => {
  const positionIndex = trend.indexOf("const positions = await fetchOpenPositionsUnderLock(request)");
  const finalModeIndex = trend.indexOf('const finalModePayload = await controlRequest("/api/v1/phase7c/bot-mode")', positionIndex);
  const changedBlockIndex = trend.indexOf("BOT_MODE_CHANGED_BEFORE_BROKER_SUBMIT", finalModeIndex);
  const submitIndex = trend.indexOf("return await nativeFetch(input, init)", finalModeIndex);

  assert.ok(positionIndex >= 0);
  assert.ok(finalModeIndex > positionIndex, "Trend final mode recheck must happen after position recheck under the shared lock.");
  assert.ok(changedBlockIndex > finalModeIndex);
  assert.ok(submitIndex > changedBlockIndex, "Trend broker submit must occur only after final mode recheck.");
});

test("Sideway rechecks bot mode after position recheck and before canonical broker submit", () => {
  const positionIndex = sideway.indexOf("const positions = await fetchOpenPositionsUnderLock(request)");
  const finalModeIndex = sideway.indexOf('const finalModePayload = await controlRequest("/api/v1/phase7c/bot-mode")', positionIndex);
  const finalPermissionIndex = sideway.indexOf("const finalPermission = resolveSidewayPermission", finalModeIndex);
  const changedBlockIndex = sideway.indexOf("BOT_MODE_CHANGED_BEFORE_BROKER_SUBMIT", finalPermissionIndex);
  const submitIndex = sideway.indexOf("return await nativeFetch(input, init)", changedBlockIndex);

  assert.ok(positionIndex >= 0);
  assert.ok(finalModeIndex > positionIndex, "Sideway final mode recheck must happen after position recheck under the shared lock.");
  assert.ok(finalPermissionIndex > finalModeIndex);
  assert.ok(changedBlockIndex > finalPermissionIndex);
  assert.ok(submitIndex > changedBlockIndex, "Sideway broker submit must occur only after final mode recheck.");
});

test("PAUSE API persists PAUSE then waits for execution-lock drain before success response", () => {
  assert.match(route, /router\.post\("\/bot-mode",\s*async/);
  const setIndex = route.indexOf("const state = phase7CBotModeService.set(requestedMode, source)");
  const pauseIndex = route.indexOf('if (requestedMode === "PAUSE")', setIndex);
  const barrierIndex = route.indexOf("await phase7CBotModeService.waitForPauseBarrierDrain()", pauseIndex);
  const successIndex = route.indexOf("res.json({", barrierIndex);

  assert.ok(setIndex >= 0);
  assert.ok(pauseIndex > setIndex, "PAUSE must be durable before waiting for in-flight entry to drain.");
  assert.ok(barrierIndex > pauseIndex);
  assert.ok(successIndex > barrierIndex, "PAUSE success response must happen only after the entry barrier drains.");

  assert.match(
    service,
    /resolve\(dirname\(this\.filePath\),\s*"phase7c-executors",\s*"phase7c-execution\.lock"\)/,
    "API PAUSE barrier must target the same canonical execution-lock location used by Trend/Sideway.",
  );
  assert.match(service, /while\s*\(existsSync\(this\.executionLockPath\)\)/);
});
