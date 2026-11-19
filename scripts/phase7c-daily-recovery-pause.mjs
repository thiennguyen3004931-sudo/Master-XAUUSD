/**
 * Phase 7C operator-requested pause of DAILY RECOVERY for NEW entries.
 *
 * This is deliberately a hard-coded source policy, not an environment flag,
 * to prevent stale .env/config or process restarts silently re-enabling it.
 * It NEVER changes persisted positions, MT5 orders, BOT_MODE, ARM or LIVE locks.
 *
 * Canonical daily net P/L is still read and validated. The canonical reported
 * daily mode remains intact as historical evidence, while the executable
 * per-entry mode is normalized to the original strategy.
 */
export const DAILY_RECOVERY_NEW_ENTRY_PAUSED = true;

const NATIVE_ENTRY_MODE = Object.freeze({
  TREND: "TREND",
  SIDEWAY: "SIDEWAY_NATIVE",
});

export function pauseDailyRecoveryForNewEntry(strategy, plan) {
  const normalizedStrategy = String(strategy ?? "").trim().toUpperCase();
  const nativeMode = NATIVE_ENTRY_MODE[normalizedStrategy];
  if (!nativeMode) throw new Error("DAILY_RECOVERY_PAUSE_STRATEGY_INVALID");
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new Error("DAILY_RECOVERY_PAUSE_PLAN_INVALID");
  }
  if (plan.mode !== nativeMode && plan.mode !== "RECOVERY_TP") {
    throw new Error("DAILY_RECOVERY_PAUSE_MODE_INVALID");
  }
  if (typeof plan.dailyNetPnl !== "number" || !Number.isFinite(plan.dailyNetPnl)) {
    throw new Error("DAILY_RECOVERY_PAUSE_PNL_INVALID");
  }
  if (plan.mode === "RECOVERY_TP" && plan.dailyNetPnl >= 0) {
    throw new Error("DAILY_RECOVERY_PAUSE_SIGN_MISMATCH");
  }
  if (plan.mode === nativeMode && plan.dailyNetPnl < 0) {
    throw new Error("DAILY_RECOVERY_PAUSE_NATIVE_SIGN_MISMATCH");
  }
  if (!DAILY_RECOVERY_NEW_ENTRY_PAUSED) return plan;

  // Retain original P/L + source + dayStartTime for analysis / final gate.
  // Remove recovery-only trade management fields from the new-entry snapshot.
  return Object.freeze({
    ...plan,
    mode: nativeMode,
    targetNetPnl: 0,
    requiredUsd: 0,
    rawTpDistance: 0,
    tpDistance: 0,
    canRecoverInOneTrade: false,
    recoveryEntryPaused: true,
    recoveryPauseReason: "DAILY_RECOVERY_TEMPORARILY_DISABLED",
  });
}

export function assertDailyRecoveryPausedBeforeSend(strategy, plan) {
  if (!DAILY_RECOVERY_NEW_ENTRY_PAUSED) return;
  const nativeMode = NATIVE_ENTRY_MODE[String(strategy ?? "").trim().toUpperCase()];
  if (!nativeMode || plan?.mode !== nativeMode || plan?.recoveryEntryPaused !== true ||
      plan?.tpDistance !== 0 || plan?.rawTpDistance !== 0 || plan?.requiredUsd !== 0) {
    throw new Error("DAILY_RECOVERY_PAUSE_FINAL_GATE_BLOCK");
  }
}
