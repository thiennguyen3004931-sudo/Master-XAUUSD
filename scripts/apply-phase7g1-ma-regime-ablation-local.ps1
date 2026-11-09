param()

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$servicePath = Join-Path $repoRoot "apps/api/src/services/phase7e-realignment.service.ts"

if (-not (Test-Path $servicePath)) { throw "Phase 7E service not found: $servicePath" }

$raw = [System.IO.File]::ReadAllText($servicePath)
$newline = if ($raw.Contains("`r`n")) { "`r`n" } else { "`n" }
$content = $raw.Replace("`r`n", "`n")

if ($content.Contains("const phase7g1MaRegimeAblation = {")) {
  Write-Host "PHASE7G1_APPLY=ALREADY_APPLIED"
  Write-Host "PHASE7G1_SERVICE=$servicePath"
  exit 0
}

if (-not $content.Contains("const phase7f2ManagementAblation = {")) {
  throw "Phase 7F.2 management ablation missing. Apply Phase 7F.2 first."
}
if (-not $content.Contains("const flip2Ablation = {")) {
  throw "Phase 7E.2 ablation missing."
}

$ma20Marker = '  const ma20 = rollingSma(sortedM15.map((b) => b.close), 20);'
if (-not $content.Contains($ma20Marker)) { throw "MA20 marker not found." }
if (-not $content.Contains('const ma50 = rollingSma')) {
  $content = $content.Replace(
    $ma20Marker,
    $ma20Marker + "`n  const ma50 = rollingSma(sortedM15.map((b) => b.close), 50);`n  const ma200 = rollingSma(sortedM15.map((b) => b.close), 200);"
  )
}

$stateMarker = "  const state = variants[0]!;"
if (-not $content.Contains($stateMarker)) { throw "State marker not found." }

$block = @'
  const phase7g1BaselineAccepted = flip2Accepted.filter(
    (signal) => signal.side === "BUY" && signal.pattern === "ENGULFING",
  );
  const phase7g1Pass = (signal: Signal, level: number) => {
    const index = upperBound(m15CloseTimes, signal.signalTimestamp) - 1;
    if (index < 0) return false;
    const price = sortedM15[index]!.close;
    const a20 = ma20[index];
    const a50 = ma50[index];
    const a200 = ma200[index];
    if (level >= 1 && !(a20 !== null && price > a20)) return false;
    if (level >= 2 && !(a50 !== null && a20 !== null && a20 > a50)) return false;
    if (level >= 3 && !(a200 !== null && a50 !== null && a50 > a200)) return false;
    return true;
  };
  const phase7g1Definitions = [
    { name: "G0_BASELINE", level: 0, rule: "NO_MA_ENTRY_FILTER" },
    { name: "G1_PRICE_GT_MA20", level: 1, rule: "CLOSE_GT_MA20" },
    { name: "G2_PRICE_GT_MA20_GT_MA50", level: 2, rule: "CLOSE_GT_MA20_GT_MA50" },
    { name: "G3_PRICE_GT_MA20_GT_MA50_GT_MA200", level: 3, rule: "CLOSE_GT_MA20_GT_MA50_GT_MA200" },
  ];
  const phase7g1Variants = phase7g1Definitions.map((definition) => {
    const accepted = definition.level === 0
      ? phase7g1BaselineAccepted
      : phase7g1BaselineAccepted.filter((signal) => phase7g1Pass(signal, definition.level));
    const replay = replaySignals(accepted);
    return {
      ...definition,
      acceptedSignals: accepted.length,
      signalRetentionPercent: round(
        phase7g1BaselineAccepted.length ? accepted.length / phase7g1BaselineAccepted.length * 100 : 0,
        2,
      ),
      metrics: summarizePhase7F2(replay.trades, replay.skippedWhileOpen),
      trades: replay.trades.slice(-500).reverse(),
    };
  });
  const phase7g1Baseline = phase7g1Variants[0]!;
  const phase7g1EffectivePf = (variant: typeof phase7g1Variants[number]) =>
    variant.metrics.profitFactor === null
      ? (variant.metrics.netPnl > 0 ? 999 : 0)
      : variant.metrics.profitFactor;
  const phase7g1Eligible = phase7g1Variants.filter((variant) =>
    variant.metrics.trades >= 30 &&
    variant.metrics.netPnl > 0 &&
    phase7g1EffectivePf(variant) >= 1.2 &&
    variant.metrics.expectancy > 0 &&
    variant.metrics.maxDrawdownUsd <= phase7g1Baseline.metrics.maxDrawdownUsd + 0.01,
  );
  const phase7g1Preferred = [...phase7g1Eligible].sort((a, b) =>
    Number(b.metrics.exactNetExLargestWinner > 0) - Number(a.metrics.exactNetExLargestWinner > 0) ||
    b.metrics.exactNetExLargestWinner - a.metrics.exactNetExLargestWinner ||
    b.metrics.netPnl - a.metrics.netPnl ||
    a.metrics.maxDrawdownUsd - b.metrics.maxDrawdownUsd,
  )[0] ?? phase7g1Baseline;

  const phase7g1MaRegimeAblation = {
    source: "PHASE7G1_BUY_ENGULFING_MA_REGIME_ABLATION",
    sourceVariant: "M5_FLIP_2",
    cell: "BUY_ENGULFING",
    management: "M0_CANONICAL_FROZEN",
    contentionMode: "FILTER_SIGNALS_BEFORE_SIMULATION_AND_RESCHEDULE_INDEPENDENTLY_PER_MA_REGIME",
    filtersNested: true,
    safety: {
      researchOnly: true,
      productionEntryMutation: false,
      productionManagementMutation: false,
      executionMutation: false,
      phase7bStrategyMutation: false,
      executionEligible: false,
    },
    variants: phase7g1Variants,
    decision: {
      baselineFilter: phase7g1Baseline.name,
      preferredResearchFilter: phase7g1Preferred.name,
      preferredExactNetExLargestPositive: phase7g1Preferred.metrics.exactNetExLargestWinner > 0,
      executionEligible: false,
      rankingRule: "ECONOMICS_SAMPLE_DD_GATE_THEN_POSITIVE_EXACT_NET_EX_LARGEST_THEN_EX_LARGEST_THEN_NET_THEN_DD",
    },
  };

