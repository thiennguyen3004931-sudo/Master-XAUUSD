import fs from "node:fs";
import path from "node:path";
import {
  evaluateTimestampFreshness,
  inferBrokerClockOffset,
} from "./phase7c-sideway-execution-guards.mjs";

const root = process.cwd();
const envPath = path.join(root, "packages", "mt5-broker", "bridge", ".env.phase7b-demo");
if (!fs.existsSync(envPath)) throw new Error(`Bridge env not found: ${envPath}`);

const env = readEnv(envPath);
const host = env.MT5_BRIDGE_HOST || "127.0.0.1";
const port = env.MT5_BRIDGE_PORT || "8765";
const apiKey = env.MT5_API_KEY || "";
if (!apiKey) throw new Error("MT5_API_KEY is missing.");

const base = `http://${host}:${port}`;
const headers = { "x-mt5-api-key": apiKey, accept: "application/json" };

console.log("PHASE7C_BROKER_CLOCK_VERIFY=READ_ONLY");
console.log(`PHASE7C_BROKER_CLOCK_BASE=${base}`);

const [health, quote, m5, m15] = await Promise.all([
  get("/health"),
  get("/v1/quotes/XAUUSD"),
  get("/v1/candles/XAUUSD?timeframe=M5&count=3"),
  get("/v1/candles/XAUUSD?timeframe=M15&count=3"),
]);

if (!health?.connected || health?.status !== "ok") throw new Error("MT5 bridge is not healthy/connected.");
if (health?.accountMode !== "demo") throw new Error(`DEMO account required; got ${health?.accountMode ?? "UNKNOWN"}.`);

const latestM5 = Array.isArray(m5) ? m5.at(-1) : null;
const latestM15 = Array.isArray(m15) ? m15.at(-1) : null;
const offset = inferBrokerClockOffset(quote?.timestamp, { systemTimestamp: health?.timestamp });

console.log(`PHASE7C_BROKER_CLOCK_ACCOUNT_LOGIN=${health.accountLogin ?? "UNKNOWN"}`);
console.log(`PHASE7C_BROKER_CLOCK_ACCOUNT_MODE=${health.accountMode ?? "UNKNOWN"}`);
console.log(`PHASE7C_BROKER_CLOCK_HEALTH_TIMESTAMP=${health.timestamp ?? "UNKNOWN"}`);
console.log(`PHASE7C_BROKER_CLOCK_QUOTE_TIMESTAMP=${quote?.timestamp ?? "UNKNOWN"}`);
console.log(`PHASE7C_BROKER_CLOCK_OFFSET_MS=${offset ?? "INVALID"}`);
console.log(`PHASE7C_BROKER_CLOCK_OFFSET_MINUTES=${offset === null ? "INVALID" : offset / 60_000}`);

if (offset === null) throw new Error("Broker clock is not a plausible whole-hour offset from system clock.");

const now = Date.now();
const quoteFreshness = evaluateTimestampFreshness(quote?.timestamp, {
  now,
  maxAgeMs: 30_000,
  clockOffsetMs: offset,
});
const m5Freshness = evaluateTimestampFreshness(latestM5?.closeTime, {
  now,
  maxAgeMs: 10 * 60_000,
  clockOffsetMs: offset,
});
const m15Freshness = evaluateTimestampFreshness(latestM15?.closeTime, {
  now,
  maxAgeMs: 30 * 60_000,
  clockOffsetMs: offset,
});

printFreshness("QUOTE", quoteFreshness);
printFreshness("M5", m5Freshness);
printFreshness("M15", m15Freshness);

if (!quoteFreshness.fresh || !m5Freshness.fresh || !m15Freshness.fresh) {
  throw new Error("Broker-clock normalization did not produce fresh quote/M5/M15 timestamps.");
}

console.log("PHASE7C_BROKER_CLOCK_VERIFY_STATUS=PASS");
console.log("PHASE7C_BROKER_CLOCK_EXECUTION_MUTATION=False");

async function get(pathname) {
  const response = await fetch(`${base}${pathname}`, { headers, cache: "no-store" });
  const text = await response.text();
  if (!response.ok) throw new Error(`GET ${pathname} ${response.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

function printFreshness(label, value) {
  console.log(`PHASE7C_BROKER_CLOCK_${label}_FRESH=${value.fresh}`);
  console.log(`PHASE7C_BROKER_CLOCK_${label}_AGE_MS=${value.ageMs}`);
  console.log(`PHASE7C_BROKER_CLOCK_${label}_RAW_AGE_MS=${value.rawAgeMs}`);
  console.log(`PHASE7C_BROKER_CLOCK_${label}_OFFSET_MS=${value.clockOffsetMs}`);
}

function readEnv(file) {
  const result = {};
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim().replace(/^\uFEFF/, "");
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}
