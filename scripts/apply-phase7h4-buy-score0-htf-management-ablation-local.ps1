param()

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$servicePath = Join-Path $repoRoot "apps/api/src/services/phase7e-realignment.service.ts"

if (-not (Test-Path $servicePath)) { throw "Phase 7E service not found: $servicePath" }

$raw = [System.IO.File]::ReadAllText($servicePath)
$newline = if ($raw.Contains("`r`n")) { "`r`n" } else { "`n" }
$content = $raw.Replace("`r`n", "`n")

if ($content.Contains("const phase7h4BuyScore0HtfManagement = {")) {
  Write-Host "PHASE7H4_APPLY=ALREADY_APPLIED"
  Write-Host "PHASE7H4_SERVICE=$servicePath"
  exit 0
}

$requiredParents = @(
  'const phase7h3FvgScoreDynamicTargets = {',
  'function phase7h3FirstPlus10Event(',
  'function phase7h3HigherTimeframeTargetAt(',
  'const phase7f2ManagementAblation = {',
  'const flip2Ablation = {'
)
foreach ($needle in $requiredParents) {
  if (-not $content.Contains($needle)) { throw "Phase 7H.4 prerequisite missing: $needle" }
}
if ($content.Contains("const phase7g1MaRegimeAblation = {")) {
  throw "Phase 7G.1 MA entry-filter patch is applied locally. Phase 7H.4 forbids MA/EMA entry filters."
}

$functionMarker = "function phase7fPercentile(values: number[], percentile: number) {"
if (-not $content.Contains($functionMarker)) { throw "Phase 7F.1 function marker not found." }

$functions = @'
type Phase7H4VariantName =
  | "H0_CANONICAL_SCORE0"
  | "H1_FULL_REMAINDER_AT_H1"
  | "H2_HALF_REMAINDER_AT_H1_CANONICAL_FINAL"
  | "H3_HALF_REMAINDER_AT_H1_H4_FINAL"
  | "H4_FULL_REMAINDER_AT_H4";

type Phase7H4Overlay =
  | "CANONICAL"
  | "H1_FULL_REMAINDER"
  | "H1_HALF_CANONICAL_FINAL"
  | "H1_HALF_H4_FINAL"
  | "H4_FULL_REMAINDER";

type Phase7H4Trade = Trade & {
  phase7h4Overlay: Phase7H4Overlay;
  phase7h4H1Taken: boolean;
  phase7h4H4Taken: boolean;
  phase7h4TemporalFallback: boolean;
};

type Phase7H4Hit = { time: number; price: number };

function phase7h4FirstTargetHitAfterPlus10(
  trade: Trade,
  plus10: Phase7H3Plus10Event,
  target: Phase7H3DynamicTarget | null,
  m5: Bar[],
  m5OpenTimes: number[],
): Phase7H4Hit | null {
  if (target === null) return null;
  const startIndex = lowerBound(m5OpenTimes, plus10.time);
  for (let index = startIndex; index < m5.length; index += 1) {
    const bar = m5[index]!;
    if (bar.openTime > trade.exitTime) break;
    const isStopExitBar = trade.exitReason === "STOP" && bar.closeTime >= trade.exitTime;
    if (isStopExitBar) break;
    if (bar.closeTime <= trade.exitTime) {
      const touched = trade.side === "BUY"
        ? bar.high >= target.price - 1e-9
        : bar.low + bar.spread <= target.price + 1e-9;
      if (touched) return { time: bar.closeTime, price: target.price };
    }
    if (bar.closeTime >= trade.exitTime) break;
  }
  return null;
}

function phase7h4Outcome(
  trade: Trade,
  exitTime: number,
  exitPrice: number,
  pnl: number,
  remainingVolumeAtExit: number,
  overlay: Phase7H4Overlay,
  h1Taken: boolean,
  h4Taken: boolean,
  temporalFallback: boolean,
  spec: Spec,
): Phase7H4Trade {
  return {
    ...trade,
    exitTime,
    exit: round(exitPrice, spec.digits),
    pnl: round(pnl, 2),
    rMultiple: round(trade.initialRiskUsd > 0 ? pnl / trade.initialRiskUsd : 0, 4),
    holdHours: round((exitTime - trade.entryTime) / 3_600_000, 4),
    remainingVolumeAtExit: round(remainingVolumeAtExit, 4),
    phase7h4Overlay: overlay,
    phase7h4H1Taken: h1Taken,
    phase7h4H4Taken: h4Taken,
    phase7h4TemporalFallback: temporalFallback,
  };
}