'@
$block = $block.Replace("`r`n", "`n")
$content = $content.Replace($stateMarker, $block + $stateMarker)

$returnMarker = "    phase7f2ManagementAblation,`n    decision: {"
if (-not $content.Contains($returnMarker)) {
  throw "Return marker not found. Phase 7F.2 may not be applied locally."
}
$content = $content.Replace(
  $returnMarker,
  "    phase7f2ManagementAblation,`n    phase7g1MaRegimeAblation,`n    decision: {"
)

if ($newline -eq "`r`n") { $content = $content.Replace("`n", "`r`n") }
[System.IO.File]::WriteAllText($servicePath, $content, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "PHASE7G1_APPLY=PASS"
Write-Host "PHASE7G1_SERVICE=$servicePath"
Write-Host "PHASE7G1_CELL=BUY_ENGULFING"
Write-Host "PHASE7G1_SOURCE_VARIANT=M5_FLIP_2"
Write-Host "PHASE7G1_MANAGEMENT=M0_CANONICAL_FROZEN"
Write-Host "PHASE7G1_FILTERS=G0_BASELINE,G1_PRICE_GT_MA20,G2_PRICE_GT_MA20_GT_MA50,G3_PRICE_GT_MA20_GT_MA50_GT_MA200"
Write-Host "PHASE7G1_CONTENTION=FILTER_BEFORE_SIMULATION_AND_RESCHEDULE_PER_FILTER"
Write-Host "PHASE7G1_PRODUCTION_ENTRY_MUTATION=False"
Write-Host "PHASE7G1_PRODUCTION_MANAGEMENT_MUTATION=False"
Write-Host "PHASE7G1_EXECUTION_ELIGIBLE=False"
Write-Host "PHASE7G1_NEXT=pnpm --filter @xauusd/api build"
