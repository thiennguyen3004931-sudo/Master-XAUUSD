const EPSILON = 1e-9;

function normalizeSide(side) {
  const normalized = String(side ?? "").trim().toUpperCase();
  return normalized === "BUY" || normalized === "SELL" ? normalized : null;
}

export function fastMoveProfitLockCandidate({
  side,
  entry,
  marketPrice,
  previousPeakPrice,
  activationDistance,
  givebackDistance,
}) {
  const normalizedSide = normalizeSide(side);
  const normalizedEntry = Number(entry);
  const normalizedMarketPrice = Number(marketPrice);
  const normalizedPreviousPeak = Number(previousPeakPrice);
  const activation = Number(activationDistance);
  const giveback = Number(givebackDistance);

  if (
    !normalizedSide ||
    !(normalizedEntry > 0) ||
    !(normalizedMarketPrice > 0) ||
    !(activation > 0) ||
    !(giveback >= 0) ||
    !(activation >= giveback)
  ) {
    return {
      active: false,
      reason: "INVALID_INPUT",
      peakPrice: 0,
      peakFavorable: 0,
      candidateStop: 0,
    };
  }

  const seedPeak = Number.isFinite(normalizedPreviousPeak) && normalizedPreviousPeak > 0
    ? normalizedPreviousPeak
    : normalizedEntry;
  const peakPrice = normalizedSide === "BUY"
    ? Math.max(normalizedEntry, seedPeak, normalizedMarketPrice)
    : Math.min(normalizedEntry, seedPeak, normalizedMarketPrice);
  const peakFavorable = normalizedSide === "BUY"
    ? peakPrice - normalizedEntry
    : normalizedEntry - peakPrice;

  if (peakFavorable + EPSILON < activation) {
    return {
      active: false,
      reason: "BELOW_ACTIVATION",
      peakPrice,
      peakFavorable,
      candidateStop: 0,
    };
  }

  const candidateStop = normalizedSide === "BUY"
    ? peakPrice - giveback
    : peakPrice + giveback;
  const locksPositiveProfit = normalizedSide === "BUY"
    ? candidateStop > normalizedEntry + EPSILON
    : candidateStop < normalizedEntry - EPSILON;

  if (!Number.isFinite(candidateStop) || !(candidateStop > 0) || !locksPositiveProfit) {
    return {
      active: false,
      reason: "CANDIDATE_NOT_PROFIT_LOCK",
      peakPrice,
      peakFavorable,
      candidateStop: 0,
    };
  }

  return {
    active: true,
    reason: "ACTIVE",
    peakPrice,
    peakFavorable,
    candidateStop,
  };
}
