param()

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$servicePath = Join-Path $repoRoot "apps/api/src/services/phase7e-realignment.service.ts"

if (-not (Test-Path $servicePath)) {
  throw "Phase 7E realignment service not found: $servicePath"
}

$raw = [System.IO.File]::ReadAllText($servicePath)
$newline = if ($raw.Contains("`r`n")) { "`r`n" } else { "`n" }
$content = $raw.Replace("`r`n", "`n")

if ($content.Contains("const phase7fPathDiagnostics = {")) {
  Write-Host "PHASE7F1_APPLY=ALREADY_APPLIED"
  Write-Host "PHASE7F1_SERVICE=$servicePath"
  exit 0
}

if (-not $content.Contains("const flip2Ablation = {")) {
  throw "Phase 7E.2 ablation payload is missing. Apply Phase 7E.2 before Phase 7F.1."
}

$functionMarker = "function rankScore(metrics: Metrics, baselineDd: number) {"
if (-not $content.Contains($functionMarker)) {
  throw "Phase 7F.1 function marker not found. Stop to avoid patching the wrong engine revision."
}

$phase7fFunctions = @'
function phase7fPercentile(values: number[], percentile: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

function buildPhase7FPathDiagnostics(trades: Trade[], m5: Bar[], m5OpenTimes: number[], spec: Spec) {
  const cashPerPriceUnit = cashPerPrice(spec);
  const rows = trades.map((trade) => {
    let mfePrice = 0;
    let maePrice = 0;
    const startIndex = lowerBound(m5OpenTimes, trade.entryTime);

    for (let index = startIndex; index < m5.length; index += 1) {
      const bar = m5[index]!;
      if (bar.openTime > trade.exitTime) break;
      const isStopExitBar = trade.exitReason === "STOP" && bar.closeTime >= trade.exitTime;

      if (isStopExitBar) {
        const adverseAtExit = trade.side === "BUY"
          ? trade.entry - trade.exit
          : trade.exit - trade.entry;
        maePrice = Math.max(maePrice, Math.max(0, adverseAtExit));
        break;
      }

      if (bar.closeTime <= trade.exitTime) {
        const favorable = trade.side === "BUY"
          ? bar.high - trade.entry
          : trade.entry - (bar.low + bar.spread);
        const adverse = trade.side === "BUY"
          ? trade.entry - bar.low
          : bar.high + bar.spread - trade.entry;
        mfePrice = Math.max(mfePrice, Math.max(0, favorable));
        maePrice = Math.max(maePrice, Math.max(0, adverse));
      }

      if (bar.closeTime >= trade.exitTime) break;
    }

    const realizedEquivalentPrice = cashPerPriceUnit > 0 && trade.volume > 0
      ? trade.pnl / (cashPerPriceUnit * trade.volume)
      : 0;
    const captureRatioPercent = mfePrice > 1e-9
      ? realizedEquivalentPrice / mfePrice * 100
      : null;
    const givebackFromMfePrice = mfePrice > 1e-9
      ? mfePrice - realizedEquivalentPrice
      : 0;

    return {
      signalTimestamp: trade.signalTimestamp,
      entryTime: trade.entryTime,
      exitTime: trade.exitTime,
      side: trade.side,
      pattern: trade.pattern,
      pnl: trade.pnl,
      exitReason: trade.exitReason,
      mfePrice: round(mfePrice, 4),
      maePrice: round(maePrice, 4),
      realizedEquivalentPrice: round(realizedEquivalentPrice, 4),
      captureRatioPercent: captureRatioPercent === null ? null : round(captureRatioPercent, 2),
      givebackFromMfePrice: round(givebackFromMfePrice, 4),
      hitPlus6: trade.breakEvenApplied,
      hitPlus8: mfePrice >= 8 - 1e-9,
      hitPlus10: trade.partialApplied,
      hitPlus12: mfePrice >= 12 - 1e-9,
      hitPlus15: mfePrice >= 15 - 1e-9,
      hitPlus20: mfePrice >= 20 - 1e-9,
      nonPositiveAfterPlus6: trade.breakEvenApplied && trade.pnl <= 0,
    };
  });

  const mfeValues = rows.map((row) => row.mfePrice);
  const maeValues = rows.map((row) => row.maePrice);
  const captureValues = rows
    .map((row) => row.captureRatioPercent)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const winnerCaptureValues = rows
    .filter((row) => row.pnl > 0)
    .map((row) => row.captureRatioPercent)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const givebackValues = rows.map((row) => row.givebackFromMfePrice);
  const grossProfit = trades.reduce((sum, trade) => sum + Math.max(0, trade.pnl), 0);
  const grossLoss = Math.abs(trades.reduce((sum, trade) => sum + Math.min(0, trade.pnl), 0));
  const netPnl = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  const winnersDescending = trades.map((trade) => Math.max(0, trade.pnl)).sort((a, b) => b - a);
  const largestWinnerPnl = winnersDescending[0] ?? 0;
  const top3WinnerPnl = winnersDescending.slice(0, 3).reduce((sum, value) => sum + value, 0);
  const hitPlus6 = rows.filter((row) => row.hitPlus6).length;
  const hitPlus8 = rows.filter((row) => row.hitPlus8).length;
  const hitPlus10 = rows.filter((row) => row.hitPlus10).length;
  const hitPlus12 = rows.filter((row) => row.hitPlus12).length;
  const hitPlus15 = rows.filter((row) => row.hitPlus15).length;
  const hitPlus20 = rows.filter((row) => row.hitPlus20).length;

  return {
    metrics: {
      trades: trades.length,
      netPnl: round(netPnl, 2),
      grossProfit: round(grossProfit, 2),
      grossLoss: round(grossLoss, 2),
      profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : grossProfit > 0 ? null : 0,
      expectancy: round(trades.length ? netPnl / trades.length : 0, 4),
      averageMfePrice: round(avg(mfeValues), 4),
      medianMfePrice: round(phase7fPercentile(mfeValues, 0.5), 4),
      p90MfePrice: round(phase7fPercentile(mfeValues, 0.9), 4),
      averageMaePrice: round(avg(maeValues), 4),
      medianMaePrice: round(phase7fPercentile(maeValues, 0.5), 4),
      p90MaePrice: round(phase7fPercentile(maeValues, 0.9), 4),
      hitPlus6,
      hitPlus8,
      hitPlus10,
      hitPlus12,
      hitPlus15,
      hitPlus20,
      plus6ToPlus8ConversionPercent: round(hitPlus6 ? hitPlus8 / hitPlus6 * 100 : 0, 2),
      plus8ToPlus10ConversionPercent: round(hitPlus8 ? hitPlus10 / hitPlus8 * 100 : 0, 2),
      plus10ToPlus15ConversionPercent: round(hitPlus10 ? hitPlus15 / hitPlus10 * 100 : 0, 2),
      nonPositiveAfterPlus6: rows.filter((row) => row.nonPositiveAfterPlus6).length,
      averageCaptureRatioPercent: round(avg(captureValues), 2),
      averageWinnerCaptureRatioPercent: round(avg(winnerCaptureValues), 2),
      averageGivebackFromMfePrice: round(avg(givebackValues), 4),
      medianGivebackFromMfePrice: round(phase7fPercentile(givebackValues, 0.5), 4),
      largestWinnerPnl: round(largestWinnerPnl, 2),
      largestWinnerShareOfGrossProfitPercent: round(grossProfit > 0 ? largestWinnerPnl / grossProfit * 100 : 0, 2),
      exactNetExLargestWinner: round(netPnl - largestWinnerPnl, 2),
      top3WinnerPnl: round(top3WinnerPnl, 2),
      top3WinnerShareOfGrossProfitPercent: round(grossProfit > 0 ? top3WinnerPnl / grossProfit * 100 : 0, 2),
      exactNetExTop3Winners: round(netPnl - top3WinnerPnl, 2),
    },
    trades: rows,
  };
}

'@
$phase7fFunctions = $phase7fFunctions.Replace("`r`n", "`n")
$content = $content.Replace($functionMarker, $phase7fFunctions + $functionMarker)

$stateMarker = "  const state = variants[0]!;"
if (-not $content.Contains($stateMarker)) {
  throw "Phase 7F.1 state marker not found."
}

$phase7fBlock = @'
  const phase7fBuyEngulfingAccepted = flip2Accepted.filter(
    (signal) => signal.side === "BUY" && signal.pattern === "ENGULFING",
  );
  const phase7fBuyEngulfingReplay = replaySignals(phase7fBuyEngulfingAccepted);
  const phase7fPath = buildPhase7FPathDiagnostics(
    phase7fBuyEngulfingReplay.trades,
    sortedM5,
    m5OpenTimes,
    spec,
  );
  const phase7fPathDiagnostics = {
    source: "PHASE7F1_BUY_ENGULFING_PATH_DIAGNOSTICS",
    sourceVariant: "M5_FLIP_2",
    cell: "BUY_ENGULFING",
    contentionMode: "FILTER_SIGNALS_BEFORE_SIMULATION_AND_RESCHEDULE_PER_CELL",
    pathSemantics: "M5_CLOSED_BAR_RECONSTRUCTION_WITH_STOP_FIRST_ON_STOP_EXIT_BAR",
    thresholdSources: {
      plus6: "CANONICAL_BREAK_EVEN_APPLIED",
      plus8: "RECONSTRUCTED_M5_MFE_PRICE",
      plus10: "CANONICAL_PARTIAL_APPLIED",
      plus12: "RECONSTRUCTED_M5_MFE_PRICE",
      plus15: "RECONSTRUCTED_M5_MFE_PRICE",
      plus20: "RECONSTRUCTED_M5_MFE_PRICE",
    },
    safety: {
      researchOnly: true,
      entryMutation: false,
      managementMutation: false,
      executionMutation: false,
      phase7bStrategyMutation: false,
      executionEligible: false,
    },
    metrics: phase7fPath.metrics,
    trades: phase7fPath.trades.slice(-500).reverse(),
  };

'@
$phase7fBlock = $phase7fBlock.Replace("`r`n", "`n")
$content = $content.Replace($stateMarker, $phase7fBlock + $stateMarker)

$returnMarker = "    flip2Ablation,`n    decision: {"
if (-not $content.Contains($returnMarker)) {
  throw "Phase 7F.1 return marker not found. Phase 7E.2 may not be applied to the local service."
}
$content = $content.Replace(
  $returnMarker,
  "    flip2Ablation,`n    phase7fPathDiagnostics,`n    decision: {"
)

if ($newline -eq "`r`n") {
  $content = $content.Replace("`n", "`r`n")
}

[System.IO.File]::WriteAllText($servicePath, $content, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "PHASE7F1_APPLY=PASS"
Write-Host "PHASE7F1_SERVICE=$servicePath"
Write-Host "PHASE7F1_CELL=BUY_ENGULFING"
Write-Host "PHASE7F1_SOURCE_VARIANT=M5_FLIP_2"
Write-Host "PHASE7F1_PATH_SEMANTICS=M5_CLOSED_BAR_RECONSTRUCTION_STOP_FIRST"
Write-Host "PHASE7F1_ENTRY_MUTATION=False"
Write-Host "PHASE7F1_MANAGEMENT_MUTATION=False"
Write-Host "PHASE7F1_EXECUTION_ELIGIBLE=False"
Write-Host "PHASE7F1_NEXT=pnpm --filter @xauusd/api build"
