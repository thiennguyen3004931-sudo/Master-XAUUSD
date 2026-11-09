import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isPhase7CAutoActivationSourceAllowed,
} from "../apps/api/src/services/phase7c-bot-mode.service.ts";
import {
  telegramModeForCallback,
  telegramModeForCommand,
} from "./phase7c-telegram-mode-logic.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath: string) => fs.readFileSync(path.resolve(root, relativePath), "utf8");

// AUTO is a privileged transition: only the dedicated Web control may activate it.
assert.equal(isPhase7CAutoActivationSourceAllowed("web-control-center"), true);
assert.equal(isPhase7CAutoActivationSourceAllowed("telegram"), false);
assert.equal(isPhase7CAutoActivationSourceAllowed("telegram-command"), false);
assert.equal(isPhase7CAutoActivationSourceAllowed("startup-scheduled-task"), false);
assert.equal(isPhase7CAutoActivationSourceAllowed("web-control-center-start"), false);

// Telegram keeps safety/manual strategy controls, including SEMI, but cannot activate AUTO.
assert.equal(telegramModeForCommand("/pause"), "PAUSE");
assert.equal(telegramModeForCommand("/tamdung"), "PAUSE");
assert.equal(telegramModeForCommand("/trend"), "TREND");
assert.equal(telegramModeForCommand("/sideway"), "SIDEWAY");
assert.equal(telegramModeForCommand("/auto"), null);
assert.equal(telegramModeForCommand("/tudong"), null);
assert.equal(telegramModeForCallback("p7c:PAUSE"), "PAUSE");
assert.equal(telegramModeForCallback("p7c:TREND"), "TREND");
assert.equal(telegramModeForCallback("p7c:SIDEWAY"), "SIDEWAY");
assert.equal(telegramModeForCallback("p7c:SEMI"), "SEMI");
assert.equal(telegramModeForCallback("p7c:AUTO"), null);

const apiSource = read("apps/web/src/api.ts");
assert.match(apiSource, /export async function setPhase7CBotMode/);
assert.match(apiSource, /if\s*\(mode\s*===\s*["']AUTO["']\)\s*\{[\s\S]*?enablePhase7CAuto\(\)/,
  "AUTO selected from the canonical mode UI must delegate to the existing guarded AUTO activation.");
assert.match(apiSource, /\/api\/v1\/phase7c\/bot-mode/,
  "non-AUTO modes must continue to use the canonical bot-mode endpoint.");
assert.match(apiSource, /source:\s*["']web-control-center["']/);

// The Control Center exposes the canonical mode set through one UI mutation helper.
// The helper above is responsible for preserving the guarded AUTO path.
const pageSource = read("apps/web/src/pages/Phase7CControlCenterPage.tsx");
assert.match(pageSource, /BOT_MODE_OPTIONS\s*=\s*\[[\s\S]*?["']AUTO["'][\s\S]*?["']TREND["'][\s\S]*?["']SIDEWAY["'][\s\S]*?["']SEMI["'][\s\S]*?["']PAUSE["'][\s\S]*?\]/);
assert.match(pageSource, /mutationFn:\s*\(mode:\s*Phase7cControlMode\)\s*=>\s*setPhase7CBotMode\(mode\)/);
assert.match(pageSource, /onClick=\{\(\)\s*=>\s*botModeAction\.mutate\(option\.mode\)\}/);
assert.doesNotMatch(pageSource, /setPhase7CBotMode\(["']AUTO["']\)/,
  "Control Center must not create a literal direct AUTO bot-mode mutation.");

const authorizationSource = read("apps/web/src/ui/Phase7CExecutionAuthorizationCard.tsx");
assert.match(authorizationSource, /enablePhase7CAuto/);
assert.match(authorizationSource, /mutationFn:\s*enablePhase7CAuto/);
assert.match(authorizationSource, /onClick=\{\(\)\s*=>\s*autoMutation\.mutate\(\)\}/);

// PAUSE remains available from the canonical mode list even when executors are not running.
const changeStart = pageSource.indexOf("const canChangeBotMode =");
const changeEnd = pageSource.indexOf("return (", changeStart);
assert.ok(changeStart >= 0 && changeEnd > changeStart, "cannot isolate canChangeBotMode source");
const canChangeBotModeSource = pageSource.slice(changeStart, changeEnd);
assert.match(canChangeBotModeSource, /controlEnabled\s*===\s*true/);
assert.doesNotMatch(canChangeBotModeSource, /\.running\s*===\s*true/);
assert.match(pageSource, /mode\s*===\s*option\.mode/,
  "the already-active mode, including PAUSE, may be disabled without removing PAUSE availability.");

// Lifecycle start must never enable AUTO as a side effect. Starting executors ends in PAUSE.
const lifecycleSource = read("apps/api/src/services/phase7c-lifecycle.service.ts");
assert.doesNotMatch(lifecycleSource, /phase7CBotModeService\.set\(\s*["']AUTO["']/);
assert.match(lifecycleSource, /web-control-center-ready-pause/);

// API route must enforce the Web-only AUTO source policy even though Web uses the stronger guarded AUTO endpoint.
const routeSource = read("apps/api/src/routes/phase7c.route.ts");
assert.match(routeSource, /isPhase7CAutoActivationSourceAllowed/);
assert.match(routeSource, /requestedMode\s*===\s*["']AUTO["']/);

console.log("PHASE7C_WEB_ONLY_AUTO_CONTROL_TEST=PASS");
