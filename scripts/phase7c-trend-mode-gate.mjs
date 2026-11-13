function upper(value, fallback = "") {
  const normalized = String(value ?? "").trim().toUpperCase();
  return normalized || fallback;
}

function finite(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function evaluateAutoTrendEntryModeGate({ activeMode, regime, demo }) {
  const normalizedActiveMode = upper(activeMode, "PAUSE");
  const observedActiveMode = upper(regime?.activeMode, normalizedActiveMode);
  const recommendedMode = upper(regime?.recommendedMode, "PAUSE");
  const regimeName = upper(regime?.regime, "UNCERTAIN");
  const regimeConfidence = finite(regime?.confidence);
  const reversalEntryEligible = demo?.entryDiagnostics?.entry?.reversalEligible === true;
  const signalSide = upper(
    demo?.entryDiagnostics?.entry?.side ?? demo?.entryDiagnostics?.pattern?.side,
    "",
  );
  const signalTimestamp = finite(demo?.entryDiagnostics?.closeTime);
  const reversalSide = upper(regime?.reversal?.side, "");
  const reversalTimestamp = finite(regime?.reversal?.timestamp);
  const reversalDirection = upper(regime?.reversal?.direction, "");
  const regimeSnapshot = {
    regime: regimeName,
    regimeConfidence,
  };

  if (normalizedActiveMode !== "AUTO") {
    return {
      allowed: false,
      activeMode: normalizedActiveMode,
      recommendedMode,
      ...regimeSnapshot,
      reason: "AUTO_GATE_CALLED_WITH_NON_AUTO_MODE",
      detail: `Expected AUTO, received ${normalizedActiveMode}.`,
    };
  }

  if (observedActiveMode !== normalizedActiveMode) {
    return {
      allowed: false,
      activeMode: observedActiveMode,
      recommendedMode,
      ...regimeSnapshot,
      reason: "BOT_MODE_CHANGED_DURING_GATE",
      detail: `Mode changed from ${normalizedActiveMode} to ${observedActiveMode} while evaluating entry.`,
    };
  }

  if (regimeName === "REVERSAL") {
    const reversalSnapshot = {
      reversalDirection: reversalDirection || null,
      reversalSide: reversalSide || null,
      reversalTimestamp,
      signalSide: signalSide || null,
      signalTimestamp,
    };

    if (
      (reversalSide !== "BUY" && reversalSide !== "SELL") ||
      reversalTimestamp === null
    ) {
      return {
        allowed: false,
        activeMode: normalizedActiveMode,
        recommendedMode,
        ...regimeSnapshot,
        ...reversalSnapshot,
        reason: "REVERSAL_CONTEXT_MISSING",
        detail: "REVERSAL requires canonical latest confirmed CHOCH direction and timestamp.",
      };
    }

    if (signalSide && signalSide !== reversalSide) {
      return {
        allowed: false,
        activeMode: normalizedActiveMode,
        recommendedMode,
        ...regimeSnapshot,
        ...reversalSnapshot,
        reason: "REVERSAL_DIRECTION_MISMATCH",
        detail: `REVERSAL requires ${reversalSide}; current signal is ${signalSide}.`,
      };
    }

    if (signalTimestamp !== null && signalTimestamp <= reversalTimestamp) {
      return {
        allowed: false,
        activeMode: normalizedActiveMode,
        recommendedMode,
        ...regimeSnapshot,
        ...reversalSnapshot,
        reason: "REVERSAL_SIGNAL_NOT_AFTER_CHOCH",
        detail: `Signal timestamp ${signalTimestamp} must be newer than CHOCH ${reversalTimestamp}.`,
      };
    }

    if (
      signalSide !== reversalSide ||
      signalTimestamp === null ||
      !reversalEntryEligible
    ) {
      return {
        allowed: false,
        activeMode: normalizedActiveMode,
        recommendedMode,
        ...regimeSnapshot,
        ...reversalSnapshot,
        reason: "REVERSAL_ENTRY_CONDITIONS_NOT_READY",
        detail: "REVERSAL waits for CHOCH-direction M15 pattern + valid structure + SL <= 10; SuperTrend is not an entry gate.",
      };
    }

    return {
      allowed: true,
      activeMode: normalizedActiveMode,
      recommendedMode,
      ...regimeSnapshot,
      ...reversalSnapshot,
      reason: "AUTO_REVERSAL_CHOCH_DIRECTION_ENTRY",
      detail: "REVERSAL entry matches latest confirmed CHOCH direction, is newer than CHOCH, and passes pattern/structure/SL gates without SuperTrend.",
    };
  }

  if (recommendedMode === "TREND") {
    return {
      allowed: true,
      activeMode: normalizedActiveMode,
      recommendedMode,
      ...regimeSnapshot,
      reason: "AUTO_REGIME_ALLOWS_TREND",
      detail: `Regime=${regimeName}.`,
    };
  }

  return {
    allowed: false,
    activeMode: normalizedActiveMode,
    recommendedMode,
    ...regimeSnapshot,
    reason: `AUTO_REGIME_RECOMMENDS_${recommendedMode}`,
    detail: `Regime=${regimeName}; no canonical REVERSAL exception applies.`,
  };
}
