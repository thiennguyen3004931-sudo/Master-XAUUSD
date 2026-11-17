export const TREND_STRATEGY_CONDITION_IDS = Object.freeze([
  "patternM15",
  "supertrendM15",
  "supertrendM5",
  "validTrendStructure",
  "ma20Ma50",
  "fvg",
]);

export const SIDEWAY_STRATEGY_CONDITION_IDS = Object.freeze([
  "rangingRegime",
  "recommendedModeSideway",
  "minimumRegimeConfidence",
  "supplyDemandRange",
  "rangeEdge",
  "m5Confirmation",
]);

export const STRATEGY_ENTRY_MANDATORY = Object.freeze({
  TREND: Object.freeze(["patternM15"]),
  SIDEWAY: Object.freeze(["rangeEdge"]),
});

const ROOT_KEYS = Object.freeze([
  "version",
  "updatedAt",
  "updatedBy",
  "trend",
  "sideway",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function invalid(error) {
  return {
    valid: false,
    reasonCode: "ENTRY_STRATEGY_CONFIG_INVALID",
    error,
  };
}

function validateConditionSet(value, ids, mandatoryIds, label) {
  if (!hasExactKeys(value, ids)) {
    return invalid(`${label} condition keys must match the canonical whitelist exactly.`);
  }

  for (const id of ids) {
    if (typeof value[id] !== "boolean") {
      return invalid(`${label}.${id} must be boolean.`);
    }
  }

  if (!ids.some((id) => value[id] === true)) {
    return invalid(`${label} must keep at least one strategy condition enabled.`);
  }

  for (const id of mandatoryIds) {
    if (value[id] !== true) {
      return invalid(`${label}.${id} is a mandatory directional anchor and must remain enabled.`);
    }
  }

  return { valid: true };
}

export function createVirtualStrategyEntryConditionState() {
  return {
    version: 0,
    updatedAt: new Date(0).toISOString(),
    updatedBy: "safe-default",
    trend: {
      patternM15: true,
      supertrendM15: true,
      supertrendM5: true,
      validTrendStructure: true,
      ma20Ma50: false,
      fvg: false,
    },
    sideway: {
      rangingRegime: true,
      recommendedModeSideway: true,
      minimumRegimeConfidence: true,
      supplyDemandRange: true,
      rangeEdge: true,
      m5Confirmation: true,
    },
  };
}

export function validateStrategyEntryConditionState(
  value,
  { allowVirtualVersionZero = false } = {},
) {
  if (!hasExactKeys(value, ROOT_KEYS)) {
    return invalid("Strategy entry condition state keys must match the canonical schema exactly.");
  }

  if (!Number.isInteger(value.version) || value.version < 0) {
    return invalid("Strategy entry condition version must be a non-negative integer.");
  }
  if (value.version === 0 && allowVirtualVersionZero !== true) {
    return invalid("Persisted strategy entry condition version must be greater than zero.");
  }
  if (typeof value.updatedAt !== "string" || value.updatedAt.trim() === "") {
    return invalid("updatedAt must be a non-empty string.");
  }
  if (typeof value.updatedBy !== "string" || value.updatedBy.trim() === "") {
    return invalid("updatedBy must be a non-empty string.");
  }

  const trendValidation = validateConditionSet(
    value.trend,
    TREND_STRATEGY_CONDITION_IDS,
    STRATEGY_ENTRY_MANDATORY.TREND,
    "trend",
  );
  if (!trendValidation.valid) return trendValidation;

  const sidewayValidation = validateConditionSet(
    value.sideway,
    SIDEWAY_STRATEGY_CONDITION_IDS,
    STRATEGY_ENTRY_MANDATORY.SIDEWAY,
    "sideway",
  );
  if (!sidewayValidation.valid) return sidewayValidation;

  return {
    valid: true,
    state: {
      version: value.version,
      updatedAt: value.updatedAt,
      updatedBy: value.updatedBy,
      trend: Object.fromEntries(
        TREND_STRATEGY_CONDITION_IDS.map((id) => [id, value.trend[id]]),
      ),
      sideway: Object.fromEntries(
        SIDEWAY_STRATEGY_CONDITION_IDS.map((id) => [id, value.sideway[id]]),
      ),
    },
  };
}

export function evaluateStrategyEntryConditions({
  strategy,
  config,
  side,
  observations,
}) {
  if (strategy !== "TREND" && strategy !== "SIDEWAY") {
    throw new Error(`Unsupported Phase 7C strategy: ${strategy}`);
  }
  if (side !== "BUY" && side !== "SELL") {
    throw new Error(`Unsupported Phase 7C entry side: ${side}`);
  }

  const validation = validateStrategyEntryConditionState(config, {
    allowVirtualVersionZero: true,
  });
  if (!validation.valid) {
    const error = new Error(validation.error);
    error.code = validation.reasonCode;
    throw error;
  }

  const state = validation.state;
  const ids = strategy === "TREND"
    ? TREND_STRATEGY_CONDITION_IDS
    : SIDEWAY_STRATEGY_CONDITION_IDS;
  const conditionConfig = strategy === "TREND" ? state.trend : state.sideway;
  const mandatoryIds = new Set(STRATEGY_ENTRY_MANDATORY[strategy]);
  const anchorCondition = STRATEGY_ENTRY_MANDATORY[strategy][0];

  const conditions = ids.map((id) => {
    const mandatory = mandatoryIds.has(id);
    const enabled = mandatory || conditionConfig[id] === true;
    const observation = isRecord(observations?.[id]) ? observations[id] : null;
    const observed = observation && Object.prototype.hasOwnProperty.call(observation, "observed")
      ? observation.observed
      : null;
    const passed = observation?.passed === true;

    return {
      id,
      enabled,
      mandatory,
      status: enabled ? (passed ? "PASS" : "FAIL") : "IGNORED",
      observed,
    };
  });

  const enabledConditions = conditions.filter((row) => row.enabled);
  const failedConditions = enabledConditions
    .filter((row) => row.status === "FAIL")
    .map((row) => row.id);

  return {
    configVersion: state.version,
    side,
    anchorCondition,
    enabledCount: enabledConditions.length,
    allEnabledPassed: failedConditions.length === 0,
    failedConditions,
    conditions,
  };
}

export function compareStrategyEntryConfigVersion(cycleSnapshot, currentSnapshot) {
  const snapshots = [cycleSnapshot, currentSnapshot];
  if (
    snapshots.some((snapshot) =>
      !isRecord(snapshot) ||
      snapshot.valid !== true ||
      !Number.isInteger(snapshot.version) ||
      snapshot.version < 0
    )
  ) {
    return {
      ok: false,
      reasonCode: "ENTRY_STRATEGY_CONFIG_INVALID",
    };
  }

  if (cycleSnapshot.version !== currentSnapshot.version) {
    return {
      ok: false,
      reasonCode: "ENTRY_CONFIG_VERSION_CHANGED",
    };
  }

  return { ok: true };
}
