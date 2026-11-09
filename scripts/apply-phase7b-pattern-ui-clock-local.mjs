import fs from "node:fs";
import path from "node:path";

const apply = process.argv.includes("--apply");
const root = process.env.PHASE7B_PATTERN_UI_CLOCK_PATCH_ROOT
  ? path.resolve(process.env.PHASE7B_PATTERN_UI_CLOCK_PATCH_ROOT)
  : process.cwd();

const files = {
  api: path.join(root, "apps", "api", "src", "routes", "phase7b-demo.route.ts"),
  web: path.join(root, "apps", "web", "src", "pages", "Phase7BPatternCheckPage.tsx"),
};

for (const file of Object.values(files)) {
  if (!fs.existsSync(file)) throw new Error(`Required file not found: ${file}`);
}

const originals = new Map();
const normalized = new Map();
const eols = new Map();
for (const file of Object.values(files)) {
  const source = fs.readFileSync(file, "utf8");
  originals.set(file, source);
  eols.set(file, source.includes("\r\n") ? "\r\n" : "\n");
  normalized.set(file, source.replace(/\r\n/g, "\n"));
}

const apiSource = normalized.get(files.api);
const webSource = normalized.get(files.web);
const semanticUiV2Superseded =
  webSource.includes("SEMANTIC UI v2") &&
  webSource.includes("fetchPhase7CWebStatus");
const apiClockAlreadyApplied =
  apiSource.includes("THREE_CANDLE_BODY_DOMINANCE") &&
  apiSource.includes("inferBrokerClockOffset") &&
  apiSource.includes("normalizeBrokerTimestamp") &&
  apiSource.includes("telemetry.quote?.timestamp");

if (semanticUiV2Superseded && apiClockAlreadyApplied) {
  console.log("PHASE7B_PATTERN_UI_CLOCK_PATCH=START");
  console.log(`PHASE7B_PATTERN_UI_CLOCK_ROOT=${root}`);
  console.log(`PHASE7B_PATTERN_UI_CLOCK_MODE=${apply ? "APPLY" : "CHECK_ONLY"}`);
  console.log("PHASE7B_PATTERN_UI_CLOCK_SCOPE=DISPLAY_ONLY_NO_EXECUTION_LOGIC");
  console.log("PHASE7B_PATTERN_UI_CLOCK_SUPERSEDED=SEMANTIC_UI_V2");
  console.log("PHASE7B_PATTERN_UI_CLOCK_CHANGES_NEEDED=0");
  if (apply) {
    console.log("PHASE7B_PATTERN_UI_CLOCK_APPLY=PASS");
    console.log("PHASE7B_PATTERN_UI_CLOCK_LINE_ENDINGS=PRESERVED");
    console.log("PHASE7B_PATTERN_UI_CLOCK_EXECUTION_MUTATION=False");
  } else {
    console.log("PHASE7B_PATTERN_UI_CLOCK_ORIGINAL_MUTATION=False");
    console.log("PHASE7B_PATTERN_UI_CLOCK_CHECK=PASS");
  }
  process.exit(0);
}

if (!apiSource.includes("THREE_CANDLE_BODY_DOMINANCE")) {
  throw new Error("API three-candle pattern is missing. Apply the three-candle migration first.");
}
if (!webSource.includes('THREE_CANDLE_BODY_DOMINANCE') || !webSource.includes('Ba nến B+C+D > A')) {
  throw new Error("Web three-candle pattern display is missing. Apply the three-candle migration first.");
}

