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
