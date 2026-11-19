function asObject(value) {
  return value && typeof value === "object" ? value : null;
}

function bridgeFailureMetadata(error) {
  const object = asObject(error);
  if (object) {
    const status = Number(object.bridgeStatus);
    const method = String(object.bridgeMethod ?? "").toUpperCase();
    const endpoint = String(object.bridgeEndpoint ?? "");
    const payload = asObject(object.bridgePayload);
    if (Number.isFinite(status) && method && endpoint && payload) {
      return { status, method, endpoint, payload };
    }
  }

  const message = error instanceof Error ? error.message : String(error ?? "");
  const match = /^MT5 bridge\s+([A-Z]+)\s+(\S+)\s+failed\s+(\d+):\s+([\s\S]+)$/.exec(message);
  if (!match) return null;

  let payload;
  try {
    payload = JSON.parse(match[4]);
  } catch {
    return null;
  }

  const parsedPayload = asObject(payload);
  if (!parsedPayload) return null;

  return {
    status: Number(match[3]),
    method: String(match[1]).toUpperCase(),
    endpoint: String(match[2]),
    payload: parsedPayload,
  };
}

export function classifyPhase7CTrendEntryBlock(error) {
  const failure = bridgeFailureMetadata(error);
  if (!failure) return null;

  if (
    failure.status !== 423 ||
    failure.method !== "POST" ||
    failure.endpoint !== "/v1/orders"
  ) {
    return null;
  }

  const payload = failure.payload;
  if (
    payload.error !== "PHASE7C_TREND_ENTRY_BLOCKED" ||
    payload.status !== "blocked_by_phase7c_mode_gate" ||
    payload.accepted !== false
  ) {
    return null;
  }

  return {
    status: "blocked_by_phase7c_mode_gate",
    bridgeError: "PHASE7C_TREND_ENTRY_BLOCKED",
    reasonCode: String(payload.message ?? payload.error),
    reason: String(
      payload.detail ??
      payload.message ??
      "Phase 7C mode gate blocked the Trend entry.",
    ),
    activeMode: payload.activeMode == null ? null : String(payload.activeMode),
    recommendedMode: payload.recommendedMode == null
      ? null
      : String(payload.recommendedMode),
  };
}
