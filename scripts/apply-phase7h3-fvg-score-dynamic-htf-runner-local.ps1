param()

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$servicePath = Join-Path $repoRoot "apps/api/src/services/phase7e-realignment.service.ts"

if (-not (Test-Path $servicePath)) { throw "Phase 7E service not found: $servicePath" }

$raw = [System.IO.File]::ReadAllText($servicePath)
$newline = if ($raw.Contains("`r`n")) { "`r`n" } else { "`n" }
$content = $raw.Replace("`r`n", "`n")

if ($content.Contains("const phase7h3FvgScoreDynamicTargets = {")) {
  Write-Host "PHASE7H3_APPLY=ALREADY_APPLIED"
  Write-Host "PHASE7H3_SERVICE=$servicePath"
  exit 0
}

if (-not $content.Contains("const phase7h2ConfirmedEntryTargets = {")) {
  throw "Phase 7H.2 payload missing. Apply Phase 7H.2 first."
}
if (-not $content.Contains("function phase7h2DirectionalFvgConfirmation(")) {
  throw "Phase 7H.2 FVG diagnostic helper missing."
}
if (-not $content.Contains("const phase7f2ManagementAblation = {")) {
  throw "Phase 7F.2 management payload missing."
}
if (-not $content.Contains("const flip2Ablation = {")) {
  throw "Phase 7E.2 ablation payload missing."
}
if ($content.Contains("const phase7g1MaRegimeAblation = {")) {
  throw "Phase 7G.1 MA entry-filter patch is applied locally. Phase 7H.3 forbids MA/EMA entry filters."
}

$functionMarker = "function phase7fPercentile(values: number[], percentile: number) {"
if (-not $content.Contains($functionMarker)) { throw "Phase 7F.1 function marker not found." }

$functions = @'
type Phase7H3FvgScore = 0 | 1 | 2;
type Phase7H3DynamicTargetSource = "CONFIRMED_SWING" | "OPPOSING_FVG";
type Phase7H3DynamicTarget = {
  price: number;
  distanceFromPlus10: number;
  distanceFromEntry: number;
  source: Phase7H3DynamicTargetSource;
};

type Phase7H3Plus10Event = {
  time: number;
  referencePrice: number;
};

function phase7h3FvgScore(
  signal: Signal,
  m15: Bar[],
  m15CloseTimes: number[],
  lookback: number,
): Phase7H3FvgScore {
  const confirmation = phase7h2DirectionalFvgConfirmation(signal, m15, m15CloseTimes, lookback);
  if (confirmation === null) return 0;
  return confirmation.retestBySignal ? 2 : 1;
}

function phase7h3FirstPlus10Event(
  trade: Trade,
  m5: Bar[],
  m5OpenTimes: number[],
): Phase7H3Plus10Event | null {
  if (!trade.partialApplied) return null;
  const startIndex = lowerBound(m5OpenTimes, trade.entryTime);

  for (let index = startIndex; index < m5.length; index += 1) {
    const bar = m5[index]!;
    if (bar.openTime > trade.exitTime) break;
    const isStopExitBar = trade.exitReason === "STOP" && bar.closeTime >= trade.exitTime;
    if (isStopExitBar) break;

    if (bar.closeTime <= trade.exitTime) {
      const favorable = trade.side === "BUY"
        ? bar.high - trade.entry
        : trade.entry - (bar.low + bar.spread);
      if (favorable >= 10 - 1e-9) {
        return {
          time: bar.closeTime,
          referencePrice: trade.side === "BUY" ? trade.entry + 10 : trade.entry - 10,
        };
      }
    }
    if (bar.closeTime >= trade.exitTime) break;
  }

  return null;
}