const plans = [
  patch(
    files.api,
    "API_CLOCK_HELPER",
    `const ENGULF_BODY_TOLERANCE_PRICE = 0.1;\nconst router = Router();`,
    `const ENGULF_BODY_TOLERANCE_PRICE = 0.1;\nconst BROKER_CLOCK_HOUR_MS = 60 * 60_000;\nconst BROKER_CLOCK_MAX_OFFSET_MS = 14 * BROKER_CLOCK_HOUR_MS;\nconst BROKER_CLOCK_RESIDUAL_TOLERANCE_MS = 5 * 60_000;\n\nfunction inferBrokerClockOffset(brokerTimestamp: unknown, systemTimestamp: unknown): number | null {\n  const broker = Number(brokerTimestamp);\n  const system = Number(systemTimestamp);\n  if (!Number.isFinite(broker) || !Number.isFinite(system) || broker <= 0 || system <= 0) return null;\n  const rawOffset = broker - system;\n  const roundedOffset = Math.round(rawOffset / BROKER_CLOCK_HOUR_MS) * BROKER_CLOCK_HOUR_MS;\n  if (Math.abs(roundedOffset) > BROKER_CLOCK_MAX_OFFSET_MS) return null;\n  if (Math.abs(rawOffset - roundedOffset) > BROKER_CLOCK_RESIDUAL_TOLERANCE_MS) return null;\n  return roundedOffset;\n}\n\nfunction normalizeBrokerTimestamp(timestamp: number, brokerClockOffsetMs: number): number {\n  return timestamp - brokerClockOffsetMs;\n}\n\nconst router = Router();`,
  ),
  patch(
    files.api,
    "API_CLOCK_INFERENCE_CALL",
    `        entryDiagnostics = await getEntryDiagnostics();`,
    `        const brokerClockOffsetMs = inferBrokerClockOffset(\n          telemetry.quote?.timestamp,\n          telemetry.health?.timestamp ?? telemetry.checkedAt,\n        );\n        if (brokerClockOffsetMs === null) {\n          throw new Error("Broker clock offset is not a plausible whole-hour offset.");\n        }\n        entryDiagnostics = await getEntryDiagnostics(brokerClockOffsetMs);`,
    `entryDiagnostics = await getEntryDiagnostics(brokerClockOffsetMs, telemetry.quote);`,
  ),
  patch(
    files.api,
    "API_DIAGNOSTICS_SIGNATURE",
    `async function getEntryDiagnostics(): Promise<EntryDiagnostics> {`,
    `async function getEntryDiagnostics(brokerClockOffsetMs: number): Promise<EntryDiagnostics> {`,
    `async function getEntryDiagnostics(\n  brokerClockOffsetMs: number,\n  quote: { bid: number; ask: number } | null | undefined,\n): Promise<EntryDiagnostics> {`,
  ),
  patch(
    files.api,
    "API_DIAGNOSTICS_BUILD_CALL",
    `    return buildEntryDiagnostics(m15Bars, m5Bars);`,
    `    return buildEntryDiagnostics(m15Bars, m5Bars, brokerClockOffsetMs);`,
    `    return buildEntryDiagnostics(m15Bars, m5Bars, brokerClockOffsetMs, quote);`,
  ),
  patch(
    files.api,
    "API_BUILD_SIGNATURE",
    `function buildEntryDiagnostics(bars: M15Bar[], m5Bars: M15Bar[]): EntryDiagnostics {`,
    `function buildEntryDiagnostics(bars: M15Bar[], m5Bars: M15Bar[], brokerClockOffsetMs: number): EntryDiagnostics {`,
    `function buildEntryDiagnostics(\n  bars: M15Bar[],\n  m5Bars: M15Bar[],\n  brokerClockOffsetMs: number,\n  quote: { bid: number; ask: number } | null | undefined,\n): EntryDiagnostics {`,
  ),
  patch(
    files.api,
    "API_NORMALIZED_M15_TIMES",
    `  return {\n    source: "READ_ONLY_BRIDGE_M15",\n    closeTime: current.closeTime,\n    nextCloseTime: current.closeTime + 15 * 60_000,`,
    `  const normalizedCloseTime = normalizeBrokerTimestamp(current.closeTime, brokerClockOffsetMs);\n\n  return {\n    source: "READ_ONLY_BRIDGE_M15",\n    closeTime: normalizedCloseTime,\n    nextCloseTime: normalizedCloseTime + 15 * 60_000,`,
  ),
  patch(
    files.web,
    "WEB_FORMAT_IMPORT",
    `import { dateTime, price } from "../format";`,
    `import { price } from "../format";`,
  ),
  patch(
    files.web,
    "WEB_VIETNAM_TIME_FORMATTER",
    `function countdown(ms: number) {`,
    `function vietnamDateTime(timestamp: number) {\n  return new Intl.DateTimeFormat("vi-VN", {\n    dateStyle: "short",\n    timeStyle: "medium",\n    timeZone: "Asia/Ho_Chi_Minh",\n  }).format(new Date(timestamp));\n}\n\nfunction countdown(ms: number) {`,
  ),
  patch(
    files.web,
    "WEB_COUNTDOWN_CLAMP",
    `  const remainingMs = d ? d.nextCloseTime - now : 0;\n  const progress = useMemo(() => d ? Math.max(0, Math.min(100, ((15 * 60_000 - remainingMs) / (15 * 60_000)) * 100)) : 0, [d, remainingMs]);`,
    `  const rawRemainingMs = d ? d.nextCloseTime - now : 0;\n  const remainingMs = Math.max(0, Math.min(15 * 60_000, rawRemainingMs));\n  const progress = useMemo(() => d ? Math.max(0, Math.min(100, ((15 * 60_000 - remainingMs) / (15 * 60_000)) * 100)) : 0, [d, remainingMs]);`,
  ),
  patch(
    files.web,
    "WEB_CANDLE_TIME_LABELS",
    `<Typography variant="caption" color="text.secondary" display="block" mt={1}>Nến vừa đóng: {dateTime(d.closeTime)}</Typography>`,
    `<Typography variant="caption" color="text.secondary" display="block" mt={1}>Nến vừa đóng (giờ Việt Nam): {vietnamDateTime(d.closeTime)}</Typography>\n            <Typography variant="caption" color="text.secondary" display="block">Đóng nến tiếp theo (giờ Việt Nam): {vietnamDateTime(d.nextCloseTime)}</Typography>`,
  ),
];

