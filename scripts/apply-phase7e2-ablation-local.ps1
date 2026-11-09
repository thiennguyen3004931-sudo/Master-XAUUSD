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

if ($content.Contains("const flip2Ablation = {")) {
  Write-Host "PHASE7E2_APPLY=ALREADY_APPLIED"
  Write-Host "PHASE7E2_SERVICE=$servicePath"
  exit 0
}

$oldVariants = @'
  const variants = variantDefinitions.map((definition) => {
    const accepted = definition.maxFlipAge === null
      ? dualSignals
      : dualSignals.filter((signal) => signal.m5FlipAgeBars !== null && signal.m5FlipAgeBars <= definition.maxFlipAge!);
    const raw = accepted
      .map((signal) => simulateTrade(signal, sortedM15, sortedM5, m5OpenTimes, m15CloseTimes, ma20, spec, fixedVolume, swingLows, swingHighs))
      .filter((trade): trade is Trade => trade !== null)
      .sort((a, b) => a.signalTimestamp - b.signalTimestamp);
    const scheduled = schedule(raw);
    const metrics = summarize(scheduled.trades, scheduled.skippedWhileOpen);
    return {
      name: definition.name,
      maxFlipAgeBars: definition.maxFlipAge,
      acceptedSignals: accepted.length,
      metrics,
      buy: summarize(scheduled.trades.filter((trade) => trade.side === "BUY"), 0),
      sell: summarize(scheduled.trades.filter((trade) => trade.side === "SELL"), 0),
      engulfing: summarize(scheduled.trades.filter((trade) => trade.pattern === "ENGULFING"), 0),
      twoCandle: summarize(scheduled.trades.filter((trade) => trade.pattern === "TWO_CANDLE_BODY_DOMINANCE"), 0),
      trades: scheduled.trades.slice(-500).reverse(),
    };
  });
'@

