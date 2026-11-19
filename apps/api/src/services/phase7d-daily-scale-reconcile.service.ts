import {
  runPhase7DDailyPnlResearch,
  type Phase7DDailyPnlRequest,
} from "./phase7d-daily-pnl.service";
import {
  runPhase7DManagementResearch,
  type Phase7DManagementRequest,
} from "./phase7d-management.service";
import {
  runPhase7DDailyScaleResearch,
  type Phase7DDailyScaleRequest,
} from "./phase7d-daily-scale.service";

type Check = {
  key: string;
  pass: boolean;
  expected: number | string | null;
  actual: number | string | null;
  delta: number | null;
  tolerance: number | null;
};

type ComparableTrade = {
  entryTime: number;
  exitTime: number;
  pnl: number;
  exitReason?: string;
  blocked?: boolean;
};

type TradeDiff = {
  entryTime: number;
  expectedExitTime: number | null;
  actualExitTime: number | null;
  exitTimeDeltaMs: number | null;
  expectedPnl: number | null;
  actualPnl: number | null;
  pnlDelta: number | null;
  expectedReason: string | null;
  actualReason: string | null;
  reasonMatch: boolean;
  missingSide: "EXPECTED" | "ACTUAL" | null;
};

function numericCheck(key: string, expected: number, actual: number, tolerance: number): Check {
  const delta = actual - expected;
  return {
    key,
    pass: Math.abs(delta) <= tolerance + 1e-9,
    expected,
    actual,
    delta: Math.round(delta * 10_000) / 10_000,
    tolerance,
  };
}

function exactCheck(key: string, expected: number | string, actual: number | string): Check {
  return { key, pass: expected === actual, expected, actual, delta: null, tolerance: null };
}

function nullableNumberCheck(
  key: string,
  expected: number | null,
  actual: number | null,
  tolerance: number,
): Check {
  if (expected === null || actual === null) {
    return { key, pass: expected === actual, expected, actual, delta: null, tolerance };
  }
  return numericCheck(key, expected, actual, tolerance);
}

function normalizeReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value
    .replace(/^CANONICAL_/, "")
    .replace("RECOVERY_CANONICAL_TIME_FALLBACK", "RECOVERY_FALLBACK");
}

function toComparable(value: unknown): ComparableTrade | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.blocked === true) return null;
  const entryTime = Number(row.entryTime);
  const exitTime = Number(row.exitTime);
  const pnl = Number(row.pnl);
  if (!Number.isFinite(entryTime) || !Number.isFinite(exitTime) || !Number.isFinite(pnl)) return null;
  return {
    entryTime,
    exitTime,
    pnl,
    exitReason: typeof row.exitReason === "string" ? row.exitReason : undefined,
  };
}