const changes = plans.filter((plan) => plan.changed);
console.log("PHASE7B_PATTERN_UI_CLOCK_PATCH=START");
console.log(`PHASE7B_PATTERN_UI_CLOCK_ROOT=${root}`);
console.log(`PHASE7B_PATTERN_UI_CLOCK_MODE=${apply ? "APPLY" : "CHECK_ONLY"}`);
console.log("PHASE7B_PATTERN_UI_CLOCK_SCOPE=DISPLAY_ONLY_NO_EXECUTION_LOGIC");
console.log("PHASE7B_PATTERN_UI_CLOCK_THREE_PATTERNS_REQUIRED=True");
for (const plan of plans) {
  console.log(`PHASE7B_PATTERN_UI_CLOCK_STEP=${plan.name}|${plan.changed ? (apply ? "APPLY" : "NEEDED") : "ALREADY_APPLIED"}`);
}
console.log(`PHASE7B_PATTERN_UI_CLOCK_CHANGES_NEEDED=${changes.length}`);

if (!apply) {
  console.log("PHASE7B_PATTERN_UI_CLOCK_ORIGINAL_MUTATION=False");
  console.log("PHASE7B_PATTERN_UI_CLOCK_CHECK=PASS");
  if (changes.length) console.log("PHASE7B_PATTERN_UI_CLOCK_NEXT=node scripts/apply-phase7b-pattern-ui-clock-local.mjs --apply");
  process.exit(0);
}

for (const file of Object.values(files)) {
  const source = normalized.get(file);
  const filePlans = plans.filter((plan) => plan.file === file && plan.changed);
  if (!filePlans.length) continue;
  let output = source;
  for (const plan of filePlans) output = output.replace(plan.before, plan.after);
  normalized.set(file, output);
}

for (const file of Object.values(files)) {
  const before = originals.get(file);
  const normalizedAfter = normalized.get(file);
  const eol = eols.get(file);
  const after = eol === "\r\n" ? normalizedAfter.replace(/\n/g, "\r\n") : normalizedAfter;
  if (after === before) continue;
  const backup = `${file}.pattern-ui-clock.bak`;
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, before, "utf8");
  fs.writeFileSync(file, after, "utf8");
  console.log(`PHASE7B_PATTERN_UI_CLOCK_FILE_UPDATED=${file}`);
  console.log(`PHASE7B_PATTERN_UI_CLOCK_BACKUP=${backup}`);
}

console.log("PHASE7B_PATTERN_UI_CLOCK_APPLY=PASS");
console.log("PHASE7B_PATTERN_UI_CLOCK_LINE_ENDINGS=PRESERVED");
console.log("PHASE7B_PATTERN_UI_CLOCK_EXECUTION_MUTATION=False");

function patch(file, name, before, after, acceptedAfter = null) {
  const source = normalized.get(file);
  if (source.includes(after) || (acceptedAfter && source.includes(acceptedAfter))) {
    return { file, name, before, after, changed: false };
  }
  const count = source.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`${name}: expected exactly one source anchor, found ${count}. Refusing to modify ${file}`);
  }
  return { file, name, before, after, changed: true };
}
