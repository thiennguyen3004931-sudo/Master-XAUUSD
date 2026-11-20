/**
 * Read-only sanitization of live MT5 probe evidence for V6 status endpoints.
 * Never substitute demo numbers, cached account values or synthetic quotes.
 * Quote freshness is based on the Python broker tick validation, not Date.now().
 */
const finiteNumber = (value, minimum = -Infinity) =>
  typeof value === "number" && Number.isFinite(value) && value >= minimum ? value : null;

const nonemptyString = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

export function getV6BrokerStatusEvidence(probe) {
  const connected = probe?.connected === true;
  const empty = {
    connected: false,
    dataStatus: "BROKER_UNAVAILABLE",
    accountDataStatus: "UNVERIFIED",
    quoteDataStatus: "UNVERIFIED",
    accountLogin: null,
    accountName: null,
    accountMode: null,
    accountBalance: null,
    accountEquity: null,
    accountFreeMargin: null,
    accountProfit: null,
    accountCurrency: null,
    server: null,
    brokerSymbol: null,
    availableGoldSymbols: [],
    quote: null,
    brokerObservedAtMs: null,
  };
  if (!connected) return empty;

  const balance = finiteNumber(probe.balance, 0);
  const equity = finiteNumber(probe.equity, 0);
  const freeMargin = finiteNumber(probe.freeMargin); // Broker can report <=0; never invent margin.
  const profit = finiteNumber(probe.profit);
  const accountLogin = Number.isSafeInteger(probe.accountLogin) && probe.accountLogin > 0
    ? probe.accountLogin : null;
  const brokerSymbol = nonemptyString(probe.brokerSymbol);
  const quoteAgeSeconds = finiteNumber(probe.quoteAgeSeconds);
  const bid = finiteNumber(probe.bid, Number.EPSILON);
  const ask = finiteNumber(probe.ask, Number.EPSILON);
  const spreadPoints = finiteNumber(probe.spreadPoints, 0);
  const quoteValid = probe.quoteFresh === true &&
    quoteAgeSeconds !== null && quoteAgeSeconds >= -10 && quoteAgeSeconds <= 60 &&
    bid !== null && ask !== null && ask >= bid &&
    spreadPoints !== null && brokerSymbol !== null;
  const snapshotTime = finiteNumber(probe.timestamp, 1);

  return {
    connected: true,
    dataStatus: "BROKER_REPORTED_SNAPSHOT",
    accountDataStatus: accountLogin !== null && balance !== null && equity !== null &&
      freeMargin !== null && profit !== null ? "BROKER_VALUES_PRESENT" : "PARTIAL_UNVERIFIED",
    quoteDataStatus: quoteValid ? "BROKER_QUOTE_FRESH" : "STALE_OR_INVALID",
    accountLogin,
    accountName: nonemptyString(probe.accountName),
    accountMode: ["LIVE", "DEMO", "CONTEST"].includes(probe.accountMode) ? probe.accountMode.toLowerCase() : null,
    accountBalance: balance,
    accountEquity: equity,
    accountFreeMargin: freeMargin,
    accountProfit: profit,
    accountCurrency: nonemptyString(probe.currency),
    server: nonemptyString(probe.server),
    brokerSymbol,
    availableGoldSymbols: Array.isArray(probe.availableGoldSymbols)
      ? probe.availableGoldSymbols.filter(s => typeof s === "string" && s.trim()) : [],
    quote: quoteValid ? {
      symbol: "XAUUSD",
      brokerSymbol,
      bid,
      ask,
      spreadPoints,
      timestamp: snapshotTime,
      quoteAgeSeconds,
      provenance: "MT5_BROKER_TICK_VALIDATED",
    } : null,
    brokerObservedAtMs: snapshotTime,
  };
}

/** The operator must supply a real positive capital assumption for research. */
export function readExplicitBacktestStartingBalance(input) {
  return finiteNumber(input, Number.EPSILON);
}