function phase7h4ApplyOverlay(
  trade: Trade,
  variant: Phase7H4VariantName,
  h1: Bar[],
  h1CloseTimes: number[],
  h4: Bar[],
  h4CloseTimes: number[],
  m5: Bar[],
  m5OpenTimes: number[],
  spec: Spec,
): Phase7H4Trade {
  const canonical = phase7h4Outcome(
    trade,
    trade.exitTime,
    trade.exit,
    trade.pnl,
    trade.remainingVolumeAtExit,
    "CANONICAL",
    false,
    false,
    false,
    spec,
  );
  if (variant === "H0_CANONICAL_SCORE0" || !trade.partialApplied) return canonical;

  const plus10 = phase7h3FirstPlus10Event(trade, m5, m5OpenTimes);
  if (plus10 === null) {
    return { ...canonical, phase7h4TemporalFallback: true };
  }

  const h1Target = phase7h3HigherTimeframeTargetAt(
    trade.side, plus10.time, trade.entry, plus10.referencePrice, h1, h1CloseTimes,
  );
  const h4Target = phase7h3HigherTimeframeTargetAt(
    trade.side, plus10.time, trade.entry, plus10.referencePrice, h4, h4CloseTimes,
  );
  const h4Qualified = h4Target !== null && (
    h1Target === null || h4Target.distanceFromPlus10 > h1Target.distanceFromPlus10 + 1e-9
  );

  const h1Hit = phase7h4FirstTargetHitAfterPlus10(trade, plus10, h1Target, m5, m5OpenTimes);
  const h4Hit = h4Qualified
    ? phase7h4FirstTargetHitAfterPlus10(trade, plus10, h4Target, m5, m5OpenTimes)
    : null;

  const remainingAfterPlus10 = normalizeVolume(trade.volume - trade.partialVolume, spec.volumeStep);
  if (!(remainingAfterPlus10 > 0)) return canonical;

  if (variant === "H1_FULL_REMAINDER_AT_H1") {
    if (h1Hit === null) return canonical;
    const pnl = trade.partialPnl + pnlUsd(trade.side, trade.entry, h1Hit.price, remainingAfterPlus10, spec);
    return phase7h4Outcome(
      trade, h1Hit.time, h1Hit.price, pnl, remainingAfterPlus10,
      "H1_FULL_REMAINDER", true, false, false, spec,
    );
  }

  if (variant === "H4_FULL_REMAINDER_AT_H4") {
    if (h4Hit === null) return canonical;
    const pnl = trade.partialPnl + pnlUsd(trade.side, trade.entry, h4Hit.price, remainingAfterPlus10, spec);
    return phase7h4Outcome(
      trade, h4Hit.time, h4Hit.price, pnl, remainingAfterPlus10,
      "H4_FULL_REMAINDER", false, true, false, spec,
    );
  }

  if (h1Hit === null) return canonical;
  const h1Volume = executablePartialVolume(remainingAfterPlus10, 0.5, spec);
  if (!(h1Volume > 0)) return canonical;
  const finalVolume = normalizeVolume(remainingAfterPlus10 - h1Volume, spec.volumeStep);
  if (!(finalVolume > 0)) return canonical;

  const h1Pnl = pnlUsd(trade.side, trade.entry, h1Hit.price, h1Volume, spec);

  if (variant === "H2_HALF_REMAINDER_AT_H1_CANONICAL_FINAL") {
    const finalPnl = pnlUsd(trade.side, trade.entry, trade.exit, finalVolume, spec);
    const total = trade.partialPnl + h1Pnl + finalPnl;
    return phase7h4Outcome(
      trade, trade.exitTime, trade.exit, total, finalVolume,
      "H1_HALF_CANONICAL_FINAL", true, false, false, spec,
    );
  }

  // H3: never assume intrabar ordering when H1 and H4 are touched in the same M5 bar.
  if (variant === "H3_HALF_REMAINDER_AT_H1_H4_FINAL") {
    if (h4Hit !== null && h4Hit.time > h1Hit.time) {
      const h4Pnl = pnlUsd(trade.side, trade.entry, h4Hit.price, finalVolume, spec);
      const total = trade.partialPnl + h1Pnl + h4Pnl;
      return phase7h4Outcome(
        trade, h4Hit.time, h4Hit.price, total, finalVolume,
        "H1_HALF_H4_FINAL", true, true, false, spec,
      );
    }
    const finalPnl = pnlUsd(trade.side, trade.entry, trade.exit, finalVolume, spec);
    const total = trade.partialPnl + h1Pnl + finalPnl;
    return phase7h4Outcome(
      trade, trade.exitTime, trade.exit, total, finalVolume,
      "H1_HALF_CANONICAL_FINAL", true, false, false, spec,
    );
  }

  return canonical;
}

