import fs from "node:fs";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const required = [
  "frozenM15", "rawM15", "rawM5", "rawMeta",
  "outM15", "outM5", "outMeta", "blindDays", "warmupDays", "datasetOffsetMs",
];
for (const key of required) {
  if (!args[key]) throw new Error(`Missing required argument --${key}`);
}

const blindDays = Number(args.blindDays);
const warmupDays = Number(args.warmupDays);
const datasetOffsetMs = Number(args.datasetOffsetMs);
if (!Number.isFinite(blindDays) || blindDays <= 0) throw new Error("blindDays must be > 0.");
if (!Number.isFinite(warmupDays) || warmupDays <= 0) throw new Error("warmupDays must be > 0.");
if (!Number.isFinite(datasetOffsetMs)) throw new Error("datasetOffsetMs must be finite.");

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_EDGE_GAP_MS = 4 * DAY_MS;
const frozenM15 = readArray(args.frozenM15);
const rawM15 = readArray(args.rawM15);
const rawM5 = readArray(args.rawM5);
const rawMeta = JSON.parse(fs.readFileSync(path.resolve(args.rawMeta), "utf8"));
if (frozenM15.length === 0) throw new Error("Frozen M15 dataset is empty.");
if (rawM15.length === 0 || rawM5.length === 0) throw new Error("Historical export is empty.");

const frozenStart = minBy(frozenM15, (bar) => barOpenTime(bar));
const blindEnd = frozenStart;
const blindStart = blindEnd - blindDays * DAY_MS;
const warmupStart = blindStart - warmupDays * DAY_MS;

const preparedM15 = rawM15
  .filter((bar) => {
    const open = barOpenTime(bar);
    return open >= warmupStart && open < blindEnd;
  })
  .sort((a, b) => barOpenTime(a) - barOpenTime(b));
const preparedM5 = rawM5
  .filter((bar) => {
    const open = barOpenTime(bar);
    return open >= warmupStart && open < blindEnd;
  })
  .sort((a, b) => barOpenTime(a) - barOpenTime(b));

if (preparedM15.length === 0 || preparedM5.length === 0) {
  throw new Error("Phase 6E prepared historical dataset is empty.");
}

const warmupM15Bars = preparedM15.filter((bar) => barCloseTime(bar, 15 * 60_000) <= blindStart).length;
const blindM15 = preparedM15.filter((bar) => {
  const close = barCloseTime(bar, 15 * 60_000);
  return close >= blindStart && close < blindEnd;
});
const blindM5 = preparedM5.filter((bar) => {
  const close = barCloseTime(bar, 5 * 60_000);
  return close >= blindStart && close < blindEnd;
});
const blindM15Bars = blindM15.length;
const blindM5Bars = blindM5.length;

if (warmupM15Bars < 200) {
  throw new Error(`Phase 6E requires at least 200 M15 warm-up bars before blindStart; got ${warmupM15Bars}. Increase export history.`);
}
if (blindM15Bars === 0 || blindM5Bars === 0) {
  throw new Error("Phase 6E blind window contains no M15 or M5 bars.");
}
if (preparedM15.some((bar) => barOpenTime(bar) >= frozenStart) ||
    preparedM5.some((bar) => barOpenTime(bar) >= frozenStart)) {
  throw new Error("Phase 6E historical dataset overlaps the frozen dataset start.");
}

const earliestPreparedM15 = minBy(preparedM15, (bar) => barOpenTime(bar));
const latestPreparedM15 = maxBy(preparedM15, (bar) => barCloseTime(bar, 15 * 60_000));
const earliestPreparedM5 = minBy(preparedM5, (bar) => barOpenTime(bar));
const latestPreparedM5 = maxBy(preparedM5, (bar) => barCloseTime(bar, 5 * 60_000));
const earliestBlindM15 = minBy(blindM15, (bar) => barOpenTime(bar));
const earliestBlindM5 = minBy(blindM5, (bar) => barOpenTime(bar));

// Only M15 needs the 30-day pre-blind warm-up because MA/ATR/profile are M15-derived.
// M5 is execution data, so strict coverage begins at blindStart, not warmupStart.
if (earliestPreparedM15 > warmupStart + MAX_EDGE_GAP_MS) {
  throw new Error(
    `Phase 6E M15 history does not reach the fixed warm-up window. ` +
    `warmupStart=${new Date(warmupStart).toISOString()} earliestM15=${new Date(earliestPreparedM15).toISOString()}.`,
  );
}
if (earliestBlindM15 > blindStart + MAX_EDGE_GAP_MS) {
  throw new Error(
    `Phase 6E M15 history does not cover the beginning of the fixed blind window. ` +
    `blindStart=${new Date(blindStart).toISOString()} earliestBlindM15=${new Date(earliestBlindM15).toISOString()}.`,
  );
}
if (earliestBlindM5 > blindStart + MAX_EDGE_GAP_MS) {
  throw new Error(
    `Phase 6E M5 history does not cover the beginning of the fixed blind window. ` +
    `blindStart=${new Date(blindStart).toISOString()} earliestBlindM5=${new Date(earliestBlindM5).toISOString()}. ` +
    `Increase MT5 Max. bars in chart/history and reload XAUUSD M5.`,
  );
}
if (latestPreparedM15 < blindEnd - MAX_EDGE_GAP_MS ||
    latestPreparedM5 < blindEnd - MAX_EDGE_GAP_MS) {
  throw new Error(
    `Phase 6E historical export does not reach the end of the fixed blind window. ` +
    `blindEnd=${new Date(blindEnd).toISOString()} latestM15=${new Date(latestPreparedM15).toISOString()} ` +
    `latestM5=${new Date(latestPreparedM5).toISOString()}.`,
  );
}