function phase7h3HigherTimeframeTargetAt(
  side: Side,
  timestamp: number,
  entryPrice: number,
  referencePrice: number,
  bars: Bar[],
  closeTimes: number[],
): Phase7H3DynamicTarget | null {
  const signalIndex = upperBound(closeTimes, timestamp) - 1;
  if (signalIndex < 2) return null;
  const candidates: Phase7H3DynamicTarget[] = [];

  // Only swings confirmed by an already-closed right-hand bar are eligible.
  for (let index = 1; index < signalIndex; index += 1) {
    const left = bars[index - 1]!;
    const middle = bars[index]!;
    const right = bars[index + 1]!;

    if (side === "BUY") {
      if (middle.high > left.high && middle.high >= right.high && middle.high > referencePrice + 1e-9) {
        candidates.push({
          price: middle.high,
          distanceFromPlus10: middle.high - referencePrice,
          distanceFromEntry: middle.high - entryPrice,
          source: "CONFIRMED_SWING",
        });
      }
    } else if (middle.low < left.low && middle.low <= right.low && middle.low < referencePrice - 1e-9) {
      candidates.push({
        price: middle.low,
        distanceFromPlus10: referencePrice - middle.low,
        distanceFromEntry: entryPrice - middle.low,
        source: "CONFIRMED_SWING",
      });
    }
  }

  // Opposing HTF FVGs are reaction targets only; they never validate entry.
  for (let index = 2; index <= signalIndex; index += 1) {
    const first = bars[index - 2]!;
    const third = bars[index]!;

    if (side === "BUY" && third.high < first.low - 1e-9) {
      const zoneLow = third.high;
      const zoneHigh = first.low;
      let fullyFilled = false;
      for (let cursor = index + 1; cursor <= signalIndex; cursor += 1) {
        if (bars[cursor]!.high >= zoneHigh - 1e-9) { fullyFilled = true; break; }
      }
      if (!fullyFilled && zoneLow > referencePrice + 1e-9) {
        candidates.push({
          price: zoneLow,
          distanceFromPlus10: zoneLow - referencePrice,
          distanceFromEntry: zoneLow - entryPrice,
          source: "OPPOSING_FVG",
        });
      }
    }

    if (side === "SELL" && third.low > first.high + 1e-9) {
      const zoneLow = first.high;
      const zoneHigh = third.low;
      let fullyFilled = false;
      for (let cursor = index + 1; cursor <= signalIndex; cursor += 1) {
        if (bars[cursor]!.low <= zoneLow + 1e-9) { fullyFilled = true; break; }
      }
      if (!fullyFilled && zoneHigh < referencePrice - 1e-9) {
        candidates.push({
          price: zoneHigh,
          distanceFromPlus10: referencePrice - zoneHigh,
          distanceFromEntry: entryPrice - zoneHigh,
          source: "OPPOSING_FVG",
        });
      }
    }
  }

  return candidates.sort((a, b) => a.distanceFromPlus10 - b.distanceFromPlus10)[0] ?? null;
}

function phase7h3DynamicTargetTouchedAfterPlus10(
  trade: Trade,
  plus10: Phase7H3Plus10Event,
  target: Phase7H3DynamicTarget | null,
  m5: Bar[],
  m5OpenTimes: number[],
) {
  if (target === null) return false;

  // Start from the next M5 bar after the +10 event close. This avoids using an
  // intrabar target hit that happened before the target became observable.
  const startIndex = lowerBound(m5OpenTimes, plus10.time);
  for (let index = startIndex; index < m5.length; index += 1) {
    const bar = m5[index]!;
    if (bar.openTime > trade.exitTime) break;
    const isStopExitBar = trade.exitReason === "STOP" && bar.closeTime >= trade.exitTime;
    if (isStopExitBar) break;

    if (bar.closeTime <= trade.exitTime) {
      if (trade.side === "BUY" && bar.high >= target.price - 1e-9) return true;
      if (trade.side === "SELL" && bar.low + bar.spread <= target.price + 1e-9) return true;
    }
    if (bar.closeTime >= trade.exitTime) break;
  }
  return false;
}

