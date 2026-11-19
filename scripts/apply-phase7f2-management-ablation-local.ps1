param()

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$servicePath = Join-Path $repoRoot "apps/api/src/services/phase7e-realignment.service.ts"

if (-not (Test-Path $servicePath)) { throw "Phase 7E service not found: $servicePath" }

$raw = [System.IO.File]::ReadAllText($servicePath)
$newline = if ($raw.Contains("`r`n")) { "`r`n" } else { "`n" }
$content = $raw.Replace("`r`n", "`n")

if ($content.Contains("const phase7f2ManagementAblation = {")) {
  Write-Host "PHASE7F2_APPLY=ALREADY_APPLIED"
  Write-Host "PHASE7F2_SERVICE=$servicePath"
  exit 0
}

if (-not $content.Contains("const phase7fPathDiagnostics = {")) { throw "Phase 7F.1 path diagnostics missing. Apply Phase 7F.1 first." }
if (-not $content.Contains("const flip2Ablation = {")) { throw "Phase 7E.2 ablation missing." }

$oldExitType = 'type ExitReason = "STOP" | "TREND_MA20" | "REVERSAL_FVG_REJECTION" | "END_OF_DATA";'
$newExitType = 'type ExitReason = "STOP" | "TREND_MA20" | "REVERSAL_FVG_REJECTION" | "M15_SUPERTREND_FLIP" | "END_OF_DATA";'
if (-not $content.Contains($oldExitType)) { throw "ExitReason marker not found." }
$content = $content.Replace($oldExitType, $newExitType)

$functionMarker = "function phase7fPercentile(values: number[], percentile: number) {"
if (-not $content.Contains($functionMarker)) { throw "Phase 7F.1 function marker not found." }

$functions = @'
type Phase7F2ManagementName =
  | "M0_CANONICAL"
  | "M1_BE2_CANONICAL"
  | "M2_BE2_PARTIAL_FIXED5"
  | "M3_BE2_PARTIAL_ST_EXIT"
  | "M4_BE2_NO_PARTIAL_ST_EXIT";

type Phase7F2ManagementConfig = {
  name: Phase7F2ManagementName;
  beOffset: number;
  partialAt10: boolean;
  post10Mode: "CANONICAL" | "FIXED5" | "NONE";
  supertrendExitMode: "NEVER" | "AFTER_PARTIAL" | "ALWAYS";
  useMa20Fallback: boolean;
};

function phase7f2SupertrendExitAfter(
  signal: Signal,
  afterTimestamp: number,
  m15: Bar[],
  m15CloseTimes: number[],
  st15: Array<Direction | null>,
) {
  const start = upperBound(m15CloseTimes, afterTimestamp);
  const wanted = sideDirection(signal.side);
  for (let index = start; index < m15.length; index += 1) {
    if (st15[index] === -wanted) {
      const bar = m15[index]!;
      return {
        timestamp: bar.closeTime,
        price: closePriceForSide(signal.side, bar.close, bar.spread),
      };
    }
  }
  return null;
}

