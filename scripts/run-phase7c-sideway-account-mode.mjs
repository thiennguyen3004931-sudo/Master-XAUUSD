import fs from "node:fs";
import { resolvePhase7CAccountRuntime } from "./phase7c-account-runtime-guard.mjs";
import { transformPhase7CSidewaySource } from "./phase7c-live-source-adapters.mjs";
import { transformPhase7CSidewayCanonicalDailyRecoverySource } from "./phase7c-canonical-daily-recovery-source-adapter.mjs";
import { transformPhase7CSidewayM5TrailingSource } from "./phase7c-m5-structural-trailing-source-adapter.mjs";
import { transformPhase7CSidewayM5PreStructureProfitLockSource } from "./phase7c-m5-prestructure-profit-lock-source-adapter.mjs";

const runtime = resolvePhase7CAccountRuntime();
const mode = runtime.accountMode;
const sourceUrl = new URL("./run-phase7c-sideway-controller.mjs", import.meta.url);
const source = fs.readFileSync(sourceUrl, "utf8");
const accountAdapted = mode === "LIVE"
  ? transformPhase7CSidewaySource(source)
  : source;
const canonicalOutput = transformPhase7CSidewayCanonicalDailyRecoverySource(accountAdapted);
const m5Output = transformPhase7CSidewayM5TrailingSource(canonicalOutput);
const output = transformPhase7CSidewayM5PreStructureProfitLockSource(m5Output);
const runtimeUrl = new URL(`./.phase7c-sideway-runtime-${process.pid}.mjs`, import.meta.url);
fs.writeFileSync(runtimeUrl, `${output}\n//# sourceURL=${sourceUrl.href}\n`, "utf8");

console.log(`PHASE7C_SIDEWAY_ACCOUNT_MODE=${mode}`);
console.log("PHASE7C_SIDEWAY_ACCOUNT_ORDER_GATE=INSTALLED_BY_LOCK_WRAPPER");
console.log(`PHASE7C_SIDEWAY_CANONICAL_DAILY_RECOVERY_ADAPTER=APPLIED|MODE=${mode}`);
console.log(`PHASE7C_SIDEWAY_M5_STRUCTURAL_TRAILING_ADAPTER=APPLIED|MODE=${mode}`);
console.log(`PHASE7C_SIDEWAY_M5_PRE_STRUCTURE_PROFIT_LOCK_ADAPTER=APPLIED|MODE=${mode}`);
if (mode === "LIVE") console.log("PHASE7C_SIDEWAY_LIVE_ADAPTER=APPLIED");
try {
  await import(`${runtimeUrl.href}?pid=${process.pid}`);
} finally {
  try { fs.unlinkSync(runtimeUrl); } catch { /* best effort */ }
}
