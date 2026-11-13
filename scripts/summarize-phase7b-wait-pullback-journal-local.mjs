import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const raw = arg.replace(/^--/, "");
  const index = raw.indexOf("=");
  return index >= 0 ? [raw.slice(0, index), raw.slice(index + 1)] : [raw, "true"];
}));

const fileArg = String(args.file ?? "").trim();
if (!fileArg) {
  throw new Error("Missing --file=<phase7b journal.jsonl>.");
}
const file = path.resolve(fileArg);
if (!fs.existsSync(file)) {
  throw new Error(`Phase 7B journal not found: ${file}`);
}

const rows = fs.readFileSync(file, "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSONL at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

const counts = {};
for (const row of rows) counts[row.type] = (counts[row.type] ?? 0) + 1;

const waits = new Map();
const terminals = new Map();
const terminalTypes = new Set([
  "PULLBACK_ENTRY",
  "PULLBACK_SETUP_INVALIDATED",
  "PULLBACK_M15_ST_INVALIDATED",
  "PULLBACK_M5_ST_INVALIDATED",
  "PULLBACK_EXPIRED",
]);

for (const row of rows) {
  if (!row.signalId) continue;
  if (row.type === "WAIT_PULLBACK" && !waits.has(row.signalId)) {
    waits.set(row.signalId, row);
  }
  if (terminalTypes.has(row.type) && !terminals.has(row.signalId)) {
    terminals.set(row.signalId, row);
  }
}

const waitDurationsMinutes = [];
for (const [signalId, wait] of waits) {
  const terminal = terminals.get(signalId);
  if (!terminal) continue;
  const start = Date.parse(wait.timestamp);
  const end = Date.parse(terminal.timestamp);
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
    waitDurationsMinutes.push((end - start) / 60_000);
  }
}

const waitCount = waits.size;
const recovered = [...terminals.values()].filter((row) => row.type === "PULLBACK_ENTRY").length;
const setupInvalidated = [...terminals.values()].filter((row) => row.type === "PULLBACK_SETUP_INVALIDATED").length;
const m15StInvalidated = [...terminals.values()].filter((row) => row.type === "PULLBACK_M15_ST_INVALIDATED").length;
const m5StInvalidated = [...terminals.values()].filter((row) => row.type === "PULLBACK_M5_ST_INVALIDATED").length;
const expired = [...terminals.values()].filter((row) => row.type === "PULLBACK_EXPIRED").length;
const openWaits = [...waits.keys()].filter((signalId) => !terminals.has(signalId)).length;
const terminalWaits = recovered + setupInvalidated + m15StInvalidated + m5StInvalidated + expired;

const fillsByState = { ENTRY_IMMEDIATE: 0, PULLBACK_ENTRY: 0, UNKNOWN: 0 };
for (const row of rows) {
  if (row.type !== "ENTRY_FILLED") continue;
  if (row.entryState === "ENTRY_IMMEDIATE") fillsByState.ENTRY_IMMEDIATE += 1;
  else if (row.entryState === "PULLBACK_ENTRY") fillsByState.PULLBACK_ENTRY += 1;
  else fillsByState.UNKNOWN += 1;
}

const summary = {
  journal: file,
  rows: rows.length,
  firstEventAt: rows.at(0)?.timestamp ?? null,
  lastEventAt: rows.at(-1)?.timestamp ?? null,
  immediateEntrySignals: counts.ENTRY_IMMEDIATE ?? 0,
  waitPullbackSetups: waitCount,
  pullbackStillTooWideEvaluations: counts.PULLBACK_STILL_TOO_WIDE ?? 0,
  pullbackRecovered: recovered,
  pullbackSetupInvalidated: setupInvalidated,
  pullbackM15SupertrendInvalidated: m15StInvalidated,
  pullbackM5SupertrendInvalidated: m5StInvalidated,
  pullbackExpired: expired,
  pullbackOpen: openWaits,
  pullbackTerminal: terminalWaits,
  pullbackRecoveryRatePercent: waitCount > 0 ? round(recovered / waitCount * 100, 2) : 0,
  pullbackTerminalRecoveryRatePercent: terminalWaits > 0 ? round(recovered / terminalWaits * 100, 2) : 0,
  waitMinutesMedian: round(median(waitDurationsMinutes), 2),
  waitMinutesAverage: round(average(waitDurationsMinutes), 2),
  entrySubmitted: counts.ENTRY_SUBMIT ?? 0,
  entryRejected: counts.ENTRY_REJECTED ?? 0,
  entryFilled: counts.ENTRY_FILLED ?? 0,
  fillsByState,
  cycleErrors: (counts.CYCLE_ERROR ?? 0) + (counts.SHADOW_CYCLE_ERROR ?? 0),
  rawEventCounts: counts,
};

console.log(`PHASE7B_WAIT_SUMMARY_FILE=${file}`);
console.log(`PHASE7B_WAIT_SUMMARY_ROWS=${summary.rows}`);
console.log(`PHASE7B_WAIT_IMMEDIATE=${summary.immediateEntrySignals}`);
console.log(`PHASE7B_WAIT_SETUP_COUNT=${summary.waitPullbackSetups}`);
console.log(`PHASE7B_WAIT_RECOVERED=${summary.pullbackRecovered}`);
console.log(`PHASE7B_WAIT_RECOVERY_RATE_PERCENT=${summary.pullbackRecoveryRatePercent}`);
console.log(`PHASE7B_WAIT_SETUP_INVALIDATED=${summary.pullbackSetupInvalidated}`);
console.log(`PHASE7B_WAIT_M15_ST_INVALIDATED=${summary.pullbackM15SupertrendInvalidated}`);
console.log(`PHASE7B_WAIT_M5_ST_INVALIDATED=${summary.pullbackM5SupertrendInvalidated}`);
console.log(`PHASE7B_WAIT_EXPIRED=${summary.pullbackExpired}`);
console.log(`PHASE7B_WAIT_OPEN=${summary.pullbackOpen}`);
console.log(`PHASE7B_WAIT_MEDIAN_MINUTES=${summary.waitMinutesMedian}`);
console.log(`PHASE7B_WAIT_AVERAGE_MINUTES=${summary.waitMinutesAverage}`);
console.log(`PHASE7B_WAIT_ENTRY_FILLED=${summary.entryFilled}`);
console.log(`PHASE7B_WAIT_CYCLE_ERRORS=${summary.cycleErrors}`);

const output = String(args.out ?? "").trim();
if (output) {
  const outPath = path.resolve(output);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`PHASE7B_WAIT_SUMMARY_JSON=${outPath}`);
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
