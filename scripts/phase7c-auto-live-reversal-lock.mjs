/**
 * Production hard lock for NEW AUTO LIVE orders only.
 * Called by the Trend POST-order interception gate after re-reading bot mode
 * and live regime, immediately before passing the request to the MT5 bridge.
 * Position management (PATCH/CLOSE) does not traverse this order gate.
 */
export function evaluateLiveAutoReversalEntryLock({
  activeMode,
  regime,
  reversalOrigin,
}) {
  const mode = String(activeMode ?? "").trim().toUpperCase();
  const liveRegime = String(regime ?? "").trim().toUpperCase();
  if (mode === "AUTO" && (liveRegime === "REVERSAL" || reversalOrigin === true)) {
    return {
      allowed: false,
      reason: "LIVE_AUTO_REVERSAL_ENTRY_LOCKED",
      detail: liveRegime === "REVERSAL"
        ? "Production AUTO reversal regime: all NEW Trend-side entries are locked, even if order provenance is missing."
        : "Production AUTO REVERSAL-origin order is locked, even after a regime transition.",
    };
  }
  return { allowed: true, reason: "LIVE_AUTO_REVERSAL_LOCK_NOT_APPLICABLE" };
}