function phase7h4Schedule(rawTrades: Phase7H4Trade[]) {
  const trades: Phase7H4Trade[] = [];
  let busyUntil = -Infinity;
  let skippedWhileOpen = 0;
  for (const trade of rawTrades) {
    if (trade.signalTimestamp < busyUntil) { skippedWhileOpen += 1; continue; }
    trades.push(trade);
    busyUntil = trade.exitTime;
  }
  return { trades, skippedWhileOpen };
}

function phase7h4Metrics(trades: Phase7H4Trade[], skippedWhileOpen: number) {
  const base = summarizePhase7F2(trades, skippedWhileOpen);
  return {
    ...base,
    h1FullRemainderExits: trades.filter((t) => t.phase7h4Overlay === "H1_FULL_REMAINDER").length,
    h1HalfPartialTrades: trades.filter((t) => t.phase7h4H1Taken && t.phase7h4Overlay !== "H1_FULL_REMAINDER").length,
    h4FullRemainderExits: trades.filter((t) => t.phase7h4Overlay === "H4_FULL_REMAINDER").length,
    h4FinalExits: trades.filter((t) => t.phase7h4Overlay === "H1_HALF_H4_FINAL").length,
    temporalFallbacks: trades.filter((t) => t.phase7h4TemporalFallback).length,
  };
}

'@
$functions = $functions.Replace("`r`n", "`n")
$content = $content.Replace($functionMarker, $functions + $functionMarker)

$stateMarker = "  const state = variants[0]!;"
if (-not $content.Contains($stateMarker)) { throw "Phase 7H.4 state marker not found." }