function compareTradePaths(expectedRows: unknown[], actualRows: unknown[]): {
  expectedTrades: number;
  actualTrades: number;
  mismatchCount: number;
  missingExpectedCount: number;
  missingActualCount: number;
  pnlMismatchCount: number;
  exitTimeMismatchCount: number;
  reasonMismatchCount: number;
  totalPnlDelta: number;
  topMismatches: TradeDiff[];
} {
  const expected = expectedRows.map(toComparable).filter((item): item is ComparableTrade => item !== null);
  const actual = actualRows.map(toComparable).filter((item): item is ComparableTrade => item !== null);
  const expectedByEntry = new Map(expected.map((item) => [item.entryTime, item]));
  const actualByEntry = new Map(actual.map((item) => [item.entryTime, item]));
  const entries = [...new Set([...expectedByEntry.keys(), ...actualByEntry.keys()])].sort((a, b) => a - b);
  const diffs: TradeDiff[] = [];
  let missingExpectedCount = 0;
  let missingActualCount = 0;
  let pnlMismatchCount = 0;
  let exitTimeMismatchCount = 0;
  let reasonMismatchCount = 0;
  let totalPnlDelta = 0;

  for (const entryTime of entries) {
    const left = expectedByEntry.get(entryTime);
    const right = actualByEntry.get(entryTime);
    if (!left || !right) {
      if (!left) missingExpectedCount += 1;
      if (!right) missingActualCount += 1;
      diffs.push({
        entryTime,
        expectedExitTime: left?.exitTime ?? null,
        actualExitTime: right?.exitTime ?? null,
        exitTimeDeltaMs: left && right ? right.exitTime - left.exitTime : null,
        expectedPnl: left?.pnl ?? null,
        actualPnl: right?.pnl ?? null,
        pnlDelta: left && right ? round4(right.pnl - left.pnl) : null,
        expectedReason: normalizeReason(left?.exitReason),
        actualReason: normalizeReason(right?.exitReason),
        reasonMatch: false,
        missingSide: !left ? "EXPECTED" : "ACTUAL",
      });
      continue;
    }

    const pnlDelta = right.pnl - left.pnl;
    totalPnlDelta += pnlDelta;
    const exitTimeDeltaMs = right.exitTime - left.exitTime;
    const expectedReason = normalizeReason(left.exitReason);
    const actualReason = normalizeReason(right.exitReason);
    const reasonMatch = expectedReason === actualReason;
    const pnlMismatch = Math.abs(pnlDelta) > 0.011;
    const exitMismatch = exitTimeDeltaMs !== 0;
    const reasonMismatch = !reasonMatch;
    if (pnlMismatch) pnlMismatchCount += 1;
    if (exitMismatch) exitTimeMismatchCount += 1;
    if (reasonMismatch) reasonMismatchCount += 1;
    if (!pnlMismatch && !exitMismatch && !reasonMismatch) continue;

    diffs.push({
      entryTime,
      expectedExitTime: left.exitTime,
      actualExitTime: right.exitTime,
      exitTimeDeltaMs,
      expectedPnl: left.pnl,
      actualPnl: right.pnl,
      pnlDelta: round4(pnlDelta),
      expectedReason,
      actualReason,
      reasonMatch,
      missingSide: null,
    });
  }

  diffs.sort((left, right) => {
    const pnlGap = Math.abs(right.pnlDelta ?? 0) - Math.abs(left.pnlDelta ?? 0);
    if (Math.abs(pnlGap) > 1e-9) return pnlGap;
    return Math.abs(right.exitTimeDeltaMs ?? 0) - Math.abs(left.exitTimeDeltaMs ?? 0);
  });

  return {
    expectedTrades: expected.length,
    actualTrades: actual.length,
    mismatchCount: diffs.length,
    missingExpectedCount,
    missingActualCount,
    pnlMismatchCount,
    exitTimeMismatchCount,
    reasonMismatchCount,
    totalPnlDelta: round4(totalPnlDelta),
    topMismatches: diffs.slice(0, 25),
  };
}

