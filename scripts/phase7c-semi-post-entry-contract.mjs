const CONTRACT = Object.freeze({
  entryPolicy: "MANUAL_ONLY",
  initialStopDistance: 6,
  fixedTakeProfitPolicy: "TREND_RUNTIME_CONFIG",
  plus6Action: "SL_TO_ENTRY_ONLY",
  plus6PartialClose: "NONE",
  plus10Action: "PARTIAL_ONE_THIRD",
  managementStrategy: "TREND",
  fixedTakeProfitInherited: true,
  fastMoveInherited: true,
  structuralTrailingInherited: true,
  reversalExitInherited: true,
  runnerTrendExitInherited: true,
  holdReasonInherited: true,
});

function fail(message) {
  throw new Error(`[PHASE7C_SEMI_POST_ENTRY_CONTRACT] ${message}`);
}

function requireSource(name, source) {
  if (typeof source !== "string" || source.length === 0) {
    fail(`${name} source is required`);
  }
}

function requireIncludes(source, needle, label) {
  if (!source.includes(needle)) {
    fail(`${label} missing: ${needle}`);
  }
}

function requireOrdered(source, needles, label) {
  let previousIndex = -1;
  const indexes = [];
  for (const needle of needles) {
    const index = source.indexOf(needle);
    if (index < 0 || index <= previousIndex) {
      fail(`${label} order mismatch at: ${needle}`);
    }
    indexes.push(index);
    previousIndex = index;
  }
  return indexes;
}

function assertTrendManagementMarkers(source, prefix) {
  const required = [
    ["if (!managed.breakEvenApplied && favorable >= 6)", `${prefix} +6 milestone`],
    ["if (!managed.partialApplied && favorable >= 10)", `${prefix} +10 milestone`],
    ["const raw = initial / 3;", `${prefix} one-third sizing`],
    ["closeFixedTpIfTriggered(position, quote)", `${prefix} fixed TP management`],
    ["fastMoveProfitLockCandidate({", `${prefix} FastMove`],
    ["latestConfirmedStructureStop(", `${prefix} structural trailing`],
    ["STRUCTURAL_SL_TIGHTEN", `${prefix} structural SL journal`],
    ["opposingFvgRejectionAt(", `${prefix} reversal detector`],
    ["REVERSAL_FVG_REJECTION", `${prefix} reversal exit`],
    ["RUNNER_TREND_MA50", `${prefix} runner Trend exit`],
    ["canonicalHoldReason(", `${prefix} canonical hold`],
  ];

  for (const [needle, label] of required) {
    requireIncludes(source, needle, label);
  }
}

