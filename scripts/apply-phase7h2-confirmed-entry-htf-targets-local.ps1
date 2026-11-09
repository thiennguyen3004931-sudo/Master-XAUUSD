param()

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$servicePath = Join-Path $repoRoot "apps/api/src/services/phase7e-realignment.service.ts"

if (-not (Test-Path $servicePath)) { throw "Phase 7E service not found: $servicePath" }

$raw = [System.IO.File]::ReadAllText($servicePath)
$newline = if ($raw.Contains("`r`n")) { "`r`n" } else { "`n" }
$content = $raw.Replace("`r`n", "`n")

if ($content.Contains("const phase7h2ConfirmedEntryTargets = {")) {
  Write-Host "PHASE7H2_APPLY=ALREADY_APPLIED"
  Write-Host "PHASE7H2_SERVICE=$servicePath"
  exit 0
}

if (-not $content.Contains("const phase7g2EmaHoldAblation = {")) {
  throw "Phase 7G.2 payload missing. Apply Phase 7G.2 first."
}
if (-not $content.Contains("const phase7f2ManagementAblation = {")) {
  throw "Phase 7F.2 management payload missing."
}
if (-not $content.Contains("const flip2Ablation = {")) {
  throw "Phase 7E.2 ablation payload missing."
}
if (-not $content.Contains("async function bridgeGetHistory<")) {
  throw "Chunked Phase 7E history helper missing. Apply Phase 7E.3 chunked-history patch first."
}
if ($content.Contains("const phase7g1MaRegimeAblation = {")) {
  throw "Phase 7G.1 MA entry-filter patch is applied locally. Phase 7H.2 requires no MA/EMA entry filter."
}

# Allow H1/H4 through the already-proven chunked bridge history helper.
$oldTf = '  timeframe: "M15" | "M5",'
$newTf = '  timeframe: "M15" | "M5" | "H1" | "H4",'
if ($content.Contains($oldTf)) {
  $content = $content.Replace($oldTf, $newTf)
} elseif (-not $content.Contains($newTf)) {
  throw "Phase 7H.2 could not extend bridgeGetHistory timeframe union."
}

$warmupMarker = '  const warmupFromMs = fromMs - 45 * DAY_MS;'
$htfWarmupMarker = '  const htfWarmupFromMs = fromMs - 180 * DAY_MS;'
if (-not $content.Contains($warmupMarker)) { throw "Phase 7H.2 warmup marker not found." }
if (-not $content.Contains($htfWarmupMarker)) {
  $content = $content.Replace($warmupMarker, $warmupMarker + "`n" + $htfWarmupMarker)
}

$oldDestructure = '  const [health, spec, m15, m5, baseline] = await Promise.all(['
$newDestructure = '  const [health, spec, m15, m5, h1, h4, baseline] = await Promise.all(['
if ($content.Contains($oldDestructure)) {
  $content = $content.Replace($oldDestructure, $newDestructure)
} elseif (-not $content.Contains($newDestructure)) {
  throw "Phase 7H.2 Phase 7E history destructuring marker not found."
}

$m5Fetch = '    bridgeGetHistory<Bar>("M5", warmupFromMs, toMs, 90_000),'
$h1Fetch = '    bridgeGetHistory<Bar>("H1", htfWarmupFromMs, toMs, 60_000),'
$h4Fetch = '    bridgeGetHistory<Bar>("H4", htfWarmupFromMs, toMs, 60_000),'
if (-not $content.Contains($m5Fetch)) { throw "Phase 7H.2 M5 chunked history marker not found." }
if (-not $content.Contains($h1Fetch)) {
  $content = $content.Replace($m5Fetch, $m5Fetch + "`n" + $h1Fetch + "`n" + $h4Fetch)
}

$sortMarker = '  const sortedM5 = [...m5].sort((a, b) => a.openTime - b.openTime);'
$sortedH1 = '  const sortedH1 = [...h1].sort((a, b) => a.openTime - b.openTime);'
$sortedH4 = '  const sortedH4 = [...h4].sort((a, b) => a.openTime - b.openTime);'
if (-not $content.Contains($sortMarker)) { throw "Phase 7H.2 M5 sort marker not found." }
if (-not $content.Contains($sortedH1)) {
  $content = $content.Replace($sortMarker, $sortMarker + "`n" + $sortedH1 + "`n" + $sortedH4)
}