$block = @'
  const phase7h4Accepted = flip2Accepted.filter(
    (signal) => signal.side === "BUY" &&
      (signal.pattern === "ENGULFING" || signal.pattern === "TWO_CANDLE_BODY_DOMINANCE") &&
      phase7h3FvgScore(signal, sortedM15, m15CloseTimes, 12) === 0,
  );

  const phase7h4Definitions: Phase7H4VariantName[] = [
    "H0_CANONICAL_SCORE0",
    "H1_FULL_REMAINDER_AT_H1",
    "H2_HALF_REMAINDER_AT_H1_CANONICAL_FINAL",
    "H3_HALF_REMAINDER_AT_H1_H4_FINAL",
    "H4_FULL_REMAINDER_AT_H4",
  ];

  const phase7h4Variants = phase7h4Definitions.map((name) => {
    if (name === "H0_CANONICAL_SCORE0") {
      const replay = replaySignals(phase7h4Accepted);
      const trades = replay.trades.map((trade) => phase7h4Outcome(
        trade, trade.exitTime, trade.exit, trade.pnl, trade.remainingVolumeAtExit,
        "CANONICAL", false, false, false, spec,
      ));
      return {
        name,
        acceptedSignals: phase7h4Accepted.length,
        metrics: phase7h4Metrics(trades, replay.skippedWhileOpen),
        engulfing: summarizePhase7F2(trades.filter((trade) => trade.pattern === "ENGULFING"), 0),
        twoCandle: summarizePhase7F2(trades.filter((trade) => trade.pattern === "TWO_CANDLE_BODY_DOMINANCE"), 0),
        trades: trades.slice(-500).reverse(),
      };
    }

    const raw = phase7h4Accepted
      .map((signal) => simulateTrade(
        signal, sortedM15, sortedM5, m5OpenTimes, m15CloseTimes, ma20,
        spec, fixedVolume, swingLows, swingHighs,
      ))
      .filter((trade): trade is Trade => trade !== null)
      .map((trade) => phase7h4ApplyOverlay(
        trade, name,
        sortedH1, h1CloseTimes, sortedH4, h4CloseTimes,
        sortedM5, m5OpenTimes, spec,
      ))
      .sort((a, b) => a.signalTimestamp - b.signalTimestamp);

    const scheduled = phase7h4Schedule(raw);
    return {
      name,
      acceptedSignals: phase7h4Accepted.length,
      metrics: phase7h4Metrics(scheduled.trades, scheduled.skippedWhileOpen),
      engulfing: summarizePhase7F2(scheduled.trades.filter((trade) => trade.pattern === "ENGULFING"), 0),
      twoCandle: summarizePhase7F2(scheduled.trades.filter((trade) => trade.pattern === "TWO_CANDLE_BODY_DOMINANCE"), 0),
      trades: scheduled.trades.slice(-500).reverse(),
    };
  });

  const phase7h4Baseline = phase7h4Variants[0]!;
  const phase7h4Ranked = [...phase7h4Variants].sort((a, b) => {
    const aPositive = a.metrics.netPnl > 0 && (a.metrics.profitFactor ?? 0) > 1 && a.metrics.expectancy > 0 && a.metrics.exactNetExLargestWinner > 0;
    const bPositive = b.metrics.netPnl > 0 && (b.metrics.profitFactor ?? 0) > 1 && b.metrics.expectancy > 0 && b.metrics.exactNetExLargestWinner > 0;
    if (aPositive !== bPositive) return bPositive ? 1 : -1;
    if (a.metrics.exactNetExLargestWinner !== b.metrics.exactNetExLargestWinner) return b.metrics.exactNetExLargestWinner - a.metrics.exactNetExLargestWinner;
    if (a.metrics.netPnl !== b.metrics.netPnl) return b.metrics.netPnl - a.metrics.netPnl;
    if ((a.metrics.profitFactor ?? 0) !== (b.metrics.profitFactor ?? 0)) return (b.metrics.profitFactor ?? 0) - (a.metrics.profitFactor ?? 0);
    return a.metrics.maxDrawdownUsd - b.metrics.maxDrawdownUsd;
  });
  const phase7h4Preferred = phase7h4Ranked[0]!;

  const phase7h4BuyScore0HtfManagement = {
    source: "PHASE7H4_BUY_SCORE0_DYNAMIC_HTF_MANAGEMENT_ABLATION",
    sourceVariant: "M5_FLIP_2",
    side: "BUY",
    triggerPatterns: ["ENGULFING", "TWO_CANDLE_BODY_DOMINANCE"],
    entryLane: "BUY_FVG_SCORE0_ONLY",
    fvgInterpretation: "SCORE0_NO_FRESH_DIRECTIONAL_M15_FVG_CONTEXT;OBSERVED_EDGE_NOT_CAUSAL_CLAIM",
    entryRule: "PATTERN_PLUS_M15_SUPERTREND_PLUS_FRESH_ALIGNED_M5_FLIP2;FVG_SCORE0_RESEARCH_SUBLANE",
    managementSemantics: {
      prePlus10: "CANONICAL_FROZEN",
      plus6: "CANONICAL_BREAK_EVEN",
      plus10: "CANONICAL_ONE_THIRD_PARTIAL",
      h1Target: "RECALCULATED_AT_SAFE_PLUS10_EVENT;FIRST_ELIGIBLE_HTF_TARGET_BEYOND_PLUS10",
      h4Target: "RECALCULATED_AT_SAFE_PLUS10_EVENT;EXTENDED_TARGET_ONLY_IF_FARTHER_THAN_H1_WHEN_BOTH_EXIST",
      targetHitStarts: "NEXT_M5_BAR_AFTER_PLUS10_EVENT_CLOSE",
      sameBarH1H4Ordering: "NO_ASSUMPTION;H4_FINAL_REQUIRES_LATER_M5_BAR_THAN_H1",
      canonicalProtectionFallback: true,
      maEntryFilter: false,
      emaEntryFilter: false,
      h1EntryFilter: false,
      h4EntryFilter: false,
    },
    sellLane: {
      status: "SEPARATE_RESEARCH_ONLY_NOT_MANAGEMENT_CANDIDATE",
      reason: "PHASE7H3_SELL_ECONOMICS_NEGATIVE_ACROSS_FVG_SCORE0_1_2",
      executionEligible: false,
    },
    rankingRule: "POSITIVE_ECONOMICS_THEN_EXACT_NET_EX_LARGEST_THEN_NET_THEN_PF_THEN_LOWER_DD",
    preferred: phase7h4Preferred.name,
    baseline: phase7h4Baseline.name,
    variants: phase7h4Variants,
    safety: {
      researchOnly: true,
      productionEntryMutation: false,
      productionManagementMutation: false,
      executionMutation: false,
      phase7bStrategyMutation: false,
      executionEligible: false,
    },
  };