function phase7h3DynamicTargetDiagnostics(
  trades: Trade[],
  h1: Bar[],
  h1CloseTimes: number[],
  h4: Bar[],
  h4CloseTimes: number[],
  m5: Bar[],
  m5OpenTimes: number[],
) {
  const canonicalPlus10 = trades.filter((trade) => trade.partialApplied).length;
  const rows = trades.map((trade) => {
    const plus10 = phase7h3FirstPlus10Event(trade, m5, m5OpenTimes);
    if (plus10 === null) {
      return {
        signalTimestamp: trade.signalTimestamp,
        side: trade.side,
        pattern: trade.pattern,
        plus10: null,
        h1Target: null,
        h4Target: null,
        h4RunnerQualified: false,
        h1HitBeforeCanonicalExit: false,
        h4HitBeforeCanonicalExit: false,
      };
    }

    const h1Target = phase7h3HigherTimeframeTargetAt(
      trade.side,
      plus10.time,
      trade.entry,
      plus10.referencePrice,
      h1,
      h1CloseTimes,
    );
    const h4Target = phase7h3HigherTimeframeTargetAt(
      trade.side,
      plus10.time,
      trade.entry,
      plus10.referencePrice,
      h4,
      h4CloseTimes,
    );
    const h4RunnerQualified = h4Target !== null && (
      h1Target === null || h4Target.distanceFromPlus10 > h1Target.distanceFromPlus10 + 1e-9
    );

    return {
      signalTimestamp: trade.signalTimestamp,
      side: trade.side,
      pattern: trade.pattern,
      plus10,
      h1Target,
      h4Target,
      h4RunnerQualified,
      h1HitBeforeCanonicalExit: phase7h3DynamicTargetTouchedAfterPlus10(
        trade,
        plus10,
        h1Target,
        m5,
        m5OpenTimes,
      ),
      h4HitBeforeCanonicalExit: h4RunnerQualified
        ? phase7h3DynamicTargetTouchedAfterPlus10(trade, plus10, h4Target, m5, m5OpenTimes)
        : false,
    };
  });

  const plus10Rows = rows.filter((row) => row.plus10 !== null);
  const h1Rows = plus10Rows.filter((row) => row.h1Target !== null);
  const h4Rows = plus10Rows.filter((row) => row.h4Target !== null);
  const h4RunnerRows = h4Rows.filter((row) => row.h4RunnerQualified);
  const h1EntryDistances = h1Rows.map((row) => row.h1Target!.distanceFromEntry);
  const h1Post10Distances = h1Rows.map((row) => row.h1Target!.distanceFromPlus10);
  const h4EntryDistances = h4RunnerRows.map((row) => row.h4Target!.distanceFromEntry);
  const h4Post10Distances = h4RunnerRows.map((row) => row.h4Target!.distanceFromPlus10);

  return {
    metrics: {
      trades: trades.length,
      canonicalPlus10,
      reconstructedPlus10: plus10Rows.length,
      missingPlus10Events: Math.max(0, canonicalPlus10 - plus10Rows.length),
      h1AvailableAfterPlus10: h1Rows.length,
      h1CoverageOfPlus10Percent: round(plus10Rows.length ? h1Rows.length / plus10Rows.length * 100 : 0, 2),
      h1AverageDistanceFromEntry: round(avg(h1EntryDistances), 4),
      h1MedianDistanceFromEntry: round(phase7fPercentile(h1EntryDistances, 0.5), 4),
      h1AverageDistanceAfterPlus10: round(avg(h1Post10Distances), 4),
      h1MedianDistanceAfterPlus10: round(phase7fPercentile(h1Post10Distances, 0.5), 4),
      h1HitBeforeCanonicalExit: h1Rows.filter((row) => row.h1HitBeforeCanonicalExit).length,
      h1HitRatePercent: round(h1Rows.length ? h1Rows.filter((row) => row.h1HitBeforeCanonicalExit).length / h1Rows.length * 100 : 0, 2),
      h1SwingTargets: h1Rows.filter((row) => row.h1Target!.source === "CONFIRMED_SWING").length,
      h1FvgTargets: h1Rows.filter((row) => row.h1Target!.source === "OPPOSING_FVG").length,
      h4AvailableAfterPlus10: h4Rows.length,
      h4RunnerQualified: h4RunnerRows.length,
      h4RunnerCoverageOfPlus10Percent: round(plus10Rows.length ? h4RunnerRows.length / plus10Rows.length * 100 : 0, 2),
      h4AverageDistanceFromEntry: round(avg(h4EntryDistances), 4),
      h4MedianDistanceFromEntry: round(phase7fPercentile(h4EntryDistances, 0.5), 4),
      h4AverageDistanceAfterPlus10: round(avg(h4Post10Distances), 4),
      h4MedianDistanceAfterPlus10: round(phase7fPercentile(h4Post10Distances, 0.5), 4),
      h4HitBeforeCanonicalExit: h4RunnerRows.filter((row) => row.h4HitBeforeCanonicalExit).length,
      h4HitRatePercent: round(h4RunnerRows.length ? h4RunnerRows.filter((row) => row.h4HitBeforeCanonicalExit).length / h4RunnerRows.length * 100 : 0, 2),
      h4SwingTargets: h4RunnerRows.filter((row) => row.h4Target!.source === "CONFIRMED_SWING").length,
      h4FvgTargets: h4RunnerRows.filter((row) => row.h4Target!.source === "OPPOSING_FVG").length,
    },
    plans: rows.filter((row) => row.plus10 !== null).slice(-500).reverse(),
  };
}