$timesMarker = '  const m15CloseTimes = sortedM15.map((b) => b.closeTime);'
$h1Times = '  const h1CloseTimes = sortedH1.map((b) => b.closeTime);'
$h4Times = '  const h4CloseTimes = sortedH4.map((b) => b.closeTime);'
if (-not $content.Contains($timesMarker)) { throw "Phase 7H.2 M15 close-time marker not found." }
if (-not $content.Contains($h1Times)) {
  $content = $content.Replace($timesMarker, $timesMarker + "`n" + $h1Times + "`n" + $h4Times)
}

$functionMarker = "function phase7fPercentile(values: number[], percentile: number) {"
if (-not $content.Contains($functionMarker)) { throw "Phase 7F.1 function marker not found." }

$functions = @'
type Phase7H2FvgConfirmation = {
  formedIndex: number;
  zoneLow: number;
  zoneHigh: number;
  retestBySignal: boolean;
};

type Phase7H2TargetSource = "CONFIRMED_SWING" | "OPPOSING_FVG";
type Phase7H2Target = {
  price: number;
  distance: number;
  source: Phase7H2TargetSource;
};

function phase7h2DirectionalFvgConfirmation(
  signal: Signal,
  m15: Bar[],
  m15CloseTimes: number[],
  lookback: number,
): Phase7H2FvgConfirmation | null {
  const signalIndex = upperBound(m15CloseTimes, signal.signalTimestamp) - 1;
  if (signalIndex < 3) return null;
  const start = Math.max(2, signalIndex - lookback);

  for (let index = signalIndex - 1; index >= start; index -= 1) {
    const first = m15[index - 2]!;
    const third = m15[index]!;
    let zoneLow = 0;
    let zoneHigh = 0;

    if (signal.side === "BUY") {
      if (!(third.low > first.high + 1e-9)) continue;
      zoneLow = first.high;
      zoneHigh = third.low;
    } else {
      if (!(third.high < first.low - 1e-9)) continue;
      zoneLow = third.high;
      zoneHigh = first.low;
    }

    let fullyFilled = false;
    for (let cursor = index + 1; cursor < signalIndex; cursor += 1) {
      const bar = m15[cursor]!;
      if (signal.side === "BUY" && bar.low <= zoneLow + 1e-9) { fullyFilled = true; break; }
      if (signal.side === "SELL" && bar.high >= zoneHigh - 1e-9) { fullyFilled = true; break; }
    }
    if (fullyFilled) continue;

    const signalBar = m15[signalIndex]!;
    const retestBySignal = signalBar.low <= zoneHigh + 1e-9 && signalBar.high >= zoneLow - 1e-9;
    return { formedIndex: index, zoneLow, zoneHigh, retestBySignal };
  }

  return null;
}

function phase7h2HigherTimeframeTarget(
  signal: Signal,
  referencePrice: number,
  bars: Bar[],
  closeTimes: number[],
): Phase7H2Target | null {
  const signalIndex = upperBound(closeTimes, signal.signalTimestamp) - 1;
  if (signalIndex < 2) return null;
  const candidates: Phase7H2Target[] = [];

  // Confirmed swing: right-hand confirmation bar must already be closed by signal time.
  for (let index = 1; index < signalIndex; index += 1) {
    const left = bars[index - 1]!;
    const middle = bars[index]!;
    const right = bars[index + 1]!;
    if (signal.side === "BUY") {
      if (middle.high > left.high && middle.high >= right.high && middle.high > referencePrice + 1e-9) {
        candidates.push({ price: middle.high, distance: middle.high - referencePrice, source: "CONFIRMED_SWING" });
      }
    } else if (middle.low < left.low && middle.low <= right.low && middle.low < referencePrice - 1e-9) {
      candidates.push({ price: middle.low, distance: referencePrice - middle.low, source: "CONFIRMED_SWING" });
    }
  }

  // Opposing HTF FVG is treated as a potential reaction/TP zone, never as an entry filter.
  for (let index = 2; index <= signalIndex; index += 1) {
    const first = bars[index - 2]!;
    const third = bars[index]!;

    if (signal.side === "BUY" && third.high < first.low - 1e-9) {
      const zoneLow = third.high;
      const zoneHigh = first.low;
      let fullyFilled = false;
      for (let cursor = index + 1; cursor <= signalIndex; cursor += 1) {
        if (bars[cursor]!.high >= zoneHigh - 1e-9) { fullyFilled = true; break; }
      }
      if (!fullyFilled && zoneLow > referencePrice + 1e-9) {
        candidates.push({ price: zoneLow, distance: zoneLow - referencePrice, source: "OPPOSING_FVG" });
      }
    }

    if (signal.side === "SELL" && third.low > first.high + 1e-9) {
      const zoneLow = first.high;
      const zoneHigh = third.low;
      let fullyFilled = false;
      for (let cursor = index + 1; cursor <= signalIndex; cursor += 1) {
        if (bars[cursor]!.low <= zoneLow + 1e-9) { fullyFilled = true; break; }
      }
      if (!fullyFilled && zoneHigh < referencePrice - 1e-9) {
        candidates.push({ price: zoneHigh, distance: referencePrice - zoneHigh, source: "OPPOSING_FVG" });
      }
    }
  }

  return candidates.sort((a, b) => a.distance - b.distance)[0] ?? null;
}

