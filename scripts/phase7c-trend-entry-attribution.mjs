function finite(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, 1_000) : null;
}

function parseOrderBody(requestBody) {
  if (typeof requestBody !== "string" || !requestBody.trim()) return {};
  try {
    const parsed = JSON.parse(requestBody);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

export function buildTrendEntryAttribution({ decision, requestBody }) {
  const order = parseOrderBody(requestBody);
  return {
    timestamp: new Date().toISOString(),
    activeMode: cleanText(decision?.activeMode),
    recommendedMode: cleanText(decision?.recommendedMode),
    regime: cleanText(decision?.regime),
    regimeConfidence: finite(decision?.regimeConfidence),
    reason: cleanText(decision?.reason),
    permissionReason: cleanText(decision?.reason),
    permissionDetail: cleanText(decision?.detail),
    regimeSnapshotSource: "FINAL_TREND_ORDER_GATE",
    clientOrderId: cleanText(order?.clientOrderId),
    idempotencyKey: cleanText(order?.idempotencyKey),
    side: cleanText(order?.side),
    volume: finite(order?.volume),
    stopLoss: finite(order?.stopLoss),
    takeProfit: finite(order?.takeProfit),
    finalPermission: {
      activeMode: cleanText(decision?.activeMode),
      recommendedMode: cleanText(decision?.recommendedMode),
      regime: cleanText(decision?.regime),
      regimeConfidence: finite(decision?.regimeConfidence),
      reason: cleanText(decision?.reason),
      detail: cleanText(decision?.detail),
    },
  };
}

export function recordTrendEntryAttributionBestEffort({
  audit,
  decision,
  requestBody,
  warn = (message) => console.warn(message),
}) {
  const payload = buildTrendEntryAttribution({ decision, requestBody });
  try {
    const record = audit.record("ENTRY_FINAL_PERMISSION_GRANTED", payload);
    return { recorded: true, record };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(`TREND_ENTRY_ATTRIBUTION_AUDIT_FAILED=${message}`);
    return { recorded: false, error: message };
  }
}