'@
$functions = $functions.Replace("`r`n", "`n")
$content = $content.Replace($functionMarker, $functions + $functionMarker)

$stateMarker = "  const state = variants[0]!;"
if (-not $content.Contains($stateMarker)) { throw "Phase 7H.3 state marker not found." }

$block = @'
  const phase7h3FvgLookback = 12;

  const phase7h3ReplayCell = (accepted: Signal[]) => {
    const replay = replaySignals(accepted);
    const metrics = summarizePhase7F2(replay.trades, replay.skippedWhileOpen);
    const path = buildPhase7FPathDiagnostics(replay.trades, sortedM5, m5OpenTimes, spec);
    const targets = phase7h3DynamicTargetDiagnostics(
      replay.trades,
      sortedH1,
      h1CloseTimes,
      sortedH4,
      h4CloseTimes,
      sortedM5,
      m5OpenTimes,
    );
    return {
      acceptedSignals: accepted.length,
      metrics: {
        ...metrics,
        hitPlus6: path.metrics.hitPlus6,
        hitPlus10: path.metrics.hitPlus10,
        averageWinnerCaptureRatioPercent: path.metrics.averageWinnerCaptureRatioPercent,
        averageGivebackFromMfePrice: path.metrics.averageGivebackFromMfePrice,
      },
      dynamicTargetsAfterPlus10: targets.metrics,
      targetPlans: targets.plans,
      trades: replay.trades.slice(-500).reverse(),
    };
  };

  const phase7h3BuildSide = (side: Side) => {
    const accepted = flip2Accepted.filter(
      (signal) => signal.side === side &&
        (signal.pattern === "ENGULFING" || signal.pattern === "TWO_CANDLE_BODY_DOMINANCE"),
    );
    const scored = accepted.map((signal) => ({
      signal,
      score: phase7h3FvgScore(signal, sortedM15, m15CloseTimes, phase7h3FvgLookback),
    }));
    const score0 = scored.filter((row) => row.score === 0).map((row) => row.signal);
    const score1 = scored.filter((row) => row.score === 1).map((row) => row.signal);
    const score2 = scored.filter((row) => row.score === 2).map((row) => row.signal);

    return {
      side,
      entryAcceptedSignals: accepted.length,
      combined: phase7h3ReplayCell(accepted),
      patterns: {
        engulfing: phase7h3ReplayCell(accepted.filter((signal) => signal.pattern === "ENGULFING")),
        twoCandle: phase7h3ReplayCell(accepted.filter((signal) => signal.pattern === "TWO_CANDLE_BODY_DOMINANCE")),
      },
      fvgQualityScore: {
        role: "QUALITY_SCORE_ONLY_NOT_ENTRY_FILTER",
        definitions: {
          score0: "NO_FRESH_DIRECTIONAL_M15_FVG_CONTEXT",
          score1: "FRESH_DIRECTIONAL_M15_FVG_CONTEXT_WITHOUT_SIGNAL_RETEST",
          score2: "FRESH_DIRECTIONAL_M15_FVG_CONTEXT_WITH_SIGNAL_RETEST",
        },
        distribution: {
          score0: score0.length,
          score1: score1.length,
          score2: score2.length,
        },
        score0: phase7h3ReplayCell(score0),
        score1: phase7h3ReplayCell(score1),
        score2: phase7h3ReplayCell(score2),
      },
    };
  };

  const phase7h3FvgScoreDynamicTargets = {
    source: "PHASE7H3_FVG_QUALITY_SCORE_DYNAMIC_HTF_RUNNER_RESEARCH",
    sourceVariant: "M5_FLIP_2",
    triggerPatterns: ["ENGULFING", "TWO_CANDLE_BODY_DOMINANCE"],
    entryRule: "PATTERN_TRIGGER_PLUS_M15_SUPERTREND_PLUS_FRESH_ALIGNED_M5_FLIP2;FVG_IS_QUALITY_SCORE_ONLY",
    confirmations: {
      m15SupertrendRequired: true,
      m5AlignedTrendRequired: true,
      m5FreshFlipMaxClosedBars: 2,
      fvgRequiredForEntry: false,
      fvgQualityScoreEnabled: true,
      fvgLookbackBars: phase7h3FvgLookback,
      maEntryFilter: false,
      emaEntryFilter: false,
      h1EntryFilter: false,
      h4EntryFilter: false,
    },
    managementResearch: {
      canonicalManagementFrozen: true,
      dynamicTargetActivation: "AFTER_CANONICAL_PLUS10_EVENT_ONLY",
      h1Role: "DYNAMIC_POST_PLUS10_TP_REFERENCE",
      h4Role: "DYNAMIC_POST_PLUS10_EXTENDED_RUNNER_REFERENCE",
      targetSources: ["CONFIRMED_SWING", "OPPOSING_FVG"],
      targetMustRemainBeyondPlus10Reference: true,
      h4RunnerMustBeFartherThanH1WhenBothExist: true,
      targetHitMeasurementStartsAfterPlus10EventBar: true,
      dynamicTargetsMutateCanonicalExit: false,
      emaRole: "TREND_WEAKNESS_DIAGNOSTIC_ONLY_NOT_ENTRY",
    },
    safety: {
      researchOnly: true,
      productionEntryMutation: false,
      productionManagementMutation: false,
      executionMutation: false,
      phase7bStrategyMutation: false,
      executionEligible: false,
    },
    buy: phase7h3BuildSide("BUY"),
    sell: phase7h3BuildSide("SELL"),
  };