function phase7h2TargetTouchedBeforeCanonicalExit(
  trade: Trade,
  target: Phase7H2Target | null,
  m5: Bar[],
  m5OpenTimes: number[],
) {
  if (target === null) return false;
  const startIndex = lowerBound(m5OpenTimes, trade.entryTime);
  for (let index = startIndex; index < m5.length; index += 1) {
    const bar = m5[index]!;
    if (bar.openTime > trade.exitTime) break;
    const stopExitBar = trade.exitReason === "STOP" && bar.closeTime >= trade.exitTime;
    if (stopExitBar) break;
    if (bar.closeTime <= trade.exitTime) {
      if (trade.side === "BUY" && bar.high >= target.price - 1e-9) return true;
      if (trade.side === "SELL" && bar.low + bar.spread <= target.price + 1e-9) return true;
    }
    if (bar.closeTime >= trade.exitTime) break;
  }
  return false;
}

function phase7h2TargetDiagnostics(
  trades: Trade[],
  h1: Bar[],
  h1CloseTimes: number[],
  h4: Bar[],
  h4CloseTimes: number[],
  m5: Bar[],
  m5OpenTimes: number[],
) {
  const rows = trades.map((trade) => {
    const h1Target = phase7h2HigherTimeframeTarget(trade, trade.entry, h1, h1CloseTimes);
    const h4Target = phase7h2HigherTimeframeTarget(trade, trade.entry, h4, h4CloseTimes);
    return {
      signalTimestamp: trade.signalTimestamp,
      side: trade.side,
      pattern: trade.pattern,
      entry: trade.entry,
      h1Target,
      h4Target,
      h1HitBeforeCanonicalExit: phase7h2TargetTouchedBeforeCanonicalExit(trade, h1Target, m5, m5OpenTimes),
      h4HitBeforeCanonicalExit: phase7h2TargetTouchedBeforeCanonicalExit(trade, h4Target, m5, m5OpenTimes),
    };
  });

  const h1Rows = rows.filter((row) => row.h1Target !== null);
  const h4Rows = rows.filter((row) => row.h4Target !== null);
  const h1Distances = h1Rows.map((row) => row.h1Target!.distance);
  const h4Distances = h4Rows.map((row) => row.h4Target!.distance);
  return {
    trades: trades.length,
    h1Available: h1Rows.length,
    h1CoveragePercent: round(trades.length ? h1Rows.length / trades.length * 100 : 0, 2),
    h1AverageDistance: round(avg(h1Distances), 4),
    h1MedianDistance: round(phase7fPercentile(h1Distances, 0.5), 4),
    h1HitBeforeCanonicalExit: h1Rows.filter((row) => row.h1HitBeforeCanonicalExit).length,
    h1HitRatePercent: round(h1Rows.length ? h1Rows.filter((row) => row.h1HitBeforeCanonicalExit).length / h1Rows.length * 100 : 0, 2),
    h1SwingTargets: h1Rows.filter((row) => row.h1Target!.source === "CONFIRMED_SWING").length,
    h1FvgTargets: h1Rows.filter((row) => row.h1Target!.source === "OPPOSING_FVG").length,
    h4Available: h4Rows.length,
    h4CoveragePercent: round(trades.length ? h4Rows.length / trades.length * 100 : 0, 2),
    h4AverageDistance: round(avg(h4Distances), 4),
    h4MedianDistance: round(phase7fPercentile(h4Distances, 0.5), 4),
    h4HitBeforeCanonicalExit: h4Rows.filter((row) => row.h4HitBeforeCanonicalExit).length,
    h4HitRatePercent: round(h4Rows.length ? h4Rows.filter((row) => row.h4HitBeforeCanonicalExit).length / h4Rows.length * 100 : 0, 2),
    h4SwingTargets: h4Rows.filter((row) => row.h4Target!.source === "CONFIRMED_SWING").length,
    h4FvgTargets: h4Rows.filter((row) => row.h4Target!.source === "OPPOSING_FVG").length,
    rows,
  };
}

'@
$functions = $functions.Replace("`r`n", "`n")
$content = $content.Replace($functionMarker, $functions + $functionMarker)

