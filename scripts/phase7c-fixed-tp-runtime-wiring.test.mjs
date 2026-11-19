import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptsDir, "..");

const supervisor = readFileSync(path.join(scriptsDir, "run-phase7c-executors-local.ps1"), "utf8");
const trendLauncher = readFileSync(path.join(scriptsDir, "run-phase7c-trend-controller-local.ps1"), "utf8");
const sidewayLauncher = readFileSync(path.join(scriptsDir, "run-phase7c-sideway-controller-local.ps1"), "utf8");
const settingsService = readFileSync(
  path.join(projectRoot, "apps", "api", "src", "services", "phase7c-lot-settings.service.ts"),
  "utf8",
);

function sourceBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `source block must contain ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `source block must contain ${endMarker} after ${startMarker}`);
  return source.slice(start, end);
}

test("supervisor canonicalizes v1/v2 settings before runtime materialization", () => {
  assert.match(
    supervisor,
    /\$runtimeSettings\s*=\s*Assert-Phase7CRiskProfile\s+\$lotSettings\s+"Active Phase7C lot settings"/,
    "RED_TARGET: supervisor must consume the canonical v2 object returned by Assert-Phase7CRiskProfile.",
  );
  for (const property of [
    "trendFixedTpEnabled",
    "trendFixedTpDistance",
    "sidewayFixedTpEnabled",
    "sidewayFixedTpDistance",
  ]) {
    assert.match(
      supervisor,
      new RegExp(`\\$runtimeSettings\\.${property}`),
      `RED_TARGET: supervisor must materialize canonical ${property}.`,
    );
  }
});

test("active runtime settings persist schema v2 and all four Fixed TP fields", () => {
  const activeBlock = sourceBlock(supervisor, "function Write-ActiveLotSettings", "function Start-TelegramModeChild");
  assert.match(activeBlock, /version\s*=\s*2/, "RED_TARGET: active runtime settings must be schema v2.");
  assert.match(activeBlock, /trendFixedTpEnabled\s*=\s*\$TrendFixedTpEnabled/);
  assert.match(activeBlock, /trendFixedTpDistance\s*=\s*\$TrendFixedTpDistance/);
  assert.match(activeBlock, /sidewayFixedTpEnabled\s*=\s*\$SidewayFixedTpEnabled/);
  assert.match(activeBlock, /sidewayFixedTpDistance\s*=\s*\$SidewayFixedTpDistance/);

  for (const property of [
    "trendFixedTpEnabled",
    "trendFixedTpDistance",
    "sidewayFixedTpEnabled",
    "sidewayFixedTpDistance",
  ]) {
    assert.match(
      settingsService,
      new RegExp(`active\\.${property}\\s*!==\\s*state\\.${property}`),
      `configured-vs-active drift must include ${property}`,
    );
  }
});

test("supervisor routes only strategy-specific Fixed TP inputs to each launcher", () => {
  const trendArgs = sourceBlock(supervisor, "$trendArgs = @(", "$sidewayArgs = @(");
  const sidewayArgs = sourceBlock(supervisor, "$sidewayArgs = @(", "if ($AccountMode -eq \"LIVE\"");

  assert.match(trendArgs, /-FixedTpDistance/,
    "RED_TARGET: Trend launcher args must carry Trend Fixed TP distance.");
  assert.match(trendArgs, /\$TrendFixedTpDistance/);
  assert.doesNotMatch(trendArgs, /SidewayFixedTp/,
    "Trend args must never receive Sideway Fixed TP settings.");

  assert.match(sidewayArgs, /-FixedTpDistance/,
    "RED_TARGET: Sideway launcher args must carry Sideway Fixed TP distance.");
  assert.match(sidewayArgs, /\$SidewayFixedTpDistance/);
  assert.doesNotMatch(sidewayArgs, /TrendFixedTp/,
    "Sideway args must never receive Trend Fixed TP settings.");

  assert.match(supervisor, /if\s*\(\$TrendFixedTpEnabled\)\s*\{\s*\$trendArgs\s*\+=\s*"-FixedTpEnabled"\s*\}/s,
    "RED_TARGET: Trend enable flag must be passed only when configured true.");
  assert.match(supervisor, /if\s*\(\$SidewayFixedTpEnabled\)\s*\{\s*\$sidewayArgs\s*\+=\s*"-FixedTpEnabled"\s*\}/s,
    "RED_TARGET: Sideway enable flag must be passed only when configured true.");
});

test("Trend launcher exports only Trend Fixed TP environment", () => {
  assert.match(trendLauncher, /\[switch\]\$FixedTpEnabled/,
    "RED_TARGET: Trend launcher must accept FixedTpEnabled.");
  assert.match(trendLauncher, /\[double\]\$FixedTpDistance\s*=\s*0/,
    "RED_TARGET: Trend launcher must accept FixedTpDistance.");
  assert.match(trendLauncher, /ZIQ_PHASE7C_TREND_FIXED_TP_ENABLED/);
  assert.match(trendLauncher, /ZIQ_PHASE7C_TREND_FIXED_TP_DISTANCE/);
  assert.doesNotMatch(trendLauncher, /ZIQ_PHASE7C_SIDEWAY_FIXED_TP_/,
    "Trend launcher must not export Sideway Fixed TP environment.");
});

test("Sideway launcher exports only Sideway Fixed TP environment", () => {
  assert.match(sidewayLauncher, /\[switch\]\$FixedTpEnabled/,
    "RED_TARGET: Sideway launcher must accept FixedTpEnabled.");
  assert.match(sidewayLauncher, /\[double\]\$FixedTpDistance\s*=\s*0/,
    "RED_TARGET: Sideway launcher must accept FixedTpDistance.");
  assert.match(sidewayLauncher, /ZIQ_PHASE7C_SIDEWAY_FIXED_TP_ENABLED/);
  assert.match(sidewayLauncher, /ZIQ_PHASE7C_SIDEWAY_FIXED_TP_DISTANCE/);
  assert.doesNotMatch(sidewayLauncher, /ZIQ_PHASE7C_TREND_FIXED_TP_/,
    "Sideway launcher must not export Trend Fixed TP environment.");
});

test("runtime wiring preserves startup PAUSE/ARM semantics and introduces no Trend AutoRisk", () => {
  const pauseIndex = supervisor.indexOf("Set-Phase7CStartupPause");
  const launchIndex = supervisor.indexOf('$trend = Start-Process -FilePath "powershell.exe"');
  assert.ok(pauseIndex >= 0 && launchIndex > pauseIndex,
    "startup PAUSE must remain before executor launch");
  assert.match(supervisor, /if \(\$Armed\) \{ \$trendArgs \+= "-Armed"; \$sidewayArgs \+= "-Armed" \}/,
    "existing ARM propagation must remain intact");

  const trendSurface = `${supervisor}\n${trendLauncher}`;
  assert.doesNotMatch(
    trendSurface,
    /AutoRisk|TrendRiskPercent|ZIQ_PHASE7C_TREND_RISK_PERCENT/i,
    "Trend AutoRisk is explicitly out of scope for the Fixed TP branch.",
  );
});
