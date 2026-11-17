const canonicalImport = `import { fetchPhase7CCanonicalDailyRecoveryPlan, registerPhase7CCanonicalDailyRecoverySubmission } from "./phase7c-canonical-daily-recovery-executor.mjs";\n`;

function normalize(source) {
  return String(source).replace(/\r\n?/g, "\n");
}

function replaceSection(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Phase7C ${label} canonical Daily Recovery start marker no longer matches; refusing execution.`);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`Phase7C ${label} canonical Daily Recovery end marker no longer matches; refusing execution.`);
  return source.slice(0, start) + replacement + source.slice(end);
}

function injectBefore(source, marker, injection, label) {
  const index = source.indexOf(marker);
  if (index < 0) throw new Error(`Phase7C ${label} canonical Daily Recovery SEND marker no longer matches; refusing execution.`);
  return source.slice(0, index) + injection + source.slice(index);
}

export function transformPhase7CTrendCanonicalDailyRecoverySource(rawSource) {
  let source = normalize(rawSource);
  source = replaceSection(
    source,
    "async function resolveDailyRecoveryPlan(",
    "\nasync function readPhase7CReversalEntryContext(",
    `async function resolveDailyRecoveryPlan(\n  _quote: Quote,\n  _spec: SymbolSpec,\n) {\n  return fetchPhase7CCanonicalDailyRecoveryPlan({\n    strategy: "TREND",\n    symbol,\n    volume: fixedVolume,\n    fetchImpl: globalThis.fetch,\n  });\n}\n`,
    "Trend planner",
  );
  source = injectBefore(
    source,
    "  const order = await post<OrderResponse>(\"/v1/orders\", {",
    `  registerPhase7CCanonicalDailyRecoverySubmission({\n    strategy: "TREND",\n    clientOrderId: orderId,\n    volume: fixedVolume,\n    plan: dailyRecovery,\n  });\n\n`,
    "Trend",
  );
  return canonicalImport + source;
}

export function transformPhase7CSidewayCanonicalDailyRecoverySource(rawSource) {
  let source = normalize(rawSource);
  source = replaceSection(
    source,
    "async function resolveDailyRecoveryPlan(",
    "\nfunction roundRecoveryPrice(",
    `async function resolveDailyRecoveryPlan(\n  _quote,\n  _spec,\n  volume,\n) {\n  return fetchPhase7CCanonicalDailyRecoveryPlan({\n    strategy: "SIDEWAY",\n    symbol,\n    volume,\n    fetchImpl: globalThis.fetch,\n  });\n}\n`,
    "Sideway planner",
  );
  source = injectBefore(
    source,
    "  const order = await bridgeRequest(\"POST\", \"/v1/orders\", {",
    `  registerPhase7CCanonicalDailyRecoverySubmission({\n    strategy: "SIDEWAY",\n    clientOrderId: orderId,\n    volume,\n    plan: dailyRecovery,\n  });\n\n`,
    "Sideway",
  );
  return canonicalImport + source;
}