$stateMarker = "  const state = variants[0]!;"
if (-not $content.Contains($stateMarker)) { throw "Phase 7H.2 state marker not found." }

$block = @'
  const phase7h2FvgLookback = 12;
  const phase7h2TriggerSignals = flip2Accepted;
  const phase7h2ConfirmedSignals = phase7h2TriggerSignals.filter(
    (signal) => phase7h2DirectionalFvgConfirmation(signal, sortedM15, m15CloseTimes, phase7h2FvgLookback) !== null,
  );

  const phase7h2ReplayCell = (signals: Signal[]) => {
    const replay = replaySignals(signals);
    const metrics = summarizePhase7F2(replay.trades, replay.skippedWhileOpen);
    const path = buildPhase7FPathDiagnostics(replay.trades, sortedM5, m5OpenTimes, spec);
    const targets = phase7h2TargetDiagnostics(
      replay.trades, sortedH1, h1CloseTimes, sortedH4, h4CloseTimes, sortedM5, m5OpenTimes,
    );
    return {
      acceptedSignals: signals.length,
      metrics: {
        ...metrics,
        hitPlus6: path.metrics.hitPlus6,
        hitPlus10: path.metrics.hitPlus10,
        averageWinnerCaptureRatioPercent: path.metrics.averageWinnerCaptureRatioPercent,
        averageGivebackFromMfePrice: path.metrics.averageGivebackFromMfePrice,
      },
      targets: {
        h1Available: targets.h1Available,
        h1CoveragePercent: targets.h1CoveragePercent,
        h1AverageDistance: targets.h1AverageDistance,
        h1MedianDistance: targets.h1MedianDistance,
        h1HitBeforeCanonicalExit: targets.h1HitBeforeCanonicalExit,
        h1HitRatePercent: targets.h1HitRatePercent,
        h1SwingTargets: targets.h1SwingTargets,
        h1FvgTargets: targets.h1FvgTargets,
        h4Available: targets.h4Available,
        h4CoveragePercent: targets.h4CoveragePercent,
        h4AverageDistance: targets.h4AverageDistance,
        h4MedianDistance: targets.h4MedianDistance,
        h4HitBeforeCanonicalExit: targets.h4HitBeforeCanonicalExit,
        h4HitRatePercent: targets.h4HitRatePercent,
        h4SwingTargets: targets.h4SwingTargets,
        h4FvgTargets: targets.h4FvgTargets,
      },
      targetPlans: targets.rows.slice(-500).reverse(),
      trades: replay.trades.slice(-500).reverse(),
    };
  };

  const phase7h2BuildSide = (side: Side) => {
    const preFvg = phase7h2TriggerSignals.filter((signal) => signal.side === side);
    const confirmed = phase7h2ConfirmedSignals.filter((signal) => signal.side === side);
    const retest = confirmed.filter((signal) =>
      phase7h2DirectionalFvgConfirmation(signal, sortedM15, m15CloseTimes, phase7h2FvgLookback)?.retestBySignal === true,
    );
    const contextOnly = confirmed.filter((signal) =>
      phase7h2DirectionalFvgConfirmation(signal, sortedM15, m15CloseTimes, phase7h2FvgLookback)?.retestBySignal !== true,
    );

    return {
      side,
      preFvgConfirmedSignals: preFvg.length,
      fvgConfirmedSignals: confirmed.length,
      fvgRetentionPercent: round(preFvg.length ? confirmed.length / preFvg.length * 100 : 0, 2),
      combined: phase7h2ReplayCell(confirmed),
      patterns: {
        engulfing: phase7h2ReplayCell(confirmed.filter((signal) => signal.pattern === "ENGULFING")),
        twoCandle: phase7h2ReplayCell(confirmed.filter((signal) => signal.pattern === "TWO_CANDLE_BODY_DOMINANCE")),
      },
      fvgQuality: {
        retestIsBonusOnly: true,
        retest: phase7h2ReplayCell(retest),
        contextWithoutSignalRetest: phase7h2ReplayCell(contextOnly),
      },
    };
  };

  const phase7h2ConfirmedEntryTargets = {
    source: "PHASE7H2_DUAL_PATTERN_CONFIRMED_ENTRY_HTF_TARGET_RESEARCH",
    sourceVariant: "M5_FLIP_2",
    triggerPatterns: ["ENGULFING", "TWO_CANDLE_BODY_DOMINANCE"],
    entryRule: "PATTERN_TRIGGER_PLUS_M15_SUPERTREND_PLUS_FRESH_ALIGNED_M5_FLIP2_PLUS_M15_DIRECTIONAL_FVG_CONTEXT",
    confirmations: {
      m15SupertrendRequired: true,
      m5AlignedTrendRequired: true,
      m5FreshFlipMaxClosedBars: 2,
      m15DirectionalFvgRequired: true,
      fvgLookbackBars: phase7h2FvgLookback,
      fvgSignalRetestRequired: false,
      fvgSignalRetestRole: "QUALITY_BONUS_ONLY",
      maEntryFilter: false,
      emaEntryFilter: false,
      h1EntryFilter: false,
      h4EntryFilter: false,
    },
    management: {
      canonicalFrozenForResearch: true,
      h1Role: "TP_REFERENCE_ONLY",
      h4Role: "RUNNER_TARGET_REFERENCE_ONLY",
      htfTargetSources: ["CONFIRMED_SWING", "OPPOSING_FVG"],
      htfTargetsMutateCanonicalExit: false,
      emaRole: "TREND_HOLD_DIAGNOSTIC_ONLY_NOT_ENTRY",
    },
    safety: {
      researchOnly: true,
      productionEntryMutation: false,
      productionManagementMutation: false,
      executionMutation: false,
      phase7bStrategyMutation: false,
      executionEligible: false,
    },
    buy: phase7h2BuildSide("BUY"),
    sell: phase7h2BuildSide("SELL"),
  };

