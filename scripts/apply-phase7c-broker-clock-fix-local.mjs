import fs from "node:fs";
import path from "node:path";

const apply = process.argv.includes("--apply");
const root = process.env.PHASE7C_BROKER_CLOCK_PATCH_ROOT
  ? path.resolve(process.env.PHASE7C_BROKER_CLOCK_PATCH_ROOT)
  : process.cwd();
const sidewayPath = path.join(root, "scripts", "run-phase7c-sideway-controller.mjs");
const trendPath = path.join(root, "scripts", "run-phase7b-demo-controller.ts");

for (const target of [sidewayPath, trendPath]) {
  if (!fs.existsSync(target)) throw new Error(`Required controller not found: ${target}`);
}

const patches = [
  {
    file: sidewayPath,
    label: "SIDEWAY_CLOCK_INFERENCE",
    before: `  const [positions, quote, spec] = await Promise.all([\n    bridgeGet(\`/v1/positions?symbol=\${encodeURIComponent(symbol)}\`),\n    bridgeGet(\`/v1/quotes/\${encodeURIComponent(symbol)}\`),\n    bridgeGet(\`/v1/symbols/\${encodeURIComponent(symbol)}/spec\`),\n  ]);\n\n  if (!Array.isArray(positions)) {`,
    after: `  const [positions, quote, spec] = await Promise.all([\n    bridgeGet(\`/v1/positions?symbol=\${encodeURIComponent(symbol)}\`),\n    bridgeGet(\`/v1/quotes/\${encodeURIComponent(symbol)}\`),\n    bridgeGet(\`/v1/symbols/\${encodeURIComponent(symbol)}/spec\`),\n  ]);\n\n  const brokerClockOffsetMs = inferBrokerClockOffset(quote?.timestamp, {\n    systemTimestamp: health.timestamp,\n  });\n  if (brokerClockOffsetMs === null) {\n    journal("BROKER_CLOCK_OFFSET_BLOCK", {\n      healthTimestamp: health.timestamp ?? null,\n      quoteTimestamp: quote?.timestamp ?? null,\n      reason: "BROKER_CLOCK_NOT_PLAUSIBLE_WHOLE_HOUR_OFFSET",\n    });\n    return;\n  }\n\n  if (!Array.isArray(positions)) {`,
  },
  {
    file: sidewayPath,
    label: "SIDEWAY_PENDING_RECOVERY_CLOCK",
    before: `    const recovery = matchPendingEntryPosition(pending, positions, spec);`,
    after: `    const recovery = matchPendingEntryPosition(pending, positions, spec, Date.now(), brokerClockOffsetMs);`,
  },
  {
    file: sidewayPath,
    label: "SIDEWAY_RECOVERED_MANAGED_CLOCK",
    before: `      state.managed = buildManagedState(recovery.position, pending);`,
    after: `      state.managed = buildManagedState(recovery.position, pending, brokerClockOffsetMs);`,
  },
  {
    file: sidewayPath,
    label: "SIDEWAY_RECOVERY_MANAGEMENT_CLOCK",
    before: `      await managePosition(recovery.position, quote, spec);`,
    after: `      await managePosition(recovery.position, quote, spec, brokerClockOffsetMs);`,
  },
  {
    file: sidewayPath,
    label: "SIDEWAY_EXISTING_MANAGEMENT_CLOCK",
    before: `    await managePosition(managedPosition, quote, spec);`,
    after: `    await managePosition(managedPosition, quote, spec, brokerClockOffsetMs);`,
  },
  {
    file: sidewayPath,
    label: "SIDEWAY_ENTRY_QUOTE_FRESHNESS_CLOCK",
    before: `  const quoteFreshness = evaluateTimestampFreshness(quote?.timestamp, { maxAgeMs: maxQuoteAgeMs });\n  if (!quoteFreshness.fresh) {\n    journal("ENTRY_QUOTE_FRESHNESS_BLOCK",`,
    after: `  const quoteFreshness = evaluateTimestampFreshness(quote?.timestamp, { maxAgeMs: maxQuoteAgeMs, clockOffsetMs: brokerClockOffsetMs });\n  if (!quoteFreshness.fresh) {\n    journal("ENTRY_QUOTE_FRESHNESS_BLOCK",`,
  },
  {
    file: sidewayPath,
    label: "SIDEWAY_M5_FRESHNESS_CLOCK",
    before: `  const m5Freshness = evaluateTimestampFreshness(closeTime, { maxAgeMs: maxM5AgeMs });`,
    after: `  const m5Freshness = evaluateTimestampFreshness(closeTime, { maxAgeMs: maxM5AgeMs, clockOffsetMs: brokerClockOffsetMs });`,
  },
  {
    file: sidewayPath,
    label: "SIDEWAY_ENTRY_M15_FRESHNESS_CLOCK",
    before: `  const regimeFreshness = evaluateTimestampFreshness(regime?.lastCandleCloseTime, { maxAgeMs: maxM15AgeMs });\n  if (!regimeFreshness.fresh) {\n    journal("ENTRY_M15_FRESHNESS_BLOCK",`,
    after: `  const regimeFreshness = evaluateTimestampFreshness(regime?.lastCandleCloseTime, { maxAgeMs: maxM15AgeMs, clockOffsetMs: brokerClockOffsetMs });\n  if (!regimeFreshness.fresh) {\n    journal("ENTRY_M15_FRESHNESS_BLOCK",`,
  },
  {
    file: sidewayPath,
    label: "SIDEWAY_FINAL_QUOTE_FRESHNESS_CLOCK",
    before: `  const finalQuoteFreshness = evaluateTimestampFreshness(freshQuote?.timestamp, { maxAgeMs: maxQuoteAgeMs });`,
    after: `  const finalQuoteFreshness = evaluateTimestampFreshness(freshQuote?.timestamp, { maxAgeMs: maxQuoteAgeMs, clockOffsetMs: brokerClockOffsetMs });`,
  },
  {
    file: sidewayPath,
    label: "SIDEWAY_FINAL_M15_FRESHNESS_CLOCK",
    before: `  const finalRegimeFreshness = evaluateTimestampFreshness(freshRegime?.lastCandleCloseTime, { maxAgeMs: maxM15AgeMs });`,
    after: `  const finalRegimeFreshness = evaluateTimestampFreshness(freshRegime?.lastCandleCloseTime, { maxAgeMs: maxM15AgeMs, clockOffsetMs: brokerClockOffsetMs });`,
  },
  {
    file: sidewayPath,
    label: "SIDEWAY_NEW_MANAGED_CLOCK",
    before: `  state.managed = buildManagedState(opened, state.pendingEntry);`,
    after: `  state.managed = buildManagedState(opened, state.pendingEntry, brokerClockOffsetMs);`,
  },
  {
    file: sidewayPath,
    label: "SIDEWAY_MANAGED_TIME_NORMALIZATION",
    before: `function buildManagedState(opened, pending) {\n  if (!pending) throw new Error("Cannot build Sideway management state without durable pending entry metadata.");\n  const openedAt = Number.isFinite(Number(opened.openedAt)) ? Number(opened.openedAt) : Date.now();`,
    after: `function buildManagedState(opened, pending, brokerClockOffsetMs = 0) {\n  if (!pending) throw new Error("Cannot build Sideway management state without durable pending entry metadata.");\n  const brokerOpenedAt = Number(opened.openedAt);\n  const normalizedOpenedAt = normalizeBrokerTimestamp(brokerOpenedAt, brokerClockOffsetMs);\n  const openedAt = Number.isFinite(normalizedOpenedAt) ? normalizedOpenedAt : Date.now();`,
  },
  {
    file: sidewayPath,
    label: "SIDEWAY_MANAGE_SIGNATURE_CLOCK",
    before: `async function managePosition(position, quote, spec) {`,
    after: `async function managePosition(position, quote, spec, brokerClockOffsetMs = 0) {`,
  },
  {
    file: sidewayPath,
    label: "SIDEWAY_MANAGEMENT_M15_FRESHNESS_CLOCK",
    before: `    const regimeFreshness = evaluateTimestampFreshness(regimeClose, { maxAgeMs: maxM15AgeMs });`,
    after: `    const regimeFreshness = evaluateTimestampFreshness(regimeClose, { maxAgeMs: maxM15AgeMs, clockOffsetMs: brokerClockOffsetMs });`,
  },
  {
    file: sidewayPath,
    label: "SIDEWAY_MANAGEMENT_QUOTE_FRESHNESS_CLOCK",
    before: `  const quoteFreshness = evaluateTimestampFreshness(quote?.timestamp, { maxAgeMs: maxQuoteAgeMs });\n  if (!quoteFreshness.fresh) {\n    journal("MANAGEMENT_QUOTE_FRESHNESS_SKIP",`,
    after: `  const quoteFreshness = evaluateTimestampFreshness(quote?.timestamp, { maxAgeMs: maxQuoteAgeMs, clockOffsetMs: brokerClockOffsetMs });\n  if (!quoteFreshness.fresh) {\n    journal("MANAGEMENT_QUOTE_FRESHNESS_SKIP",`,
  },
  {
    file: trendPath,
    label: "TREND_SIGNAL_EXPIRY_BROKER_CLOCK",
    before: `  const now = Date.now();\n  if (now > signal.signalTimestamp + 15 * 60_000) {`,
    after: `  const now = Number(quote.timestamp);\n  if (!Number.isFinite(now)) {\n    journal("QUOTE_TIMESTAMP_INVALID", { quoteTimestamp: quote.timestamp });\n    return;\n  }\n  if (now > signal.signalTimestamp + 15 * 60_000) {`,
    acceptedAfter: `  const now = Number(quote.timestamp);\n  if (!Number.isFinite(now)) {\n    journal("QUOTE_TIMESTAMP_INVALID", { quoteTimestamp: quote.timestamp });\n    return;\n  }\n  if (now > signal.signalTimestamp + pullbackWaitMinutes * 60_000) {`,
  },
  {
    file: trendPath,
    label: "TREND_PARTIAL_ACTIVATION_BROKER_CLOCK",
    before: `        managed.partialActivatedAt = Date.now();`,
    after: `        managed.partialActivatedAt = Number(quote.timestamp);`,
  },
];