export function assertPhase7CSemiPostEntryContract({
  legacyTrendSource,
  transformedTrendSource,
  semiAdoptionRuntimeSource,
  trendWrapperSource,
}) {
  requireSource("legacyTrendSource", legacyTrendSource);
  requireSource("transformedTrendSource", transformedTrendSource);
  requireSource("semiAdoptionRuntimeSource", semiAdoptionRuntimeSource);
  requireSource("trendWrapperSource", trendWrapperSource);

  // Boundary 1: SEMI can never create a system entry. The production wrapper
  // blocks the existing Trend order POST while still loading the Trend runtime.
  requireIncludes(trendWrapperSource, 'decision.activeMode === "SEMI"', "SEMI mode branch");
  requireIncludes(
    trendWrapperSource,
    'reason: "SEMI_MANUAL_ENTRY_ONLY"',
    "SEMI manual-entry-only boundary",
  );
  requireOrdered(
    trendWrapperSource,
    [
      "source = transformPhase7CSemiTrendRuntimeSource(source);",
      "ts.transpileModule(source, {",
    ],
    "SEMI source adapter before Trend transpile",
  );

  // Boundary 2: the source adapter owns the handoff. Once adoption returns a
  // protected manual position, it persists the managed state and calls the
  // exact legacy managePosition(position, quote, spec, m15) path.
  requireOrdered(
    transformedTrendSource,
    [
      "const semiAdoption = await reconcilePhase7CSemiManualPosition({",
      "state.managed = semiAdoption.managed;",
      "await managePosition(semiAdoption.position, quote, spec, m15);",
    ],
    "SEMI adoption to canonical Trend management handoff",
  );
  requireIncludes(
    transformedTrendSource,
    'journal("SEMI_MANUAL_POSITION_ADOPTED"',
    "SEMI adoption journal",
  );

  // Boundary 3: adoption establishes the SEMI-only protection envelope. SL=6
  // is fixed by SEMI; TP is inherited from the canonical Trend runtime config
  // rather than duplicated as a second SEMI default.
  requireIncludes(
    semiAdoptionRuntimeSource,
    "const INITIAL_STOP_DISTANCE = 6;",
    "SEMI initial stop distance",
  );
  requireIncludes(
    semiAdoptionRuntimeSource,
    'managementStrategy: "TREND"',
    "SEMI management strategy",
  );
  requireIncludes(
    semiAdoptionRuntimeSource,
    "initialStopDistance: INITIAL_STOP_DISTANCE",
    "SEMI durable stop wiring",
  );
  requireIncludes(
    semiAdoptionRuntimeSource,
    "fixedTakeProfit: fixedTakeProfit(",
    "SEMI fixed TP calculation",
  );
  requireIncludes(
    semiAdoptionRuntimeSource,
    "trendFixedTpEnabled,",
    "SEMI Trend fixed-TP enabled input",
  );
  requireIncludes(
    semiAdoptionRuntimeSource,
    "trendFixedTpDistance,",
    "SEMI Trend fixed-TP distance input",
  );
  requireIncludes(
    semiAdoptionRuntimeSource,
    'if (protection?.status !== "PROTECTED")',
    "SEMI broker protection fail-closed gate",
  );
  requireIncludes(
    semiAdoptionRuntimeSource,
    'return blocked(protection?.reason ?? "PROTECTION_BLOCKED")',
    "SEMI broker protection blocked result",
  );
  requireIncludes(
    semiAdoptionRuntimeSource,
    "const fixedTpDistance = adoption.fixedTakeProfit.enabled",
    "SEMI managed fixed-TP inheritance",
  );
  requireIncludes(
    semiAdoptionRuntimeSource,
    "? Number(input.trendFixedTpDistance)",
    "SEMI managed Trend fixed-TP distance",
  );
  requireIncludes(
    semiAdoptionRuntimeSource,
    "fixedTpEnabled: adoption.fixedTakeProfit.enabled",
    "SEMI managed fixed-TP enabled state",
  );
  requireIncludes(
    semiAdoptionRuntimeSource,
    "fixedTpPrice: adoption.fixedTakeProfit.targetPrice",
    "SEMI managed fixed-TP target state",
  );
  requireIncludes(semiAdoptionRuntimeSource, 'dailyMode: "TREND"', "SEMI managed Trend mode");
  requireIncludes(semiAdoptionRuntimeSource, 'status: "ADOPTED"', "SEMI protected adoption status");

  // Boundary 4: prove the canonical Trend engine itself still has the intended
  // +6/+10 behavior. Everything below is then inherited by the transformed
  // SEMI runtime because Boundary 2 hands the position into managePosition().
  const plus6Marker = "if (!managed.breakEvenApplied && favorable >= 6)";
  const plus10Marker = "if (!managed.partialApplied && favorable >= 10)";
  const [plus6Index, plus10Index] = requireOrdered(
    legacyTrendSource,
    [plus6Marker, plus10Marker],
    "Trend +6/+10 milestones",
  );

  const plus6Segment = legacyTrendSource.slice(plus6Index, plus10Index);
  requireIncludes(
    plus6Segment,
    "const beStop = roundPrice(position.entry, spec.digits);",
    "Trend +6 BE stop",
  );
  requireIncludes(plus6Segment, "PLUS6_SL_TO_ENTRY", "Trend +6 BE journal");
  if (plus6Segment.includes("partialVolume(")) {
    fail("Trend +6 must not perform partial close");
  }

  const plus10Segment = legacyTrendSource.slice(plus10Index);
  requireIncludes(
    plus10Segment,
    "const closeVolume = partialVolume(managed.initialVolume, position.volume, spec);",
    "Trend +10 partial close",
  );
  requireIncludes(plus10Segment, "PLUS10_PARTIAL_ONE_THIRD", "Trend +10 partial journal");
  requireIncludes(legacyTrendSource, "const raw = initial / 3;", "Trend one-third sizing");

  assertTrendManagementMarkers(legacyTrendSource, "Trend template");
  assertTrendManagementMarkers(transformedTrendSource, "Transformed Trend runtime");

  return {
    ok: true,
    contract: { ...CONTRACT },
  };
}
