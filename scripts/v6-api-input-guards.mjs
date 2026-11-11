/** Pure validation helpers: no MT5 or network calls and no implicit coercion. */
export function parseRequiredTicket(value) {
  const validNumber = typeof value === "number" &&
    Number.isSafeInteger(value) && value > 0;
  const validString = typeof value === "string" &&
    /^[1-9][0-9]*$/.test(value) &&
    Number.isSafeInteger(Number(value));
  if (!validNumber && !validString) {
    throw new TypeError("EXPLICIT_POSITIVE_TICKET_REQUIRED");
  }
  return Number(value);
}

export function parseOptionalBoolean(value, field = "flag") {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new TypeError("BOOLEAN_REQUIRED:" + field);
  }
  return value;
}


/** Reject implicit coercion, hidden account/symbol overrides and unsafe risk caps. */
export function parseReadOnlyLotQuoteRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => !["side", "slPrice", "riskPercent"].includes(key))) {
    throw new TypeError("INVALID_READ_ONLY_RISK_REQUEST");
  }
  const { side, slPrice, riskPercent } = body;
  if (!["BUY", "SELL"].includes(side) ||
      typeof slPrice !== "number" || !Number.isFinite(slPrice) || slPrice <= 0 ||
      typeof riskPercent !== "number" || !Number.isFinite(riskPercent) ||
      riskPercent <= 0 || riskPercent > 0.5) {
    throw new TypeError("INVALID_READ_ONLY_RISK_REQUEST");
  }
  return { side, slPrice, riskPercent };
}
