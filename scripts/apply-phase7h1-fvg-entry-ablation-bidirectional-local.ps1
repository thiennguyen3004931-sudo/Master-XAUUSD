param()

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$servicePath = Join-Path $repoRoot "apps/api/src/services/phase7e-realignment.service.ts"

if (-not (Test-Path $servicePath)) { throw "Phase 7E service not found: $servicePath" }

$raw = [System.IO.File]::ReadAllText($servicePath)
$newline = if ($raw.Contains("`r`n")) { "`r`n" } else { "`n" }
$content = $raw.Replace("`r`n", "`n")

if ($content.Contains("const phase7h1FvgAblation = {")) {
  Write-Host "PHASE7H1_APPLY=ALREADY_APPLIED"
  Write-Host "PHASE7H1_SERVICE=$servicePath"
  exit 0
}

if (-not $content.Contains("const phase7g2EmaHoldAblation = {")) {
  throw "Phase 7G.2 bidirectional EMA hold payload missing. Apply Phase 7G.2 first."
}
if (-not $content.Contains("const phase7f2ManagementAblation = {")) {
  throw "Phase 7F.2 management payload missing."
}
if (-not $content.Contains("const flip2Ablation = {")) {
  throw "Phase 7E.2 ablation payload missing."
}
if ($content.Contains("const phase7g1MaRegimeAblation = {")) {
  throw "Phase 7G.1 MA entry-filter patch is applied locally. Restore the EMA-only/no-MA-entry service before Phase 7H.1."
}

$functionMarker = "function phase7fPercentile(values: number[], percentile: number) {"
if (-not $content.Contains($functionMarker)) {
  throw "Phase 7F.1 function marker not found."
}

$functions = @'
type Phase7H1FvgName =
  | "F0_BASELINE"
  | "F1_FRESH_DIRECTIONAL_FVG_CONTEXT"
  | "F2_FRESH_DIRECTIONAL_FVG_TOUCH";

type Phase7H1FvgZone = {
  formedIndex: number;
  zoneLow: number;
  zoneHigh: number;
};

function phase7h1FreshDirectionalFvg(
  signal: Signal,
  m15: Bar[],
  m15CloseTimes: number[],
  lookback: number,
): Phase7H1FvgZone | null {
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

    let fullyFilledBeforeSignal = false;
    for (let cursor = index + 1; cursor < signalIndex; cursor += 1) {
      const bar = m15[cursor]!;
      if (signal.side === "BUY" && bar.low <= zoneLow + 1e-9) {
        fullyFilledBeforeSignal = true;
        break;
      }
      if (signal.side === "SELL" && bar.high >= zoneHigh - 1e-9) {
        fullyFilledBeforeSignal = true;
        break;
      }
    }
    if (!fullyFilledBeforeSignal) return { formedIndex: index, zoneLow, zoneHigh };
  }

  return null;
}

function phase7h1SignalTouchesZone(
  signal: Signal,
  m15: Bar[],
  m15CloseTimes: number[],
  zone: Phase7H1FvgZone,
) {
  const signalIndex = upperBound(m15CloseTimes, signal.signalTimestamp) - 1;
  const bar = m15[signalIndex];
  if (!bar) return false;
  return bar.low <= zone.zoneHigh + 1e-9 && bar.high >= zone.zoneLow - 1e-9;
}

'@
$functions = $functions.Replace("`r`n", "`n")
$content = $content.Replace($functionMarker, $functions + $functionMarker)

$stateMarker = "  const state = variants[0]!;"
if (-not $content.Contains($stateMarker)) { throw "Phase 7H.1 state marker not found." }