function simulatePhase7F2Trade(
  signal: Signal,
  m15: Bar[],
  m5: Bar[],
  m5OpenTimes: number[],
  m15CloseTimes: number[],
  ma20: Array<number | null>,
  st15: Array<Direction | null>,
  spec: Spec,
  volume: number,
  swingLows: Array<{ confirmedAt: number; level: number }>,
  swingHighs: Array<{ confirmedAt: number; level: number }>,
  config: Phase7F2ManagementConfig,
): Trade | null {
  const startIndex = lowerBound(m5OpenTimes, signal.signalTimestamp);
  const first = m5[startIndex];
  if (!first || first.openTime > signal.signalTimestamp + ENTRY_EXPIRY_MS) return null;

  const entry = signal.side === "BUY" ? first.open + first.spread : first.open;
  const stopLoss = signal.side === "BUY" ? entry - signal.stopDistance : entry + signal.stopDistance;
  const initialRiskUsd = signal.stopDistance * cashPerPrice(spec) * volume;
  let activeStop = stopLoss;
  let remainingVolume = volume;
  let breakEvenApplied = false;
  let partialApplied = false;
  let partialVolume = 0;
  let partialPnl = 0;
  let structuralTrailUpdates = 0;
  let lastReversalM15CloseChecked = signal.signalTimestamp;
  const trendExit = config.useMa20Fallback ? findTrendExit(signal, m15, m15CloseTimes, ma20) : null;
  let supertrendExit = config.supertrendExitMode === "ALWAYS"
    ? phase7f2SupertrendExitAfter(signal, signal.signalTimestamp, m15, m15CloseTimes, st15)
    : null;

  for (let index = startIndex; index < m5.length; index += 1) {
    const bar = m5[index]!;

    if (stopTouched(signal.side, bar, activeStop)) {
      return closeTrade(
        signal, first.openTime, entry, stopLoss, initialRiskUsd, volume,
        bar.closeTime, activeStop, remainingVolume, breakEvenApplied, partialApplied,
        partialVolume, partialPnl, structuralTrailUpdates, "STOP", spec,
      );
    }

    const favorable = favorableMove(signal.side, entry, bar);
    if (!breakEvenApplied && favorable >= BREAK_EVEN_TRIGGER) {
      const beCandidate = signal.side === "BUY" ? entry + config.beOffset : entry - config.beOffset;
      activeStop = improveStop(signal.side, activeStop, beCandidate);
      breakEvenApplied = true;
    }

    if (config.partialAt10 && !partialApplied && favorable >= PARTIAL_TRIGGER) {
      const closeVolume = executablePartialVolume(volume, 1 / 3, spec);
      if (closeVolume > 0 && remainingVolume - closeVolume >= spec.minVolume - 1e-9) {
        const triggerPrice = signal.side === "BUY" ? entry + PARTIAL_TRIGGER : entry - PARTIAL_TRIGGER;
        partialApplied = true;
        partialVolume = closeVolume;
        partialPnl = pnlUsd(signal.side, entry, triggerPrice, closeVolume, spec);
        remainingVolume = normalizeVolume(remainingVolume - closeVolume, spec.volumeStep);
        if (config.supertrendExitMode === "AFTER_PARTIAL") {
          supertrendExit = phase7f2SupertrendExitAfter(signal, bar.closeTime, m15, m15CloseTimes, st15);
        }
      }
    }

    if (partialApplied && config.post10Mode === "CANONICAL") {
      const structure = latestConfirmedStructure(signal.side, signal.signalTimestamp, bar.closeTime, swingLows, swingHighs);
      if (structure !== null) {
        const improved = improveStop(signal.side, activeStop, structure);
        if (Math.abs(improved - activeStop) > 1e-9) structuralTrailUpdates += 1;
        activeStop = improved;
      }
      const currentM15Index = upperBound(m15CloseTimes, bar.closeTime) - 1;
      if (currentM15Index >= 2) {
        const currentM15 = m15[currentM15Index]!;
        if (currentM15.closeTime > lastReversalM15CloseChecked && currentM15.closeTime > signal.signalTimestamp) {
          lastReversalM15CloseChecked = currentM15.closeTime;
          if (opposingFvgRejectionAt(signal.side, m15, currentM15Index, REVERSAL_FVG_LOOKBACK)) {
            const exit = closePriceForSide(signal.side, currentM15.close, currentM15.spread);
            return closeTrade(
              signal, first.openTime, entry, stopLoss, initialRiskUsd, volume,
              currentM15.closeTime, exit, remainingVolume, breakEvenApplied, partialApplied,
              partialVolume, partialPnl, structuralTrailUpdates, "REVERSAL_FVG_REJECTION", spec,
            );
          }
        }
      }
    }

    if (partialApplied && config.post10Mode === "FIXED5") {
      const closePrice = closePriceForSide(signal.side, bar.close, bar.spread);
      const trailCandidate = signal.side === "BUY" ? closePrice - 5 : closePrice + 5;
      const improved = improveStop(signal.side, activeStop, trailCandidate);
      if (Math.abs(improved - activeStop) > 1e-9) structuralTrailUpdates += 1;
      activeStop = improved;
    }

    if (supertrendExit !== null && bar.closeTime >= supertrendExit.timestamp) {
      return closeTrade(
        signal, first.openTime, entry, stopLoss, initialRiskUsd, volume,
        supertrendExit.timestamp, supertrendExit.price, remainingVolume, breakEvenApplied, partialApplied,
        partialVolume, partialPnl, structuralTrailUpdates, "M15_SUPERTREND_FLIP", spec,
      );
    }

    if (trendExit !== null && bar.closeTime >= trendExit.timestamp) {
      return closeTrade(
        signal, first.openTime, entry, stopLoss, initialRiskUsd, volume,
        trendExit.timestamp, trendExit.price, remainingVolume, breakEvenApplied, partialApplied,
        partialVolume, partialPnl, structuralTrailUpdates, "TREND_MA20", spec,
      );
    }
  }

  const last = m5.at(-1)!;
  const exit = closePriceForSide(signal.side, last.close, last.spread);
  return closeTrade(
    signal, first.openTime, entry, stopLoss, initialRiskUsd, volume,
    last.closeTime, exit, remainingVolume, breakEvenApplied, partialApplied,
    partialVolume, partialPnl, structuralTrailUpdates, "END_OF_DATA", spec,
  );
}

