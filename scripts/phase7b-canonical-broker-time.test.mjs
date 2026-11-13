import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const routeSource = fs.readFileSync(
  path.join(repoRoot, "apps/api/src/routes/phase7b-demo.route.ts"),
  "utf8",
);
const brokerTimeSource = fs.readFileSync(
  path.join(repoRoot, "packages/mt5-broker/bridge/mt5_bridge/broker_time.py"),
  "utf8",
);
const bridgeAppSource = fs.readFileSync(
  path.join(repoRoot, "packages/mt5-broker/bridge/mt5_bridge/app.py"),
  "utf8",
);

// Canonical bridge contract: quote/candle timestamps are normalized before they
// leave the bridge. Phase7B must therefore consume them as UTC directly rather
// than trying to infer a timezone from quote age versus the current health time.
assert.match(brokerTimeSource, /def normalize_quote\(/);
assert.match(brokerTimeSource, /def normalize_candles\(/);
assert.match(bridgeAppSource, /return normalize_quote\(gateway\.quote\(symbol\)\)/);
assert.match(bridgeAppSource, /return normalize_candles\(/);
assert.match(
  brokerTimeSource,
  /stale weekend\s+quotes or a bad Windows clock cannot silently rewrite market time/i,
);

// Regression: a weekend-stale quote may be tens of hours old while the bridge
// and account are healthy. That quote age is not a broker timezone offset.
const fridayQuoteMs = Date.parse("2026-09-11T20:56:59.324Z");
const sundayHealthMs = Date.parse("2026-09-13T08:30:12.146Z");
const staleQuoteAgeHours = (sundayHealthMs - fridayQuoteMs) / 3_600_000;
assert.ok(staleQuoteAgeHours > 14, "Regression fixture must represent a stale weekend quote older than 14 hours.");

assert.doesNotMatch(
  routeSource,
  /inferBrokerClockOffset\s*\(/,
  "Phase7B must not infer timezone from a quote timestamp that can be stale over weekends.",
);
assert.doesNotMatch(
  routeSource,
  /telemetry\.quote\?\.timestamp[\s\S]{0,300}telemetry\.health\?\.timestamp/,
  "Phase7B must not compare quote age to health time as a clock-offset source.",
);
assert.match(
  routeSource,
  /entryDiagnostics\s*=\s*await getEntryDiagnostics\(0,\s*telemetry\.quote\)/,
  "Phase7B must consume bridge-normalized UTC candle timestamps without applying a second inferred offset.",
);

console.log("PHASE7B_CANONICAL_BROKER_TIME_CONTRACT=PASS");
console.log("PHASE7B_WEEKEND_STALE_QUOTE_REGRESSION=PASS");
console.log("PHASE7B_DOUBLE_TIMEZONE_NORMALIZATION=NONE");
