param()

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$servicePath = Join-Path $repoRoot "apps/api/src/services/phase7e-realignment.service.ts"

if (-not (Test-Path $servicePath)) { throw "Phase 7E service not found: $servicePath" }

$raw = [System.IO.File]::ReadAllText($servicePath)
$newline = if ($raw.Contains("`r`n")) { "`r`n" } else { "`n" }
$content = $raw.Replace("`r`n", "`n")

if ($content.Contains("const phase7g2EmaHoldAblation = {")) {
  Write-Host "PHASE7G2_APPLY=ALREADY_APPLIED"
  Write-Host "PHASE7G2_SERVICE=$servicePath"
  exit 0
}

if (-not $content.Contains("const phase7f2ManagementAblation = {")) {
  throw "Phase 7F.2 management ablation missing. Apply Phase 7F.2 first."
}
if (-not $content.Contains("const phase7fPathDiagnostics = {")) {
  throw "Phase 7F.1 path diagnostics missing. Apply Phase 7F.1 first."
}
if ($content.Contains("const phase7g1MaRegimeAblation = {")) {
  throw "Phase 7G.1 MA entry-filter patch is applied locally. EMA-only trend-hold research requires MA entry filtering to remain unapplied. Restore the pre-7G.1 service before continuing."
}

$oldExitType = 'type ExitReason = "STOP" | "TREND_MA20" | "REVERSAL_FVG_REJECTION" | "M15_SUPERTREND_FLIP" | "END_OF_DATA";'
$newExitType = 'type ExitReason = "STOP" | "TREND_MA20" | "REVERSAL_FVG_REJECTION" | "M15_SUPERTREND_FLIP" | "EMA20_HOLD_EXIT" | "EMA50_HOLD_EXIT" | "EMA20_50_REGIME_EXIT" | "END_OF_DATA";'
if (-not $content.Contains($oldExitType)) { throw "Phase 7G.2 ExitReason marker not found." }
$content = $content.Replace($oldExitType, $newExitType)

$ma20Marker = '  const ma20 = rollingSma(sortedM15.map((b) => b.close), 20);'
if (-not $content.Contains($ma20Marker)) { throw "MA20 computation marker not found." }
if (-not $content.Contains('const ema20 = rollingEma')) {
  $content = $content.Replace(
    $ma20Marker,
    $ma20Marker + "`n  const ema20 = rollingEma(sortedM15.map((b) => b.close), 20);`n  const ema50 = rollingEma(sortedM15.map((b) => b.close), 50);"
  )
}

$functionMarker = "function phase7fPercentile(values: number[], percentile: number) {"
if (-not $content.Contains($functionMarker)) { throw "Phase 7F.1 function marker not found." }

$functions = @'
type Phase7G2EmaHoldName =
  | "E0_CANONICAL"
  | "E1_EMA20_HOLD"
  | "E2_EMA50_HOLD"
  | "E3_EMA20_50_REGIME_HOLD";

type Phase7G2EmaHoldConfig = {
  name: Phase7G2EmaHoldName;
  mode: "CANONICAL" | "EMA20" | "EMA50" | "EMA20_50_REGIME";
};

function rollingEma(values: number[], period: number): Array<number | null> {
  const output: Array<number | null> = Array(values.length).fill(null);
  if (values.length < period) return output;
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i]!;
  let previous = seed / period;
  output[period - 1] = previous;
  const alpha = 2 / (period + 1);
  for (let i = period; i < values.length; i += 1) {
    previous = values[i]! * alpha + previous * (1 - alpha);
    output[i] = previous;
  }
  return output;
}

function phase7g2EmaExit(
  side: Side,
  mode: Phase7G2EmaHoldConfig["mode"],
  index: number,
  m15: Bar[],
  ema20: Array<number | null>,
  ema50: Array<number | null>,
): ExitReason | null {
  if (mode === "CANONICAL") return null;
  const bar = m15[index];
  if (!bar) return null;
  const e20 = ema20[index];
  const e50 = ema50[index];

  if (mode === "EMA20") {
    if (e20 === null) return null;
    const broken = side === "BUY" ? bar.close < e20 : bar.close > e20;
    return broken ? "EMA20_HOLD_EXIT" : null;
  }
  if (mode === "EMA50") {
    if (e50 === null) return null;
    const broken = side === "BUY" ? bar.close < e50 : bar.close > e50;
    return broken ? "EMA50_HOLD_EXIT" : null;
  }
  if (e20 === null || e50 === null) return null;
  const regimeBroken = side === "BUY" ? e20 <= e50 : e20 >= e50;
  return regimeBroken ? "EMA20_50_REGIME_EXIT" : null;
}