$newVariants = @'
  const replaySignals = (accepted: Signal[]) => {
    const raw = accepted
      .map((signal) => simulateTrade(signal, sortedM15, sortedM5, m5OpenTimes, m15CloseTimes, ma20, spec, fixedVolume, swingLows, swingHighs))
      .filter((trade): trade is Trade => trade !== null)
      .sort((a, b) => a.signalTimestamp - b.signalTimestamp);
    const scheduled = schedule(raw);
    return {
      acceptedSignals: accepted.length,
      trades: scheduled.trades,
      skippedWhileOpen: scheduled.skippedWhileOpen,
      metrics: summarize(scheduled.trades, scheduled.skippedWhileOpen),
    };
  };

  const summarizeAblation = (trades: Trade[], skippedWhileOpen: number) => {
    const metrics = summarize(trades, skippedWhileOpen);
    const grossProfit = trades.reduce((sum, trade) => sum + Math.max(0, trade.pnl), 0);
    const largestWinner = trades.reduce((value, trade) => Math.max(value, trade.pnl), 0);
    const hitPlus6 = trades.filter((trade) => trade.breakEvenApplied).length;
    const hitPlus10 = trades.filter((trade) => trade.partialApplied).length;
    return {
      ...metrics,
      averageNetPerTrade: metrics.expectancy,
      hitPlus6,
      hitPlus8: null,
      hitPlus10,
      stopBeforePlus6: trades.filter((trade) => trade.exitReason === "STOP" && !trade.breakEvenApplied).length,
      averageMfePrice: null,
      averageMaePrice: null,
      pathDiagnosticsAvailable: false,
      largestWinnerShareOfGrossProfitPercent: round(grossProfit > 0 ? largestWinner / grossProfit * 100 : 0, 2),
    };
  };

  const variants = variantDefinitions.map((definition) => {
    const accepted = definition.maxFlipAge === null
      ? dualSignals
      : dualSignals.filter((signal) => signal.m5FlipAgeBars !== null && signal.m5FlipAgeBars <= definition.maxFlipAge!);
    const replay = replaySignals(accepted);
    return {
      name: definition.name,
      maxFlipAgeBars: definition.maxFlipAge,
      acceptedSignals: accepted.length,
      metrics: replay.metrics,
      buy: summarize(replay.trades.filter((trade) => trade.side === "BUY"), 0),
      sell: summarize(replay.trades.filter((trade) => trade.side === "SELL"), 0),
      engulfing: summarize(replay.trades.filter((trade) => trade.pattern === "ENGULFING"), 0),
      twoCandle: summarize(replay.trades.filter((trade) => trade.pattern === "TWO_CANDLE_BODY_DOMINANCE"), 0),
      trades: replay.trades.slice(-500).reverse(),
    };
  });

  const flip2Accepted = dualSignals.filter((signal) => signal.m5FlipAgeBars !== null && signal.m5FlipAgeBars <= 1);
  const flip2BaselineReplay = replaySignals(flip2Accepted);
  const flip2BaselineMetrics = summarizeAblation(flip2BaselineReplay.trades, flip2BaselineReplay.skippedWhileOpen);
  const ablationDefinitions: Array<{ name: string; side: Side; pattern: Pattern }> = [
    { name: "BUY_ENGULFING", side: "BUY", pattern: "ENGULFING" },
    { name: "BUY_TWO_CANDLE", side: "BUY", pattern: "TWO_CANDLE_BODY_DOMINANCE" },
    { name: "SELL_ENGULFING", side: "SELL", pattern: "ENGULFING" },
    { name: "SELL_TWO_CANDLE", side: "SELL", pattern: "TWO_CANDLE_BODY_DOMINANCE" },
  ];
  const ablationCells = ablationDefinitions.map((definition) => {
    const accepted = flip2Accepted.filter((signal) => signal.side === definition.side && signal.pattern === definition.pattern);
    const replay = replaySignals(accepted);
    return {
      name: definition.name,
      side: definition.side,
      pattern: definition.pattern,
      acceptedSignals: accepted.length,
      metrics: summarizeAblation(replay.trades, replay.skippedWhileOpen),
    };
  });
  const effectivePf = (metrics: ReturnType<typeof summarizeAblation>) =>
    metrics.profitFactor === null ? (metrics.netPnl > 0 ? 3 : 0) : metrics.profitFactor;
  const ablationRankScore = (metrics: ReturnType<typeof summarizeAblation>) =>
    metrics.netPnl + metrics.expectancy * 20 + Math.min(effectivePf(metrics), 3) * 10 - metrics.maxDrawdownUsd * 0.25 + Math.min(metrics.trades, 100) * 0.1;
  const ablationBest = [...ablationCells].sort((a, b) => ablationRankScore(b.metrics) - ablationRankScore(a.metrics))[0]!;
  const ablationEconomicsGate =
    ablationBest.metrics.trades >= 20 &&
    ablationBest.metrics.netPnl > 0 &&
    effectivePf(ablationBest.metrics) > 1.1 &&
    ablationBest.metrics.expectancy > flip2BaselineMetrics.expectancy &&
    ablationBest.metrics.maxDrawdownUsd <= flip2BaselineMetrics.maxDrawdownUsd + 1e-9;
  const ablationSampleSufficientForPromotion = ablationBest.metrics.trades >= 100;
  const flip2Ablation = {
    sourceVariant: "M5_FLIP_2",
    contentionMode: "FILTER_SIGNALS_BEFORE_SIMULATION_AND_RESCHEDULE_PER_CELL",
    baseline: {
      name: "ALL_DIRECTION_ALL_PATTERN",
      acceptedSignals: flip2Accepted.length,
      metrics: flip2BaselineMetrics,
    },
    cells: ablationCells,
    decision: {
      preferredResearchCell: ablationBest.name,
      economicsGate: ablationEconomicsGate,
      sampleSufficientForPromotion: ablationSampleSufficientForPromotion,
      promotionEligible: ablationEconomicsGate && ablationSampleSufficientForPromotion,
      executionEligible: false,
    },
    diagnostics: {
      pathMetricsAvailable: false,
      hitPlus6Source: "BREAK_EVEN_APPLIED_AT_PLUS6",
      hitPlus8Source: "UNAVAILABLE_CURRENT_TRADE_SCHEMA",
      hitPlus10Source: "PARTIAL_APPLIED_AT_PLUS10",
      mfeMaeStatus: "DEFERRED_TO_PHASE7F_PATH_INSTRUMENTATION",
    },
  };
'@

$oldVariants = $oldVariants.Replace("`r`n", "`n")
$newVariants = $newVariants.Replace("`r`n", "`n")

if (-not $content.Contains($oldVariants)) {
  throw "Phase 7E variant block did not match expected HEAD. Stop to avoid patching the wrong engine revision."
}

$content = $content.Replace($oldVariants, $newVariants)

$oldReturn = @'
    variants,
    decision: {
'@
$newReturn = @'
    variants,
    flip2Ablation,
    decision: {
'@
$oldReturn = $oldReturn.Replace("`r`n", "`n")
$newReturn = $newReturn.Replace("`r`n", "`n")

if (-not $content.Contains($oldReturn)) {
  throw "Phase 7E return block did not match expected HEAD."
}
$content = $content.Replace($oldReturn, $newReturn)

if ($newline -eq "`r`n") {
  $content = $content.Replace("`n", "`r`n")
}

[System.IO.File]::WriteAllText($servicePath, $content, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "PHASE7E2_APPLY=PASS"
Write-Host "PHASE7E2_SERVICE=$servicePath"
Write-Host "PHASE7E2_MODE=FILTER_SIGNALS_BEFORE_SIMULATION_AND_RESCHEDULE_PER_CELL"
Write-Host "PHASE7E2_EXECUTION_ELIGIBLE=False"
Write-Host "PHASE7E2_NEXT=pnpm --filter @xauusd/api build"