'@
$block = $block.Replace("`r`n", "`n")
$content = $content.Replace($stateMarker, $block + $stateMarker)

$returnWithH1 = "    phase7h1FvgAblation,`n    decision: {"
$returnWithoutH1 = "    phase7g2EmaHoldAblation,`n    decision: {"
if ($content.Contains($returnWithH1)) {
  $content = $content.Replace(
    $returnWithH1,
    "    phase7h1FvgAblation,`n    phase7h2ConfirmedEntryTargets,`n    decision: {"
  )
} elseif ($content.Contains($returnWithoutH1)) {
  $content = $content.Replace(
    $returnWithoutH1,
    "    phase7g2EmaHoldAblation,`n    phase7h2ConfirmedEntryTargets,`n    decision: {"
  )
} else {
  throw "Phase 7H.2 return marker not found."
}

$required = @(
  'bridgeGetHistory<Bar>("H1", htfWarmupFromMs, toMs, 60_000)',
  'bridgeGetHistory<Bar>("H4", htfWarmupFromMs, toMs, 60_000)',
  'const phase7h2ConfirmedEntryTargets = {',
  'triggerPatterns: ["ENGULFING", "TWO_CANDLE_BODY_DOMINANCE"]',
  'm15DirectionalFvgRequired: true',
  'h1Role: "TP_REFERENCE_ONLY"',
  'h4Role: "RUNNER_TARGET_REFERENCE_ONLY"',
  'executionEligible: false'
)
foreach ($needle in $required) {
  if (-not $content.Contains($needle)) { throw "Phase 7H.2 validation failed after patch: $needle" }
}

if ($newline -eq "`r`n") { $content = $content.Replace("`n", "`r`n") }
[System.IO.File]::WriteAllText($servicePath, $content, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "PHASE7H2_APPLY=PASS"
Write-Host "PHASE7H2_SERVICE=$servicePath"
Write-Host "PHASE7H2_SIDES=BUY,SELL"
Write-Host "PHASE7H2_TRIGGER_PATTERNS=ENGULFING,TWO_CANDLE_BODY_DOMINANCE"
Write-Host "PHASE7H2_ENTRY=M15_SUPERTREND+M5_ALIGNED_FRESH_FLIP2+PATTERN+M15_FVG_CONTEXT"
Write-Host "PHASE7H2_FVG_REQUIRED=True"
Write-Host "PHASE7H2_FVG_RETEST=QUALITY_BONUS_ONLY"
Write-Host "PHASE7H2_H1_ROLE=TP_REFERENCE_ONLY"
Write-Host "PHASE7H2_H4_ROLE=RUNNER_TARGET_REFERENCE_ONLY"
Write-Host "PHASE7H2_HTF_LOOKAHEAD=False"
Write-Host "PHASE7H2_MA_ENTRY_FILTER=False"
Write-Host "PHASE7H2_EMA_ENTRY_FILTER=False"
Write-Host "PHASE7H2_H1_ENTRY_FILTER=False"
Write-Host "PHASE7H2_H4_ENTRY_FILTER=False"
Write-Host "PHASE7H2_PRODUCTION_ENTRY_MUTATION=False"
Write-Host "PHASE7H2_PRODUCTION_MANAGEMENT_MUTATION=False"
Write-Host "PHASE7H2_EXECUTION_ELIGIBLE=False"
Write-Host "PHASE7H2_NEXT=pnpm --filter @xauusd/api build"