function summarizePhase7F2(trades: Trade[], skippedWhileOpen: number) {
  const base = summarize(trades, skippedWhileOpen);
  const grossProfit = trades.reduce((sum, trade) => sum + Math.max(0, trade.pnl), 0);
  const grossLoss = Math.abs(trades.reduce((sum, trade) => sum + Math.min(0, trade.pnl), 0));
  const winners = trades.map((trade) => Math.max(0, trade.pnl)).sort((a, b) => b - a);
  const largestWinnerPnl = winners[0] ?? 0;
  const top3WinnerPnl = winners.slice(0, 3).reduce((sum, value) => sum + value, 0);
  return {
    ...base,
    grossProfit: round(grossProfit, 2),
    grossLoss: round(grossLoss, 2),
    largestWinnerPnl: round(largestWinnerPnl, 2),
    largestWinnerShareOfGrossProfitPercent: round(grossProfit > 0 ? largestWinnerPnl / grossProfit * 100 : 0, 2),
    exactNetExLargestWinner: round(base.netPnl - largestWinnerPnl, 2),
    top3WinnerPnl: round(top3WinnerPnl, 2),
    top3WinnerShareOfGrossProfitPercent: round(grossProfit > 0 ? top3WinnerPnl / grossProfit * 100 : 0, 2),
    exactNetExTop3Winners: round(base.netPnl - top3WinnerPnl, 2),
    breakEvenAppliedTrades: trades.filter((trade) => trade.breakEvenApplied).length,
    partialAppliedTrades: trades.filter((trade) => trade.partialApplied).length,
    supertrendFlipExits: trades.filter((trade) => trade.exitReason === "M15_SUPERTREND_FLIP").length,
  };
}

'@
$functions = $functions.Replace("`r`n", "`n")
$content = $content.Replace($functionMarker, $functions + $functionMarker)

$stateMarker = "  const state = variants[0]!;"
if (-not $content.Contains($stateMarker)) { throw "State marker not found." }

