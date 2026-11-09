import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const required = [
  "apps/web/package.json",
  "apps/web/src/App.tsx",
  "apps/web/src/router.tsx",
  "apps/web/src/pages/OverviewPage.tsx",
  "apps/web/src/pages/SignalsPage.tsx",
  "apps/web/src/pages/RiskPage.tsx",
  "apps/web/src/pages/AiPage.tsx",
  "apps/web/src/pages/BacktestPage.tsx",
  "apps/web/src/pages/SystemPage.tsx",
  "apps/web/src/pages/SettingsPage.tsx",
  "apps/api/package.json",
  "apps/api/src/routes/dashboard.route.ts",
  "apps/api/src/routes/backtest.route.ts",
  "apps/api/src/routes/control.route.ts",
  "apps/api/src/services/dashboard.service.ts",
  "apps/api/src/services/backtest.service.ts",
  "packages/market-data/src/services/SessionService.ts",
  "packages/types/src/enums/TradingSession.ts",
  ".gitignore",
];

const missing = required.filter((file) => !existsSync(resolve(file)));
if (missing.length) {
  console.error("Missing integrated Pack 12 files:");
  for (const file of missing) console.error(`- ${file}`);
  process.exit(1);
}

const forbiddenPaths = [
  "app/page.tsx",
  "packages/signal-engine_backup/package.json",
  "packages/mt5-broker/.env",
  "packages/types/src/candle.ts",
  "packages/types/src/market.ts",
];
const presentForbidden = forbiddenPaths.filter((file) => existsSync(resolve(file)));
if (presentForbidden.length) {
  console.error("Forbidden legacy/secret paths remain:");
  for (const file of presentForbidden) console.error(`- ${file}`);
  process.exit(1);
}

const lock = readFileSync(resolve("pnpm-lock.yaml"), "utf8");
if (lock.includes("_backup")) {
  console.error("pnpm-lock.yaml still references backup workspaces.");
  process.exit(1);
}

const sessionService = readFileSync(
  resolve("packages/market-data/src/services/SessionService.ts"),
  "utf8",
);
if (!sessionService.includes('from "@xauusd/types"') || !sessionService.includes("TradingSession.OVERLAP")) {
  console.error("TradingSession canonicalization is incomplete.");
  process.exit(1);
}

const controlRoute = readFileSync(resolve("apps/api/src/routes/control.route.ts"), "utf8");
if (controlRoute.includes('mode !== "LIVE"') || controlRoute.includes('setControlMode("LIVE"')) {
  console.error("Dashboard control route must not expose LIVE mode.");
  process.exit(1);
}

console.log(`Integrated Pack 12 validation passed. Required files: ${required.length}.`);
console.log("Canonical TradingSession: PASS");
console.log("Backup workspace references: PASS");
console.log("Live trading remains locked: PASS");