function round4(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

export async function runPhase7DReconciledDailyScaleResearch(input: Phase7DDailyScaleRequest) {
  const managementInput: Phase7DManagementRequest = {
    from: input.from,
    to: input.to,
    fixedVolume: input.fixedVolume,
  };
  const dailyInput: Phase7DDailyPnlRequest = { ...input };

  const [management, daily, scale] = await Promise.all([
    runPhase7DManagementResearch(managementInput),
    runPhase7DDailyPnlResearch(dailyInput),
    runPhase7DDailyScaleResearch(input),
  ]);

  const managementCurrent = management.variants.find((item) => item.name === "CURRENT_BE6_PARTIAL_THIRD");
  if (!managementCurrent) throw new Error("Management CURRENT lane is missing.");

  // Blocking gate: Daily P/L is the canonical source for Daily Scale because both
  // lanes share the exact daily-state/Recovery/Positive-Lock semantics being researched.
  // Management remains a diagnostic cross-check and must not block Scale when its
  // isolated optimizer intentionally has a known implementation discrepancy.
  const checks: Check[] = [
    exactCheck("SIGNALS_DAILY_VS_SCALE", daily.configuration.signals, scale.configuration.signals),
    exactCheck("CURRENT_TRADES_DAILY_VS_SCALE", daily.baseline.metrics.trades, scale.current.metrics.trades),
    numericCheck("CURRENT_NET_DAILY_VS_SCALE", daily.baseline.metrics.netPnl, scale.current.metrics.netPnl, 0.05),
    nullableNumberCheck("CURRENT_PF_DAILY_VS_SCALE", daily.baseline.metrics.profitFactor, scale.current.metrics.profitFactor, 0.0005),
    numericCheck("CURRENT_DD_DAILY_VS_SCALE", daily.baseline.metrics.maxDrawdownUsd, scale.current.metrics.maxDrawdownUsd, 0.05),

    exactCheck("RECOVERY_LOCK_TRADES_DAILY_VS_SCALE", daily.recoveryPlusLock.metrics.trades, scale.recoveryLockCurrent.metrics.trades),
    exactCheck("RECOVERY_LOCK_BLOCKS_DAILY_VS_SCALE", daily.recoveryPlusLock.metrics.blockedTrades, scale.recoveryLockCurrent.metrics.blockedTrades),
    numericCheck("RECOVERY_LOCK_NET_DAILY_VS_SCALE", daily.recoveryPlusLock.metrics.netPnl, scale.recoveryLockCurrent.metrics.netPnl, 0.05),
    nullableNumberCheck("RECOVERY_LOCK_PF_DAILY_VS_SCALE", daily.recoveryPlusLock.metrics.profitFactor, scale.recoveryLockCurrent.metrics.profitFactor, 0.0005),
    numericCheck("RECOVERY_LOCK_DD_DAILY_VS_SCALE", daily.recoveryPlusLock.metrics.maxDrawdownUsd, scale.recoveryLockCurrent.metrics.maxDrawdownUsd, 0.05),
    numericCheck("RECOVERY_LOCK_POSITIVE_DAY_RATE_DAILY_VS_SCALE", daily.recoveryPlusLock.metrics.positiveDayRatePercent, scale.recoveryLockCurrent.metrics.positiveDayRatePercent, 0.01),
  ];

  const diagnosticChecks: Check[] = [
    exactCheck("SIGNALS_MANAGEMENT_VS_DAILY", management.signals, daily.configuration.signals),
    exactCheck("CURRENT_TRADES_MANAGEMENT_VS_DAILY", managementCurrent.metrics.trades, daily.baseline.metrics.trades),
    numericCheck("CURRENT_NET_MANAGEMENT_VS_DAILY", managementCurrent.metrics.netPnl, daily.baseline.metrics.netPnl, 0.05),
    nullableNumberCheck("CURRENT_PF_MANAGEMENT_VS_DAILY", managementCurrent.metrics.profitFactor, daily.baseline.metrics.profitFactor, 0.0005),
    numericCheck("CURRENT_DD_MANAGEMENT_VS_DAILY", managementCurrent.metrics.maxDrawdownUsd, daily.baseline.metrics.maxDrawdownUsd, 0.05),
  ];

  const tradeDiffs = {
    dailyVsScaleCurrent: compareTradePaths(daily.baseline.outcomes as unknown[], scale.current.outcomes as unknown[]),
    dailyVsScaleRecoveryLock: compareTradePaths(daily.recoveryPlusLock.outcomes as unknown[], scale.recoveryLockCurrent.outcomes as unknown[]),
    managementVsDailyCurrent: compareTradePaths(managementCurrent.trades as unknown[], daily.baseline.outcomes as unknown[]),
  };

  const passed = checks.every((check) => check.pass);
  const failedKeys = checks.filter((check) => !check.pass).map((check) => check.key);
  const diagnosticPassed = diagnosticChecks.every((check) => check.pass);
  const diagnosticFailedKeys = diagnosticChecks.filter((check) => !check.pass).map((check) => check.key);

  const reconciliation = {
    status: passed ? "PASS" as const : "FAIL" as const,
    passed,
    decisionAllowed: passed,
    canonicalReference: "PHASE7D_DAILY_PNL_BASELINE_AND_RECOVERY_LOCK",
    checks,
    failedKeys,
    diagnostic: {
      status: diagnosticPassed ? "PASS" as const : "WARN" as const,
      passed: diagnosticPassed,
      failedKeys: diagnosticFailedKeys,
      checks: diagnosticChecks,
      note: diagnosticPassed
        ? "Management optimizer agrees with the Daily canonical CURRENT lane."
        : "Management optimizer has a non-blocking CURRENT discrepancy. Daily Scale remains gated only by Daily canonical equivalence; see tradeDiffs.managementVsDailyCurrent for exact trades.",
    },
    tradeDiffs,
    references: {
      managementCurrent: managementCurrent.metrics,
      dailyBaseline: daily.baseline.metrics,
      dailyRecoveryPlusLock: daily.recoveryPlusLock.metrics,
      scaleCurrent: scale.current.metrics,
      scaleRecoveryLockCurrent: scale.recoveryLockCurrent.metrics,
    },
    note: passed
      ? "Daily Scale CURRENT and Recovery+Lock baselines exactly reconcile to the Daily P/L canonical engine for this range. Scale-lane comparison may be evaluated."
      : "Daily Scale does not reconcile to the Daily P/L canonical engine on this range. BE6/BE10 scale verdict remains locked until every blocking check passes.",
  };

  return {
    ...scale,
    reconciliation,
    decision: passed
      ? scale.decision
      : {
          ...scale.decision,
          verdict: "RECONCILIATION_FAILED" as const,
          preferredResearchLane: "NONE",
          executionEligible: false as const,
          reason: `Daily canonical reconciliation failed: ${failedKeys.join(", ")}. Do not compare or promote BE6/BE10 scale lanes yet.`,
        },
  };
}
