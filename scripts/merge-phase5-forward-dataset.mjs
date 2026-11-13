import fs from "node:fs";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const required = [
  "frozenM15",
  "frozenM5",
  "freshM15",
  "freshM5",
  "freshMeta",
  "outM15",
  "outM5",
  "outMeta",
  "realCutoff",
  "datasetCutoffMs",
];
for (const key of required) {
  if (!args[key]) throw new Error(`Missing required argument --${key}`);
}

const realCutoff = Date.parse(args.realCutoff);
if (!Number.isFinite(realCutoff)) {
  throw new Error(`Invalid real cutoff: ${args.realCutoff}`);
}
const datasetCutoff = Number(args.datasetCutoffMs);
if (!Number.isFinite(datasetCutoff)) {
  throw new Error(`Invalid dataset cutoff ms: ${args.datasetCutoffMs}`);
}

const frozenM15 = readArray(args.frozenM15);
const frozenM5 = readArray(args.frozenM5);
const freshM15 = readArray(args.freshM15);
const freshM5 = readArray(args.freshM5);
const freshMeta = JSON.parse(fs.readFileSync(path.resolve(args.freshMeta), "utf8"));

const mergedM15 = mergeBars(
  frozenM15,
  freshM15,
  datasetCutoff,
  15 * 60_000,
  "M15",
);
const mergedM5 = mergeBars(
  frozenM5,
  freshM5,
  datasetCutoff,
  5 * 60_000,
  "M5",
);

writeJson(args.outM15, mergedM15.bars);
writeJson(args.outM5, mergedM5.bars);

const outMeta = {
  ...freshMeta,
  m15Count: mergedM15.bars.length,
  m5Count: mergedM5.bars.length,
  phase5ForwardMerge: {
    realCutoffUtc: new Date(realCutoff).toISOString(),
    datasetCutoff: new Date(datasetCutoff).toISOString(),
    datasetOffsetMs: datasetCutoff - realCutoff,
    frozenM15Kept: mergedM15.frozenKept,
    frozenM5Kept: mergedM5.frozenKept,
    bridgeM15Appended: mergedM15.bridgeAppended,
    bridgeM5Appended: mergedM5.bridgeAppended,
    forwardM15Appended: mergedM15.forwardAppended,
    forwardM5Appended: mergedM5.forwardAppended,
    latestM15CloseDatasetTime: isoOrNone(mergedM15.latestClose),
    latestM5CloseDatasetTime: isoOrNone(mergedM5.latestClose),
  },
};
writeJson(args.outMeta, outMeta);

console.log(`PHASE5_MERGE_REAL_CUTOFF_UTC=${new Date(realCutoff).toISOString()}`);
console.log(`PHASE5_MERGE_DATASET_CUTOFF=${new Date(datasetCutoff).toISOString()}`);
console.log(`PHASE5_MERGE_DATASET_OFFSET_MS=${datasetCutoff - realCutoff}`);
console.log(`PHASE5_MERGE_FROZEN_M15_KEPT=${mergedM15.frozenKept}`);
console.log(`PHASE5_MERGE_FROZEN_M5_KEPT=${mergedM5.frozenKept}`);
console.log(`PHASE5_MERGE_BRIDGE_M15_APPENDED=${mergedM15.bridgeAppended}`);
console.log(`PHASE5_MERGE_BRIDGE_M5_APPENDED=${mergedM5.bridgeAppended}`);
console.log(`PHASE5_MERGE_FORWARD_M15_APPENDED=${mergedM15.forwardAppended}`);
console.log(`PHASE5_MERGE_FORWARD_M5_APPENDED=${mergedM5.forwardAppended}`);
console.log(`PHASE5_MERGE_LATEST_M15_CLOSE=${isoOrNone(mergedM15.latestClose)}`);
console.log(`PHASE5_MERGE_LATEST_M5_CLOSE=${isoOrNone(mergedM5.latestClose)}`);

if (mergedM5.forwardAppended === 0 || mergedM5.latestClose <= datasetCutoff) {
  console.log("PHASE5_MERGE_FRESHNESS=FAIL");
  throw new Error(
    "No M5 bar strictly after the broker-adjusted Phase 5 cutoff. MT5 forward data is not fresh enough yet.",
  );
}

console.log("PHASE5_MERGE_FRESHNESS=PASS");
console.log("PHASE5_MERGE_STATUS=PASS");

function mergeBars(frozen, fresh, datasetCutoffMs, timeframeMs, label) {
  if (frozen.length === 0) throw new Error(`${label} frozen dataset is empty.`);

  const frozenLatestClose = Math.max(
    ...frozen.map((bar) => barCloseTime(bar, timeframeMs)),
  );
  const freshContinuation = fresh.filter(
    (bar) => barCloseTime(bar, timeframeMs) > frozenLatestClose,
  );

  const byOpen = new Map();
  // Frozen bars are authoritative. Never overwrite them with a re-export.
  for (const bar of frozen) {
    byOpen.set(barOpenTime(bar), bar);
  }
  for (const bar of freshContinuation) {
    const open = barOpenTime(bar);
    if (!byOpen.has(open)) byOpen.set(open, bar);
  }

  const bars = [...byOpen.values()].sort(
    (a, b) => barOpenTime(a) - barOpenTime(b),
  );
  if (bars.length === 0) throw new Error(`${label} merge produced no bars.`);

  const appended = freshContinuation.filter(
    (bar) => !frozen.some((frozenBar) => barOpenTime(frozenBar) === barOpenTime(bar)),
  );
  const bridgeAppended = appended.filter(
    (bar) => barCloseTime(bar, timeframeMs) <= datasetCutoffMs,
  ).length;
  const forwardAppended = appended.filter(
    (bar) => barCloseTime(bar, timeframeMs) > datasetCutoffMs,
  ).length;
  const latestClose = Math.max(...bars.map((bar) => barCloseTime(bar, timeframeMs)));

  return {
    bars,
    frozenKept: frozen.length,
    bridgeAppended,
    forwardAppended,
    latestClose,
  };
}

function barOpenTime(bar) {
  const raw = firstDefined(
    bar.openTime,
    bar.open_time,
    bar.openTimeMs,
    bar.time,
    bar.timestamp,
  );
  return normalizeTimestamp(raw, "bar open time");
}

function barCloseTime(bar, timeframeMs) {
  const explicit = firstDefined(
    bar.closeTime,
    bar.close_time,
    bar.closeTimeMs,
  );
  if (explicit !== undefined && explicit !== null) {
    return normalizeTimestamp(explicit, "bar close time");
  }
  return barOpenTime(bar) + timeframeMs;
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

function isoOrNone(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : "NONE";
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      result[key] = "true";
    } else {
      result[key] = value;
      index += 1;
    }
  }
  return result;
}
