import fs from "node:fs";
import { installPhase7CAccountOrderFetchGuard } from "./phase7c-account-runtime-guard.mjs";
import { transformPhase7CTrendLegacySource } from "./phase7c-live-source-adapters.mjs";
import { transformPhase7CTrendCanonicalDailyRecoverySource } from "./phase7c-canonical-daily-recovery-source-adapter.mjs";

const runtime = installPhase7CAccountOrderFetchGuard({ label: "TREND" });
const mode = runtime.accountMode;
const originalReadFileSync = fs.readFileSync.bind(fs);
let transformed = false;

fs.readFileSync = function phase7CTrendReadFileSync(file, options) {
  const raw = originalReadFileSync(file, options);
  const filename = typeof file === "string" ? file : file instanceof URL ? file.pathname : String(file);
  if (!filename.replaceAll("\\", "/").endsWith("/run-phase7b-demo-controller.ts")) return raw;

  const source = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  const accountAdapted = mode === "LIVE"
    ? transformPhase7CTrendLegacySource(source)
    : source;
  const output = transformPhase7CTrendCanonicalDailyRecoverySource(accountAdapted);
  transformed = true;
  console.log(`PHASE7C_TREND_CANONICAL_DAILY_RECOVERY_ADAPTER=APPLIED|MODE=${mode}`);
  if (mode === "LIVE") console.log("PHASE7C_TREND_LIVE_ADAPTER=APPLIED");
  return Buffer.isBuffer(raw) ? Buffer.from(output, "utf8") : output;
};

if (mode === "LIVE" && !process.env.ZIQ_BRIDGE_ENV?.trim()) {
  fs.readFileSync = originalReadFileSync;
  throw new Error("Phase7C LIVE Trend requires ZIQ_BRIDGE_ENV to point at the dedicated LIVE env file.");
}

console.log(`PHASE7C_TREND_ACCOUNT_MODE=${mode}`);
console.log("PHASE7C_TREND_ACCOUNT_ORDER_GATE=ENABLED");
try {
  await import("./run-phase7c-trend-controller.mjs");
  if (!transformed) {
    throw new Error("Phase7C Trend account-mode/Daily Recovery source adapter was not applied; refusing silent fallback.");
  }
} finally {
  fs.readFileSync = originalReadFileSync;
}