const byFile = new Map();
for (const patch of patches) {
  if (!byFile.has(patch.file)) byFile.set(patch.file, []);
  byFile.get(patch.file).push(patch);
}

let changesNeeded = 0;
for (const [file, filePatches] of byFile) {
  let source = fs.readFileSync(file, "utf8");
  const original = source;

  if (file === sidewayPath) {
    const importResult = ensureGuardImportNames(source, ["inferBrokerClockOffset", "normalizeBrokerTimestamp"]);
    source = importResult.source;
    if (importResult.changed) {
      changesNeeded += 1;
      console.log(`PHASE7C_BROKER_CLOCK_PATCH=SIDEWAY_IMPORT_CLOCK_HELPERS|${apply ? "APPLY" : "NEEDED"}`);
    } else {
      console.log("PHASE7C_BROKER_CLOCK_PATCH=SIDEWAY_IMPORT_CLOCK_HELPERS|ALREADY_APPLIED");
    }
  }

  for (const patch of filePatches) {
    if (source.includes(patch.after) || (patch.acceptedAfter && source.includes(patch.acceptedAfter))) {
      console.log(`PHASE7C_BROKER_CLOCK_PATCH=${patch.label}|ALREADY_APPLIED`);
      continue;
    }
    const count = countOccurrences(source, patch.before);
    if (count !== 1) {
      throw new Error(`${patch.label}: expected exactly one source anchor, found ${count}. Refusing to modify ${file}.`);
    }
    console.log(`PHASE7C_BROKER_CLOCK_PATCH=${patch.label}|${apply ? "APPLY" : "NEEDED"}`);
    source = source.replace(patch.before, patch.after);
    changesNeeded += 1;
  }

  if (apply && source !== original) {
    const backup = `${file}.broker-clock.bak`;
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, original, "utf8");
    fs.writeFileSync(file, source, "utf8");
    console.log(`PHASE7C_BROKER_CLOCK_FILE_UPDATED=${file}`);
    console.log(`PHASE7C_BROKER_CLOCK_BACKUP=${backup}`);
  }
}