$block = @'
  const phase7f2Accepted = flip2Accepted.filter(
    (signal) => signal.side === "BUY" && signal.pattern === "ENGULFING",
  );
  const phase7f2Definitions: Phase7F2ManagementConfig[] = [
    { name: "M0_CANONICAL", beOffset: 0, partialAt10: true, post10Mode: "CANONICAL", supertrendExitMode: "NEVER", useMa20Fallback: true },
    { name: "M1_BE2_CANONICAL", beOffset: 2, partialAt10: true, post10Mode: "CANONICAL", supertrendExitMode: "NEVER", useMa20Fallback: true },
    { name: "M2_BE2_PARTIAL_FIXED5", beOffset: 2, partialAt10: true, post10Mode: "FIXED5", supertrendExitMode: "NEVER", useMa20Fallback: true },
    { name: "M3_BE2_PARTIAL_ST_EXIT", beOffset: 2, partialAt10: true, post10Mode: "NONE", supertrendExitMode: "ALWAYS", useMa20Fallback: false },
    { name: "M4_BE2_NO_PARTIAL_ST_EXIT", beOffset: 2, partialAt10: false, post10Mode: "NONE", supertrendExitMode: "ALWAYS", useMa20Fallback: false },
  ];

  const phase7f2Variants = phase7f2Definitions.map((definition) => {
    if (definition.name === "M0_CANONICAL") {
      const replay = replaySignals(phase7f2Accepted);
      return {
        ...definition,
        acceptedSignals: phase7f2Accepted.length,
        metrics: summarizePhase7F2(replay.trades, replay.skippedWhileOpen),
        trades: replay.trades.slice(-500).reverse(),
      };
    }

    const raw = phase7f2Accepted
      .map((signal) => simulatePhase7F2Trade(
        signal, sortedM15, sortedM5, m5OpenTimes, m15CloseTimes, ma20, st15,
        spec, fixedVolume, swingLows, swingHighs, definition,
      ))
      .filter((trade): trade is Trade => trade !== null)
      .sort((a, b) => a.signalTimestamp - b.signalTimestamp);
    const scheduled = schedule(raw);
    return {
      ...definition,
      acceptedSignals: phase7f2Accepted.length,
      metrics: summarizePhase7F2(scheduled.trades, scheduled.skippedWhileOpen),
      trades: scheduled.trades.slice(-500).reverse(),
    };
  });

  const phase7f2EconomicallyPositive = phase7f2Variants.filter((variant) => {
    const pf = variant.metrics.profitFactor === null ? (variant.metrics.netPnl > 0 ? 999 : 0) : variant.metrics.profitFactor;
    return variant.metrics.netPnl > 0 && pf > 1 && variant.metrics.expectancy > 0;
  });
  const phase7f2Preferred = [...phase7f2EconomicallyPositive].sort((a, b) =>
    b.metrics.exactNetExLargestWinner - a.metrics.exactNetExLargestWinner ||
    b.metrics.netPnl - a.metrics.netPnl ||
    a.metrics.maxDrawdownUsd - b.metrics.maxDrawdownUsd,
  )[0] ?? phase7f2Variants[0]!;
  const phase7f2Baseline = phase7f2Variants[0]!;

  const phase7f2ManagementAblation = {
    source: "PHASE7F2_BUY_ENGULFING_MANAGEMENT_ABLATION",
    sourceVariant: "M5_FLIP_2",
    cell: "BUY_ENGULFING",
    contentionMode: "REPLAY_AND_RESCHEDULE_INDEPENDENTLY_PER_MANAGEMENT_VARIANT",
    safety: {
      researchOnly: true,
      entryMutation: false,
      productionManagementMutation: false,
      executionMutation: false,
      phase7bStrategyMutation: false,
      executionEligible: false,
    },
    variants: phase7f2Variants,
    decision: {
      preferredResearchManagement: phase7f2Preferred.name,
      baselineManagement: phase7f2Baseline.name,
      preferredNetExLargestPositive: phase7f2Preferred.metrics.exactNetExLargestWinner > 0,
      executionEligible: false,
      rankingRule: "POSITIVE_ECONOMICS_THEN_EXACT_NET_EX_LARGEST_THEN_NET_THEN_LOWER_DRAWDOWN",
    },
  };

'@
$block = $block.Replace("`r`n", "`n")
$content = $content.Replace($stateMarker, $block + $stateMarker)

$returnMarker = "    flip2Ablation,`n    phase7fPathDiagnostics,`n    decision: {"
if (-not $content.Contains($returnMarker)) { throw "Return marker not found. Phase 7F.1 may not be applied locally." }
$content = $content.Replace(
  $returnMarker,
  "    flip2Ablation,`n    phase7fPathDiagnostics,`n    phase7f2ManagementAblation,`n    decision: {"
)

if ($newline -eq "`r`n") { $content = $content.Replace("`n", "`r`n") }
[System.IO.File]::WriteAllText($servicePath, $content, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "PHASE7F2_APPLY=PASS"
Write-Host "PHASE7F2_SERVICE=$servicePath"
Write-Host "PHASE7F2_CELL=BUY_ENGULFING"
Write-Host "PHASE7F2_SOURCE_VARIANT=M5_FLIP_2"
Write-Host "PHASE7F2_VARIANTS=M0_CANONICAL,M1_BE2_CANONICAL,M2_BE2_PARTIAL_FIXED5,M3_BE2_PARTIAL_ST_EXIT,M4_BE2_NO_PARTIAL_ST_EXIT"
Write-Host "PHASE7F2_CONTENTION=INDEPENDENT_REPLAY_AND_RESCHEDULE"
Write-Host "PHASE7F2_ENTRY_MUTATION=False"
Write-Host "PHASE7F2_PRODUCTION_MANAGEMENT_MUTATION=False"
Write-Host "PHASE7F2_EXECUTION_ELIGIBLE=False"
Write-Host "PHASE7F2_NEXT=pnpm --filter @xauusd/api build"