'@
$block = $block.Replace("`r`n", "`n")
$content = $content.Replace($stateMarker, $block + $stateMarker)

$returnMarker = "    phase7h3FvgScoreDynamicTargets,`n    decision: {"
if (-not $content.Contains($returnMarker)) {
  throw "Phase 7H.4 return marker not found. Apply Phase 7H.3 first."
}
$content = $content.Replace(
  $returnMarker,
  "    phase7h3FvgScoreDynamicTargets,`n    phase7h4BuyScore0HtfManagement,`n    decision: {"
)

$required = @(
  'const phase7h4BuyScore0HtfManagement = {',
  'entryLane: "BUY_FVG_SCORE0_ONLY"',
  'sameBarH1H4Ordering: "NO_ASSUMPTION;H4_FINAL_REQUIRES_LATER_M5_BAR_THAN_H1"',
  'status: "SEPARATE_RESEARCH_ONLY_NOT_MANAGEMENT_CANDIDATE"',
  'productionManagementMutation: false',
  'executionEligible: false'
)
foreach ($needle in $required) {
  if (-not $content.Contains($needle)) { throw "Phase 7H.4 validation failed after patch: $needle" }
}

if ($newline -eq "`r`n") { $content = $content.Replace("`n", "`r`n") }
[System.IO.File]::WriteAllText($servicePath, $content, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "PHASE7H4_APPLY=PASS"
Write-Host "PHASE7H4_SERVICE=$servicePath"
Write-Host "PHASE7H4_SIDE=BUY"
Write-Host "PHASE7H4_ENTRY_LANE=BUY_FVG_SCORE0_ONLY"
Write-Host "PHASE7H4_TRIGGER_PATTERNS=ENGULFING,TWO_CANDLE_BODY_DOMINANCE"
Write-Host "PHASE7H4_VARIANTS=H0_CANONICAL_SCORE0,H1_FULL_REMAINDER_AT_H1,H2_HALF_REMAINDER_AT_H1_CANONICAL_FINAL,H3_HALF_REMAINDER_AT_H1_H4_FINAL,H4_FULL_REMAINDER_AT_H4"
Write-Host "PHASE7H4_PRE_PLUS10=CANONICAL_FROZEN"
Write-Host "PHASE7H4_PLUS6=CANONICAL_BE"
Write-Host "PHASE7H4_PLUS10=CANONICAL_ONE_THIRD_PARTIAL"
Write-Host "PHASE7H4_HTF_TARGET_TIME=SAFE_RECONSTRUCTED_PLUS10_ONLY"
Write-Host "PHASE7H4_SELL=SEPARATE_RESEARCH_ONLY"
Write-Host "PHASE7H4_MA_ENTRY_FILTER=False"
Write-Host "PHASE7H4_EMA_ENTRY_FILTER=False"
Write-Host "PHASE7H4_PRODUCTION_ENTRY_MUTATION=False"
Write-Host "PHASE7H4_PRODUCTION_MANAGEMENT_MUTATION=False"
Write-Host "PHASE7H4_EXECUTION_ELIGIBLE=False"
Write-Host "PHASE7H4_NEXT=pnpm --filter @xauusd/api build"