console.log(`PHASE7C_BROKER_CLOCK_PATCH_ROOT=${root}`);
console.log(`PHASE7C_BROKER_CLOCK_PATCH_MODE=${apply ? "APPLY" : "CHECK_ONLY"}`);
console.log(`PHASE7C_BROKER_CLOCK_CHANGES_NEEDED=${changesNeeded}`);
if (!apply && changesNeeded > 0) {
  console.log("PHASE7C_BROKER_CLOCK_NEXT=node scripts/apply-phase7c-broker-clock-fix-local.mjs --apply");
}
if (apply) {
  console.log("PHASE7C_BROKER_CLOCK_PATCH_RESULT=PASS");
}

function ensureGuardImportNames(source, requiredNames) {
  const pattern = /import\s*\{([^}]*)\}\s*from\s*(["'])\.\/phase7c-sideway-execution-guards\.mjs\2\s*;/g;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`SIDEWAY_IMPORT_CLOCK_HELPERS: expected exactly one guard import block, found ${matches.length}. Refusing to modify ${sidewayPath}.`);
  }

  const match = matches[0];
  const names = match[1]
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!names.includes("evaluateTimestampFreshness") || !names.includes("validateAutoLotSnapshot")) {
    throw new Error("SIDEWAY_IMPORT_CLOCK_HELPERS: guard import is missing required existing exports. Refusing to modify controller.");
  }

  const missing = requiredNames.filter((name) => !names.includes(name));
  if (missing.length === 0) return { source, changed: false };

  const insertionIndex = names.indexOf("evaluateTimestampFreshness") + 1;
  names.splice(insertionIndex, 0, ...missing);
  const quote = match[2];
  const replacement = `import {\n${names.map((name) => `  ${name},`).join("\n")}\n} from ${quote}./phase7c-sideway-execution-guards.mjs${quote};`;
  return {
    source: source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length),
    changed: true,
  };
}

function countOccurrences(source, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = source.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + needle.length;
  }
}
