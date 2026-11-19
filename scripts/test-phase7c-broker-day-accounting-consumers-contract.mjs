import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperPath = path.join(
  repoRoot,
  "packages/mt5-broker/src/accounting/broker-day-realized-pnl.ts",
);
const trendPath = path.join(repoRoot, "scripts/run-phase7b-demo-controller.ts");
const sidewayPath = path.join(repoRoot, "scripts/run-phase7c-sideway-controller.mjs");
const apiPath = path.join(
  repoRoot,
  "apps/api/src/services/phase7c-daily-recovery-view.service.ts",
);

const controllerConsumers = [
  ["Trend", trendPath],
  ["Sideway", sidewayPath],
];

for (const [name, sourcePath] of controllerConsumers) {
  test(`${name} uses canonical broker-day accounting summary`, () => {
    const source = fs.readFileSync(sourcePath, "utf8");

    assert.match(
      source,
      /summarizeBrokerDayRealizedPnl/,
      `${name} must use the canonical broker-day realized P&L summary`,
    );
    assert.match(
      source,
      /@xauusd\/mt5-broker/,
      `${name} must consume accounting from @xauusd/mt5-broker`,
    );

    assert.doesNotMatch(
      source,
      /const\s+botDeals\s*=\s*deals\.filter\s*\(/,
      `${name} must remove its legacy local owned-deal filter`,
    );
    assert.doesNotMatch(
      source,
      /const\s+dailyNetPnl\s*=\s*botDeals\.reduce\s*\(/,
      `${name} must remove its legacy local netPnl reduce`,
    );
  });
}

test("Daily Recovery consumes the durable canonical deal ledger instead of the legacy broker-day history path", () => {
  const source = fs.readFileSync(apiPath, "utf8");

  assert.match(source, /phase7c-canonical-deal-ledger\.service/);
  assert.match(source, /summarizePhase7CCanonicalDeals/);
  assert.doesNotMatch(source, /summarizeBrokerDayRealizedPnl/);
  assert.doesNotMatch(source, /\/v1\/history\/deals/);
});

test("canonical accounting helper owns both deal count and daily net P&L", () => {
  const source = fs.readFileSync(helperPath, "utf8");

  assert.match(source, /summarizeBrokerDayRealizedPnl/);
  assert.match(source, /dealCount/);
  assert.match(source, /dailyNetPnl/);
});

test("root runtime declares mt5-broker for controller package imports", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );

  assert.equal(
    packageJson?.dependencies?.["@xauusd/mt5-broker"],
    "workspace:*",
    "root runtime must declare @xauusd/mt5-broker before Trend/Sideway import it",
  );
});