writeJson(args.outM15, preparedM15);
writeJson(args.outM5, preparedM5);
writeJson(args.outMeta, {
  ...rawMeta,
  m15Count: preparedM15.length,
  m5Count: preparedM5.length,
  phase6eHistoricalBlind: {
    blindDays,
    warmupDays,
    datasetOffsetMs,
    frozenStartTimestamp: frozenStart,
    frozenStartDataset: new Date(frozenStart).toISOString(),
    frozenStartRealUtc: new Date(frozenStart - datasetOffsetMs).toISOString(),
    blindStartTimestamp: blindStart,
    blindStartDataset: new Date(blindStart).toISOString(),
    blindStartRealUtc: new Date(blindStart - datasetOffsetMs).toISOString(),
    blindEndTimestamp: blindEnd,
    blindEndDataset: new Date(blindEnd).toISOString(),
    blindEndRealUtc: new Date(blindEnd - datasetOffsetMs).toISOString(),
    warmupStartTimestamp: warmupStart,
    warmupStartDataset: new Date(warmupStart).toISOString(),
    warmupStartRealUtc: new Date(warmupStart - datasetOffsetMs).toISOString(),
    warmupM15Bars,
    blindM15Bars,
    blindM5Bars,
    preparedM15Bars: preparedM15.length,
    preparedM5Bars: preparedM5.length,
    earliestPreparedM15: new Date(earliestPreparedM15).toISOString(),
    latestPreparedM15: new Date(latestPreparedM15).toISOString(),
    earliestPreparedM5: new Date(earliestPreparedM5).toISOString(),
    earliestBlindM15: new Date(earliestBlindM15).toISOString(),
    earliestBlindM5: new Date(earliestBlindM5).toISOString(),
    latestPreparedM5: new Date(latestPreparedM5).toISOString(),
    maxAllowedEdgeGapMs: MAX_EDGE_GAP_MS,
    fullCoverage: true,
    strictNoOverlap: true,
  },
});

console.log(`PHASE6E_PREP_FROZEN_START_DATASET=${new Date(frozenStart).toISOString()}`);
console.log(`PHASE6E_PREP_FROZEN_START_REAL_UTC=${new Date(frozenStart - datasetOffsetMs).toISOString()}`);
console.log(`PHASE6E_PREP_BLIND_START_DATASET=${new Date(blindStart).toISOString()}`);
console.log(`PHASE6E_PREP_BLIND_END_DATASET=${new Date(blindEnd).toISOString()}`);
console.log(`PHASE6E_PREP_WARMUP_START_DATASET=${new Date(warmupStart).toISOString()}`);
console.log(`PHASE6E_PREP_EARLIEST_M15=${new Date(earliestPreparedM15).toISOString()}`);
console.log(`PHASE6E_PREP_EARLIEST_BLIND_M15=${new Date(earliestBlindM15).toISOString()}`);
console.log(`PHASE6E_PREP_EARLIEST_M5=${new Date(earliestPreparedM5).toISOString()}`);
console.log(`PHASE6E_PREP_EARLIEST_BLIND_M5=${new Date(earliestBlindM5).toISOString()}`);
console.log(`PHASE6E_PREP_LATEST_M15=${new Date(latestPreparedM15).toISOString()}`);
console.log(`PHASE6E_PREP_LATEST_M5=${new Date(latestPreparedM5).toISOString()}`);
console.log(`PHASE6E_PREP_WARMUP_M15_BARS=${warmupM15Bars}`);
console.log(`PHASE6E_PREP_BLIND_M15_BARS=${blindM15Bars}`);
console.log(`PHASE6E_PREP_BLIND_M5_BARS=${blindM5Bars}`);
console.log(`PHASE6E_PREP_PREPARED_M15_BARS=${preparedM15.length}`);
console.log(`PHASE6E_PREP_PREPARED_M5_BARS=${preparedM5.length}`);
console.log("PHASE6E_PREP_M15_WARMUP_COVERAGE=PASS");
console.log("PHASE6E_PREP_M15_BLIND_COVERAGE=PASS");
console.log("PHASE6E_PREP_M5_BLIND_COVERAGE=PASS");
console.log("PHASE6E_PREP_FULL_COVERAGE=PASS");
console.log("PHASE6E_PREP_STRICT_NO_OVERLAP=PASS");
console.log("PHASE6E_PREP_STATUS=PASS");

function barOpenTime(bar) {
  return normalizeTimestamp(firstDefined(bar.openTime, bar.open_time, bar.openTimeMs, bar.time, bar.timestamp), "bar open time");
}
function barCloseTime(bar, timeframeMs) {
  const explicit = firstDefined(bar.closeTime, bar.close_time, bar.closeTimeMs);
  return explicit !== undefined && explicit !== null
    ? normalizeTimestamp(explicit, "bar close time")
    : barOpenTime(bar) + timeframeMs;
}
function normalizeTimestamp(value, label) {
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return normalizeTimestamp(numeric, label);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  throw new Error(`Unable to parse ${label}: ${String(value)}`);
}
function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}
function minBy(items, selector) {
  let value = Number.POSITIVE_INFINITY;
  for (const item of items) value = Math.min(value, selector(item));
  return value;
}
function maxBy(items, selector) {
  let value = Number.NEGATIVE_INFINITY;
  for (const item of items) value = Math.max(value, selector(item));
  return value;
}
function readArray(file) {
  const resolved = path.resolve(file);
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`Expected JSON array: ${resolved}`);
  return parsed;
}
function writeJson(file, value) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(value, null, 2) + "\n", "utf8");
}
function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) result[key] = "true";
    else {
      result[key] = value;
      index += 1;
    }
  }
  return result;
}
