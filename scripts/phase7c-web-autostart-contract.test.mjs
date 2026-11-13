import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const autostart = readFileSync(
  new URL("./run-phase7b-web-autostart.ps1", import.meta.url),
  "utf8",
);
const activation = readFileSync(
  new URL("./activate-phase7c-local.ps1", import.meta.url),
  "utf8",
);

test("Web/API autostart allows slow Windows startup and persists child logs", () => {
  assert.match(autostart, /\[int\]\$StartupTimeoutSeconds = 90/);
  assert.match(autostart, /phase7b-web/);
  assert.match(autostart, /api\.err\.log/);
  assert.match(autostart, /web\.err\.log/);
  assert.match(autostart, /RedirectStandardOutput/);
  assert.match(autostart, /RedirectStandardError/);
});

test("Web/API autostart tears down full child trees after a partial failure", () => {
  assert.match(autostart, /function Stop-ProcessTree/);
  assert.match(autostart, /taskkill\.exe/);
  assert.match(autostart, /\/PID \$ProcessId \/T \/F/);
  assert.match(autostart, /Stop-ProcessTree \$apiProcess\.Id/);
  assert.match(autostart, /Stop-ProcessTree \$webProcess\.Id/);
});

test("Phase 7C activation reports the exact failed API or UI probe", () => {
  for (const step of [
    "phase7b-demo",
    "account-risk",
    "lot-settings",
    "bot-mode",
    "decision-monitor",
    "web-ui",
  ]) {
    assert.match(activation, new RegExp(`webSelfTestStep = "${step}"`));
  }
  assert.match(activation, /STEP=\$webSelfTestStep/);
  assert.match(activation, /DETAIL=\$webSelfTestError/);
});

test("Phase 7C activation removes project dev watchers before restarting ports", () => {
  assert.match(activation, /function Stop-ProjectCoreProcesses/);
  assert.match(activation, /--filter\\s\+\["''\]\?@xauusd\/\(api\|web\)/);
  assert.ok(activation.includes("phase7b-(api|web)-background-v\\d+\\.ps1"));
  assert.match(activation, /function Assert-CorePortsAvailable/);
  assert.match(activation, /Stop-ProcessTree \$rootPid/);
  assert.match(activation, /PHASE7C_ACTIVATE_CORE_PORTS_CLEAN=PASS/);
  assert.match(activation, /PHASE7C_ACTIVATE_LOT_ACTIVE_DETAIL/);
  assert.doesNotMatch(activation, /function Stop-PortOwner/);
});