'@
$block = $block.Replace("`r`n", "`n")
$content = $content.Replace($stateMarker, $block + $stateMarker)

$returnMarker = "    phase7h2ConfirmedEntryTargets,`n    decision: {"
if (-not $content.Contains($returnMarker)) {
  throw "Phase 7H.3 return marker not found. Apply Phase 7H.2 first."
}
$content = $content.Replace(
  $returnMarker,
  "    phase7h2ConfirmedEntryTargets,`n    phase7h3FvgScoreDynamicTargets,`n    decision: {"
)

$required = @(
  'const phase7h3FvgScoreDynamicTargets = {',
  'fvgRequiredForEntry: false',
  'fvgQualityScoreEnabled: true',
  'dynamicTargetActivation: "AFTER_CANONICAL_PLUS10_EVENT_ONLY"',
  'dynamicTargetsMutateCanonicalExit: false',
  'executionEligible: false'
)
foreach ($needle in $required) {
  if (-not $content.Contains($needle)) { throw "Phase 7H.3 validation failed after patch: $needle" }
}

if ($newline -eq "`r`n") { $content = $content.Replace("`n", "`r`n") }
[System.IO.File]::WriteAllText($servicePath, $content, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "PHASE7H3_APPLY=PASS"
Write-Host "PHASE7H3_SERVICE=$servicePath"
Write-Host "PHASE7H3_SIDES=BUY,SELL"
Write-Host "PHASE7H3_TRIGGER_PATTERNS=ENGULFING,TWO_CANDLE_BODY_DOMINANCE"
Write-Host "PHASE7H3_ENTRY=M15_SUPERTREND+M5_ALIGNED_FRESH_FLIP2+PATTERN"
Write-Host "PHASE7H3_FVG_REQUIRED_FOR_ENTRY=False"
Write-Host "PHASE7H3_FVG_MODE=QUALITY_SCORE_0_1_2"
Write-Host "PHASE7H3_FVG_LOOKBACK=12"
Write-Host "PHASE7H3_DYNAMIC_TARGET_ACTIVATION=AFTER_PLUS10"
Write-Host "PHASE7H3_H1_ROLE=DYNAMIC_POST_PLUS10_TP_REFERENCE"
Write-Host "PHASE7H3_H4_ROLE=DYNAMIC_POST_PLUS10_EXTENDED_RUNNER_REFERENCE"
Write-Host "PHASE7H3_HTF_LOOKAHEAD=False"
Write-Host "PHASE7H3_MA_ENTRY_FILTER=False"
Write-Host "PHASE7H3_EMA_ENTRY_FILTER=False"
Write-Host "PHASE7H3_H1_ENTRY_FILTER=False"
Write-Host "PHASE7H3_H4_ENTRY_FILTER=False"
Write-Host "PHASE7H3_PRODUCTION_ENTRY_MUTATION=False"
Write-Host "PHASE7H3_PRODUCTION_MANAGEMENT_MUTATION=False"
Write-Host "PHASE7H3_EXECUTION_ELIGIBLE=False"
Write-Host "PHASE7H3_NEXT=pnpm --filter @xauusd/api build"