function simulatePhase7G2EmaHoldTrade(
  signal: Signal,
  m15: Bar[],
  m5: Bar[],
  m5OpenTimes: number[],
  m15CloseTimes: number[],
  ma20: Array<number | null>,
  ema20: Array<number | null>,
  ema50: Array<number | null>,
  spec: Spec,
  volume: number,
  config: Phase7G2EmaHoldConfig,
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
  let lastEmaM15CloseChecked = signal.signalTimestamp;
  const trendExit = findTrendExit(signal, m15, m15CloseTimes, ma20);

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
      activeStop = improveStop(signal.side, activeStop, entry);
      breakEvenApplied = true;
    }

    if (!partialApplied && favorable >= PARTIAL_TRIGGER) {
      const closeVolume = executablePartialVolume(volume, 1 / 3, spec);
      if (closeVolume > 0 && remainingVolume - closeVolume >= spec.minVolume - 1e-9) {
        const triggerPrice = signal.side === "BUY" ? entry + PARTIAL_TRIGGER : entry - PARTIAL_TRIGGER;
        partialApplied = true;
        partialVolume = closeVolume;
        partialPnl = pnlUsd(signal.side, entry, triggerPrice, closeVolume, spec);
        remainingVolume = normalizeVolume(remainingVolume - closeVolume, spec.volumeStep);
      }
    }

    if (partialApplied) {
      const currentM15Index = upperBound(m15CloseTimes, bar.closeTime) - 1;
      if (currentM15Index >= 0) {
        const currentM15 = m15[currentM15Index]!;
        if (currentM15.closeTime > lastEmaM15CloseChecked && currentM15.closeTime > signal.signalTimestamp) {
          lastEmaM15CloseChecked = currentM15.closeTime;
          const reason = phase7g2EmaExit(signal.side, config.mode, currentM15Index, m15, ema20, ema50);
          if (reason !== null) {
            const exit = closePriceForSide(signal.side, currentM15.close, currentM15.spread);
            return closeTrade(
              signal, first.openTime, entry, stopLoss, initialRiskUsd, volume,
              currentM15.closeTime, exit, remainingVolume, breakEvenApplied, partialApplied,
              partialVolume, partialPnl, structuralTrailUpdates, reason, spec,
            );
          }
        }
      }
    }

    if (!partialApplied && trendExit !== null && bar.closeTime >= trendExit.timestamp) {
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

'@
$functions = $functions.Replace("`r`n", "`n")
$content = $content.Replace($functionMarker, $functions + $functionMarker)

$stateMarker = "  const state = variants[0]!;"
if (-not $content.Contains($stateMarker)) { throw "Phase 7G.2 state marker not found." }

$block = @'
  const phase7g2Definitions: Phase7G2EmaHoldConfig[] = [
    { name: "E0_CANONICAL", mode: "CANONICAL" },
    { name: "E1_EMA20_HOLD", mode: "EMA20" },
    { name: "E2_EMA50_HOLD", mode: "EMA50" },
    { name: "E3_EMA20_50_REGIME_HOLD", mode: "EMA20_50_REGIME" },
  ];

  const phase7g2BuildSide = (side: Side) => {
    const accepted = flip2Accepted.filter(
      (signal) => signal.side === side && signal.pattern === "ENGULFING",
    );

    const sideVariants = phase7g2Definitions.map((definition) => {
      let scheduled: ReturnType<typeof schedule>;
      if (definition.mode === "CANONICAL") {
        const replay = replaySignals(accepted);
        scheduled = {
          trades: replay.trades,
          skippedWhileOpen: replay.skippedWhileOpen,
        };
      } else {
        const raw = accepted
          .map((signal) => simulatePhase7G2EmaHoldTrade(
            signal, sortedM15, sortedM5, m5OpenTimes, m15CloseTimes,
            ma20, ema20, ema50, spec, fixedVolume, definition,
          ))
          .filter((trade): trade is Trade => trade !== null)
          .sort((a, b) => a.signalTimestamp - b.signalTimestamp);
        scheduled = schedule(raw);
      }

      const baseMetrics = summarizePhase7F2(scheduled.trades, scheduled.skippedWhileOpen);
      const path = buildPhase7FPathDiagnostics(scheduled.trades, sortedM5, m5OpenTimes, spec);
      const emaExitTrades = scheduled.trades.filter((trade) =>
        trade.exitReason === "EMA20_HOLD_EXIT" ||
        trade.exitReason === "EMA50_HOLD_EXIT" ||
        trade.exitReason === "EMA20_50_REGIME_EXIT"
      ).length;

      return {
        ...definition,
        acceptedSignals: accepted.length,
        metrics: {
          ...baseMetrics,
          hitPlus6: path.metrics.hitPlus6,
          hitPlus10: path.metrics.hitPlus10,
          averageWinnerCaptureRatioPercent: path.metrics.averageWinnerCaptureRatioPercent,
          averageGivebackFromMfePrice: path.metrics.averageGivebackFromMfePrice,
          medianGivebackFromMfePrice: path.metrics.medianGivebackFromMfePrice,
          emaExitTrades,
        },
        trades: scheduled.trades.slice(-500).reverse(),
      };
    });

    const effectivePf = (variant: typeof sideVariants[number]) =>
      variant.metrics.profitFactor === null
        ? (variant.metrics.netPnl > 0 ? 999 : 0)
        : variant.metrics.profitFactor;

    const positive = sideVariants.filter((variant) =>
      variant.metrics.netPnl > 0 && effectivePf(variant) > 1 && variant.metrics.expectancy > 0,
    );
    const rankedPool = positive.length ? positive : sideVariants;
    const preferred = [...rankedPool].sort((a, b) =>
      Number(b.metrics.exactNetExLargestWinner > 0) - Number(a.metrics.exactNetExLargestWinner > 0) ||
      b.metrics.exactNetExLargestWinner - a.metrics.exactNetExLargestWinner ||
      b.metrics.netPnl - a.metrics.netPnl ||
      b.metrics.averageWinnerCaptureRatioPercent - a.metrics.averageWinnerCaptureRatioPercent ||
      a.metrics.maxDrawdownUsd - b.metrics.maxDrawdownUsd,
    )[0]!;

    return {
      side,
      acceptedSignals: accepted.length,
      variants: sideVariants,
      decision: {
        preferredResearchHold: preferred.name,
        baselineHold: "E0_CANONICAL",
        preferredExactNetExLargestPositive: preferred.metrics.exactNetExLargestWinner > 0,
        rankingRule: "SIDE_SEPARATE_POSITIVE_ECONOMICS_THEN_EXACT_NET_EX_LARGEST_THEN_NET_THEN_WINNER_CAPTURE_THEN_DD",
        executionEligible: false,
      },
    };
  };

  const phase7g2EmaHoldAblation = {
    source: "PHASE7G2_BIDIRECTIONAL_EMA_TREND_HOLD_ABLATION",
    sourceVariant: "M5_FLIP_2",
    pattern: "ENGULFING",
    entryModel: "M15_SUPERTREND_PLUS_FRESH_M5_FLIP_PLUS_ENGULFING_UNCHANGED",
    emaRole: "POST_PLUS10_REMAINDER_TREND_HOLD_ONLY",
    emaTimeframe: "M15",
    prePlus10Management: "CANONICAL_INITIAL_STOP_PLUS6_BE_AND_CANONICAL_MA20_FALLBACK_UNTIL_PARTIAL",
    partialRule: "PLUS10_CLOSE_ONE_THIRD_THEN_EMA_MANAGES_REMAINING_TWO_THIRDS",
    contentionMode: "REPLAY_AND_RESCHEDULE_INDEPENDENTLY_PER_SIDE_AND_EMA_HOLD_VARIANT",
    filters: {
      maEntryFilter: false,
      emaEntryFilter: false,
    },
    safety: {
      researchOnly: true,
      productionEntryMutation: false,
      productionManagementMutation: false,
      executionMutation: false,
      phase7bStrategyMutation: false,
      executionEligible: false,
    },
    buy: phase7g2BuildSide("BUY"),
    sell: phase7g2BuildSide("SELL"),
  };

'@
$block = $block.Replace("`r`n", "`n")
$content = $content.Replace($stateMarker, $block + $stateMarker)

$returnMarker = "    phase7f2ManagementAblation,`n    decision: {"
if (-not $content.Contains($returnMarker)) {
  throw "Phase 7G.2 return marker not found. Phase 7F.2 may not be applied locally, or Phase 7G.1 may already have modified the return block."
}
$content = $content.Replace(
  $returnMarker,
  "    phase7f2ManagementAblation,`n    phase7g2EmaHoldAblation,`n    decision: {"
)

if ($newline -eq "`r`n") { $content = $content.Replace("`n", "`r`n") }
[System.IO.File]::WriteAllText($servicePath, $content, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "PHASE7G2_APPLY=PASS"
Write-Host "PHASE7G2_SERVICE=$servicePath"
Write-Host "PHASE7G2_SIDES=BUY,SELL"
Write-Host "PHASE7G2_PATTERN=ENGULFING"
Write-Host "PHASE7G2_SOURCE_VARIANT=M5_FLIP_2"
Write-Host "PHASE7G2_ENTRY=M15_SUPERTREND_PLUS_M5_FLIP2_PLUS_ENGULFING_UNCHANGED"
Write-Host "PHASE7G2_EMA_ROLE=POST_PLUS10_REMAINDER_TREND_HOLD_ONLY"
Write-Host "PHASE7G2_VARIANTS=E0_CANONICAL,E1_EMA20_HOLD,E2_EMA50_HOLD,E3_EMA20_50_REGIME_HOLD"
Write-Host "PHASE7G2_MA_ENTRY_FILTER=False"
Write-Host "PHASE7G2_EMA_ENTRY_FILTER=False"
Write-Host "PHASE7G2_PRODUCTION_ENTRY_MUTATION=False"
Write-Host "PHASE7G2_PRODUCTION_MANAGEMENT_MUTATION=False"
Write-Host "PHASE7G2_EXECUTION_ELIGIBLE=False"
Write-Host "PHASE7G2_NEXT=pnpm --filter @xauusd/api build"