$block = @'
  const phase7h1FvgLookback = 12;
  const phase7h1Definitions: Array<{ name: Phase7H1FvgName; level: number; rule: string }> = [
    { name: "F0_BASELINE", level: 0, rule: "NO_FVG_ENTRY_FILTER" },
    { name: "F1_FRESH_DIRECTIONAL_FVG_CONTEXT", level: 1, rule: "LATEST_SAME_SIDE_M15_FVG_WITHIN_12_BARS_NOT_FULLY_FILLED_BEFORE_SIGNAL" },
    { name: "F2_FRESH_DIRECTIONAL_FVG_TOUCH", level: 2, rule: "F1_PLUS_SIGNAL_CANDLE_OVERLAPS_LATEST_FRESH_DIRECTIONAL_FVG" },
  ];

  const phase7h1BuildSide = (side: Side) => {
    const baselineAccepted = flip2Accepted.filter(
      (signal) => signal.side === side && signal.pattern === "ENGULFING",
    );

    const variants = phase7h1Definitions.map((definition) => {
      const accepted = definition.level === 0
        ? baselineAccepted
        : baselineAccepted.filter((signal) => {
          const zone = phase7h1FreshDirectionalFvg(signal, sortedM15, m15CloseTimes, phase7h1FvgLookback);
          if (zone === null) return false;
          if (definition.level === 1) return true;
          return phase7h1SignalTouchesZone(signal, sortedM15, m15CloseTimes, zone);
        });

      const replay = replaySignals(accepted);
      const metrics = summarizePhase7F2(replay.trades, replay.skippedWhileOpen);
      const path = buildPhase7FPathDiagnostics(replay.trades, sortedM5, m5OpenTimes, spec);
      return {
        ...definition,
        acceptedSignals: accepted.length,
        signalRetentionPercent: round(
          baselineAccepted.length ? accepted.length / baselineAccepted.length * 100 : 0,
          2,
        ),
        metrics: {
          ...metrics,
          hitPlus6: path.metrics.hitPlus6,
          hitPlus10: path.metrics.hitPlus10,
          averageWinnerCaptureRatioPercent: path.metrics.averageWinnerCaptureRatioPercent,
          averageGivebackFromMfePrice: path.metrics.averageGivebackFromMfePrice,
        },
        trades: replay.trades.slice(-500).reverse(),
      };
    });

    const effectivePf = (variant: typeof variants[number]) =>
      variant.metrics.profitFactor === null
        ? (variant.metrics.netPnl > 0 ? 999 : 0)
        : variant.metrics.profitFactor;

    const rankedPool = variants.filter((variant) =>
      variant.metrics.trades >= 20 &&
      variant.metrics.netPnl > 0 &&
      effectivePf(variant) > 1 &&
      variant.metrics.expectancy > 0,
    );
    const preferred = [...(rankedPool.length ? rankedPool : variants)].sort((a, b) =>
      Number(b.metrics.exactNetExLargestWinner > 0) - Number(a.metrics.exactNetExLargestWinner > 0) ||
      b.metrics.exactNetExLargestWinner - a.metrics.exactNetExLargestWinner ||
      b.metrics.netPnl - a.metrics.netPnl ||
      a.metrics.maxDrawdownUsd - b.metrics.maxDrawdownUsd,
    )[0]!;

    return {
      side,
      baselineSignals: baselineAccepted.length,
      variants,
      decision: {
        baselineFilter: "F0_BASELINE",
        preferredResearchFilter: preferred.name,
        preferredExactNetExLargestPositive: preferred.metrics.exactNetExLargestWinner > 0,
        rankingRule: "SIDE_SEPARATE_SAMPLE_POSITIVE_ECONOMICS_THEN_POSITIVE_EXACT_NET_EX_LARGEST_THEN_EX_LARGEST_THEN_NET_THEN_DD",
        executionEligible: false,
      },
    };
  };

  const phase7h1FvgAblation = {
    source: "PHASE7H1_BIDIRECTIONAL_FVG_ENTRY_ABLATION",
    sourceVariant: "M5_FLIP_2",
    pattern: "ENGULFING",
    management: "M0_CANONICAL_FROZEN",
    fvgTimeframe: "M15",
    fvgLookbackBars: phase7h1FvgLookback,
    contentionMode: "FILTER_SIGNALS_BEFORE_SIMULATION_AND_RESCHEDULE_INDEPENDENTLY_PER_SIDE_AND_FVG_VARIANT",
    filters: {
      maEntryFilter: false,
      emaEntryFilter: false,
      fvgEntryResearchLayer: true,
    },
    safety: {
      researchOnly: true,
      productionEntryMutation: false,
      productionManagementMutation: false,
      executionMutation: false,
      phase7bStrategyMutation: false,
      executionEligible: false,
    },
    buy: phase7h1BuildSide("BUY"),
    sell: phase7h1BuildSide("SELL"),
  };

'@
$block = $block.Replace("`r`n", "`n")
$content = $content.Replace($stateMarker, $block + $stateMarker)

$returnMarker = "    phase7g2EmaHoldAblation,`n    decision: {"
if (-not $content.Contains($returnMarker)) {
  throw "Phase 7H.1 return marker not found. Phase 7G.2 may not be applied locally."
}
$content = $content.Replace(
  $returnMarker,
  "    phase7g2EmaHoldAblation,`n    phase7h1FvgAblation,`n    decision: {"
)

if ($newline -eq "`r`n") { $content = $content.Replace("`n", "`r`n") }
[System.IO.File]::WriteAllText($servicePath, $content, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "PHASE7H1_APPLY=PASS"
Write-Host "PHASE7H1_SERVICE=$servicePath"
Write-Host "PHASE7H1_SIDES=BUY,SELL"
Write-Host "PHASE7H1_SOURCE_VARIANT=M5_FLIP_2"
Write-Host "PHASE7H1_PATTERN=ENGULFING"
Write-Host "PHASE7H1_MANAGEMENT=M0_CANONICAL_FROZEN"
Write-Host "PHASE7H1_FVG_TIMEFRAME=M15"
Write-Host "PHASE7H1_FVG_LOOKBACK=12"
Write-Host "PHASE7H1_VARIANTS=F0_BASELINE,F1_FRESH_DIRECTIONAL_FVG_CONTEXT,F2_FRESH_DIRECTIONAL_FVG_TOUCH"
Write-Host "PHASE7H1_MA_ENTRY_FILTER=False"
Write-Host "PHASE7H1_EMA_ENTRY_FILTER=False"
Write-Host "PHASE7H1_PRODUCTION_ENTRY_MUTATION=False"
Write-Host "PHASE7H1_PRODUCTION_MANAGEMENT_MUTATION=False"
Write-Host "PHASE7H1_EXECUTION_ELIGIBLE=False"
Write-Host "PHASE7H1_NEXT=pnpm --filter @xauusd/api build"
