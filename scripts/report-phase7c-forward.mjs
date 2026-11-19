import fs from "node:fs";
import path from "node:path";
import {
  blockedReasonCounts,
  buildEntryRows,
  countByType,
  dedupeAutoDecisions,
  eventTimeMs,
  filterWindow,
  regimeDistribution,
  summarizeClosedPositions,
  summarizeDeals,
} from "./phase7c-forward-report-utils.mjs";

const workDir = path.resolve(requiredEnv("ZIQ_PHASE7C_REPORT_WORK_DIR"));
const fromMs = requiredNumber("ZIQ_PHASE7C_REPORT_FROM_MS");
const toMs = requiredNumber("ZIQ_PHASE7C_REPORT_TO_MS");
const symbol = (process.env.ZIQ_PHASE7C_REPORT_SYMBOL || "XAUUSD").trim().toUpperCase();
const bridgeHost = process.env.MT5_BRIDGE_HOST || "127.0.0.1";
const bridgePort = process.env.MT5_BRIDGE_PORT || "8765";
const apiKey = process.env.MT5_API_KEY || process.env.MT5_BRIDGE_API_KEY || "";
const bridgeBase = `http://${bridgeHost}:${bridgePort}`;
const trendMagic = finiteNumber(process.env.MT5_MAGIC_NUMBER) ?? 270713;
const sidewayMagic = finiteNumber(process.env.ZIQ_PHASE7C_SIDEWAY_MAGIC_NUMBER) ?? 270714;
const ownershipLookbackDays = Math.max(1, Math.min(365, finiteNumber(process.env.ZIQ_PHASE7C_REPORT_OWNERSHIP_LOOKBACK_DAYS) ?? 30));
const ownershipFromMs = Math.max(0, fromMs - ownershipLookbackDays * 24 * 60 * 60 * 1000);

if (!apiKey.trim()) throw new Error("MT5_API_KEY or MT5_BRIDGE_API_KEY is required for forward report.");
if (!(toMs > fromMs)) throw new Error("Report range is invalid: toMs must be greater than fromMs.");

const trendPath = path.join(workDir, "phase7b-demo-forward", "phase7b-demo-events.jsonl");
const sidewayPath = path.join(workDir, "phase7c-sideway-forward", "phase7c-sideway-events.jsonl");
const decisionPath = path.join(workDir, "phase7c-executors", "auto-decisions.jsonl");
const reportDir = path.join(workDir, "phase7c-reports");
fs.mkdirSync(reportDir, { recursive: true });

const health = await bridgeGet("/health");
if (!health?.connected || health?.status !== "ok") throw new Error("MT5 bridge is not healthy/connected for forward report.");
if (String(health?.accountMode ?? "").toLowerCase() !== "demo") {
  throw new Error(`Phase7C forward report is DEMO-only; current accountMode=${health?.accountMode ?? "unknown"}.`);
}

const allTrendRows = readJsonl(trendPath);
const allSidewayRows = readJsonl(sidewayPath);
const allDecisionRows = readJsonl(decisionPath).filter((row) => row?.type === "AUTO_DECISION");
const firstDecision = allDecisionRows
  .filter((row) => eventTimeMs(row) !== null)
  .slice()
  .sort((a, b) => eventTimeMs(a) - eventTimeMs(b))[0] ?? null;
const monitoringBaselineMs = firstDecision ? eventTimeMs(firstDecision) : null;
const monitoringFromMs = monitoringBaselineMs === null ? null : Math.max(fromMs, monitoringBaselineMs);

const rawTrendRows = filterWindow(allTrendRows, fromMs, toMs);
const rawSidewayRows = filterWindow(allSidewayRows, fromMs, toMs);
const rawDecisionRows = filterWindow(allDecisionRows, fromMs, toMs);
const trendRows = monitoringFromMs === null ? [] : filterWindow(allTrendRows, monitoringFromMs, toMs);
const sidewayRows = monitoringFromMs === null ? [] : filterWindow(allSidewayRows, monitoringFromMs, toMs);
const decisionRows = monitoringFromMs === null
  ? []
  : dedupeAutoDecisions(filterWindow(allDecisionRows, monitoringFromMs, toMs));

const deals = await bridgeGet(`/v1/history/deals?fromMs=${ownershipFromMs}&toMs=${toMs}&symbol=${encodeURIComponent(symbol)}`);
if (!Array.isArray(deals)) throw new Error("MT5 deal history did not return an array.");

const rawWindowDealSummary = summarizeDeals(deals, trendMagic, sidewayMagic, { fromMs, toMs });
const monitoredDealSummary = monitoringBaselineMs === null
  ? summarizeDeals([], trendMagic, sidewayMagic)
  : summarizeDeals(deals, trendMagic, sidewayMagic, {
      fromMs,
      toMs,
      positionOpenedAfterMs: monitoringBaselineMs,
    });
const closedTradePerformance = monitoringBaselineMs === null
  ? summarizeClosedPositions([], trendMagic, sidewayMagic)
  : summarizeClosedPositions(deals, trendMagic, sidewayMagic, {
      fromMs,
      toMs,
      positionOpenedAfterMs: monitoringBaselineMs,
    });
const entries = buildEntryRows(trendRows, sidewayRows, decisionRows);
const trendEvents = countByType(trendRows);
const sidewayEvents = countByType(sidewayRows);
const blocks = {
  TREND: blockedReasonCounts(trendRows),
  SIDEWAY: blockedReasonCounts(sidewayRows),
};
const regimes = regimeDistribution(decisionRows);
const windowDeals = deals.filter((deal) => {
  const timestamp = eventTimeMs(deal);
  return deal?.isTradingDeal && timestamp !== null && timestamp >= fromMs && timestamp <= toMs;
});

const report = {
  version: 3,
  generatedAt: Date.now(),
  generatedAtIso: new Date().toISOString(),
  symbol,
  account: {
    login: finiteNumber(health.accountLogin),
    mode: String(health.accountMode),
    server: health.server ?? null,
    currency: health.accountCurrency ?? null,
  },
  range: {
    fromMs,
    fromIso: new Date(fromMs).toISOString(),
    toMs,
    toIso: new Date(toMs).toISOString(),
  },
  monitoring: {
    status: monitoringBaselineMs === null ? "NOT_STARTED" : "ACTIVE",
    baselineMs: monitoringBaselineMs,
    baselineIso: monitoringBaselineMs === null ? null : new Date(monitoringBaselineMs).toISOString(),
    effectiveFromMs: monitoringFromMs,
    effectiveFromIso: monitoringFromMs === null ? null : new Date(monitoringFromMs).toISOString(),
    baselineSource: monitoringBaselineMs === null ? null : "FIRST_AUTO_DECISION",
    rawDecisionRowsInWindow: rawDecisionRows.length,
    deduplicatedDecisionRowsInMonitoredWindow: decisionRows.length,
  },
  sourceFiles: {
    trendJournal: trendPath,
    sidewayJournal: sidewayPath,
    autoDecisionJournal: decisionPath,
  },
  magic: { TREND: trendMagic, SIDEWAY: sidewayMagic },
  entries,
  eventCounts: { TREND: trendEvents, SIDEWAY: sidewayEvents },
  rawWindowEventCounts: {
    TREND: countByType(rawTrendRows),
    SIDEWAY: countByType(rawSidewayRows),
  },
  blockedReasons: blocks,
  regimeDistribution: regimes,
  closedTradePerformance,
  brokerDeals: {
    ownershipLookbackDays,
    ownershipFromMs,
    ownershipFromIso: new Date(ownershipFromMs).toISOString(),
    historyDealsLoaded: deals.length,
    matchedWindowDeals: windowDeals.length,
    summary: monitoredDealSummary,
    rawWindowSummary: rawWindowDealSummary,
  },
  management: {
    TREND: {
      entriesFilled: trendEvents.ENTRY_FILLED ?? 0,
      breakEvenApplied: trendEvents.PLUS6_SL_TO_ENTRY ?? 0,
      partialsFilled: trendEvents.PLUS10_PARTIAL_ONE_THIRD ?? 0,
      structuralStopTightens: trendEvents.STRUCTURAL_SL_TIGHTEN ?? 0,
      explicitExits: trendEvents.EXIT_EXECUTED ?? 0,
      brokerObservedClosures: trendEvents.MANAGED_POSITION_CLOSED ?? 0,
    },
    SIDEWAY: {
      entriesFilled: sidewayEvents.ENTRY_FILLED ?? 0,
      tp1PartialsFilled: sidewayEvents.TP1_PARTIAL_FILLED ?? 0,
      breakEvenApplied: sidewayEvents.TP1_BREAK_EVEN_APPLIED ?? 0,
      explicitExits: sidewayEvents.POSITION_CLOSED ?? 0,
      brokerObservedClosures: sidewayEvents.MANAGED_POSITION_CLOSED ?? 0,
      regimeInvalidations: sidewayEvents.MANAGEMENT_REGIME_INVALIDATION ?? 0,
    },
  },
};

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const jsonPath = path.join(reportDir, `phase7c-forward-${stamp}.json`);
const markdownPath = path.join(reportDir, `phase7c-forward-${stamp}.md`);
fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
fs.writeFileSync(markdownPath, renderMarkdown(report), "utf8");

const monitoredTotal = round(monitoredDealSummary.TREND.netPnl + monitoredDealSummary.SIDEWAY.netPnl, 4);
const rawTotal = round(rawWindowDealSummary.TREND.netPnl + rawWindowDealSummary.SIDEWAY.netPnl, 4);
console.log("PHASE7C_FORWARD_REPORT=PASS");
console.log(`PHASE7C_REPORT_ACCOUNT_LOGIN=${report.account.login}`);
console.log(`PHASE7C_REPORT_ACCOUNT_MODE=${report.account.mode}`);
console.log(`PHASE7C_REPORT_FROM=${report.range.fromIso}`);
console.log(`PHASE7C_REPORT_TO=${report.range.toIso}`);
console.log(`PHASE7C_REPORT_MONITORING_STATUS=${report.monitoring.status}`);
console.log(`PHASE7C_REPORT_MONITORING_BASELINE=${report.monitoring.baselineIso ?? "NONE"}`);
console.log(`PHASE7C_REPORT_AUTO_DECISIONS_RAW=${report.monitoring.rawDecisionRowsInWindow}`);
console.log(`PHASE7C_REPORT_AUTO_DECISIONS=${report.monitoring.deduplicatedDecisionRowsInMonitoredWindow}`);
console.log(`PHASE7C_REPORT_TREND_ENTRIES=${report.management.TREND.entriesFilled}`);
console.log(`PHASE7C_REPORT_SIDEWAY_ENTRIES=${report.management.SIDEWAY.entriesFilled}`);
console.log(`PHASE7C_REPORT_TREND_NET_PNL=${monitoredDealSummary.TREND.netPnl}`);
console.log(`PHASE7C_REPORT_SIDEWAY_NET_PNL=${monitoredDealSummary.SIDEWAY.netPnl}`);
console.log(`PHASE7C_REPORT_TOTAL_NET_PNL=${monitoredTotal}`);
console.log(`PHASE7C_REPORT_TREND_TRADES=${closedTradePerformance.TREND.trades}`);
console.log(`PHASE7C_REPORT_TREND_WINS=${closedTradePerformance.TREND.wins}`);
console.log(`PHASE7C_REPORT_TREND_LOSSES=${closedTradePerformance.TREND.losses}`);
console.log(`PHASE7C_REPORT_TREND_WIN_RATE=${closedTradePerformance.TREND.winRate}`);
console.log(`PHASE7C_REPORT_SIDEWAY_TRADES=${closedTradePerformance.SIDEWAY.trades}`);
console.log(`PHASE7C_REPORT_SIDEWAY_WINS=${closedTradePerformance.SIDEWAY.wins}`);
console.log(`PHASE7C_REPORT_SIDEWAY_LOSSES=${closedTradePerformance.SIDEWAY.losses}`);
console.log(`PHASE7C_REPORT_SIDEWAY_WIN_RATE=${closedTradePerformance.SIDEWAY.winRate}`);
console.log(`PHASE7C_REPORT_RAW_WINDOW_TREND_NET_PNL=${rawWindowDealSummary.TREND.netPnl}`);
console.log(`PHASE7C_REPORT_RAW_WINDOW_SIDEWAY_NET_PNL=${rawWindowDealSummary.SIDEWAY.netPnl}`);
console.log(`PHASE7C_REPORT_RAW_WINDOW_TOTAL_NET_PNL=${rawTotal}`);
console.log(`PHASE7C_REPORT_JSON=${jsonPath}`);
console.log(`PHASE7C_REPORT_MARKDOWN=${markdownPath}`);

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      console.warn(`PHASE7C_REPORT_JSONL_SKIP=${file}|LINE=${index + 1}|ERROR=${errorMessage(error)}`);
    }
  }
  return rows;
}

async function bridgeGet(endpoint) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${bridgeBase}${endpoint}`, {
      method: "GET",
      headers: { "x-mt5-api-key": apiKey, accept: "application/json" },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`MT5 bridge GET ${endpoint} failed ${response.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timeout);
  }
}

function renderMarkdown(value) {
  const monitoredTrend = value.brokerDeals.summary.TREND;
  const monitoredSideway = value.brokerDeals.summary.SIDEWAY;
  const rawTrend = value.brokerDeals.rawWindowSummary.TREND;
  const rawSideway = value.brokerDeals.rawWindowSummary.SIDEWAY;
  const tradeTrend = value.closedTradePerformance.TREND;
  const tradeSideway = value.closedTradePerformance.SIDEWAY;
  const monitoredTotal = round(monitoredTrend.netPnl + monitoredSideway.netPnl, 4);
  const rawTotal = round(rawTrend.netPnl + rawSideway.netPnl, 4);
  const lines = [
    "# Phase7C Forward DEMO Report",
    "",
    `- Generated: ${value.generatedAtIso}`,
    `- Report window: ${value.range.fromIso} → ${value.range.toIso}`,
    `- Monitoring baseline: ${value.monitoring.baselineIso ?? "not started"}`,
    `- Symbol: ${value.symbol}`,
    `- Account: ${value.account.login ?? "n/a"} · ${value.account.mode} · ${value.account.server ?? "n/a"}`,
    `- AUTO decisions: ${value.monitoring.deduplicatedDecisionRowsInMonitoredWindow} deduplicated / ${value.monitoring.rawDecisionRowsInWindow} raw in report window`,
    `- Deal ownership lookback: ${value.brokerDeals.ownershipLookbackDays} days (ownership resolution only)`,
    "",
    "## Phase7C monitored P/L",
    "",
    "Only positions opened at or after the monitoring baseline are eligible for this forward-performance table.",
    "",
    "| Strategy | Deals in report window | Entry deals | Exit deals | Net P/L |",
    "|---|---:|---:|---:|---:|",
    `| TREND | ${monitoredTrend.deals} | ${monitoredTrend.entryDeals} | ${monitoredTrend.exitDeals} | ${monitoredTrend.netPnl} |`,
    `| SIDEWAY | ${monitoredSideway.deals} | ${monitoredSideway.entryDeals} | ${monitoredSideway.exitDeals} | ${monitoredSideway.netPnl} |`,
    `| TOTAL | ${monitoredTrend.deals + monitoredSideway.deals} | ${monitoredTrend.entryDeals + monitoredSideway.entryDeals} | ${monitoredTrend.exitDeals + monitoredSideway.exitDeals} | ${monitoredTotal} |`,
    "",
    "## Closed trade performance",
    "",
    "A trade is counted once only after its full position volume is closed. Sideway partial exits remain part of the same trade.",
    "",
    "| Strategy | Trades | Wins | Losses | BE | Win rate | Net P/L | Profit factor |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    `| TREND | ${tradeTrend.trades} | ${tradeTrend.wins} | ${tradeTrend.losses} | ${tradeTrend.breakeven} | ${tradeTrend.winRate}% | ${tradeTrend.netPnl} | ${formatProfitFactor(tradeTrend.profitFactor, tradeTrend)} |`,
    `| SIDEWAY | ${tradeSideway.trades} | ${tradeSideway.wins} | ${tradeSideway.losses} | ${tradeSideway.breakeven} | ${tradeSideway.winRate}% | ${tradeSideway.netPnl} | ${formatProfitFactor(tradeSideway.profitFactor, tradeSideway)} |`,
    "",
    "## Raw broker-window P/L (diagnostic, not Phase7C forward performance)",
    "",
    "This table may include legacy trades opened before Phase7C monitoring began.",
    "",
    "| Strategy | Deals | Net P/L |",
    "|---|---:|---:|",
    `| TREND | ${rawTrend.deals} | ${rawTrend.netPnl} |`,
    `| SIDEWAY | ${rawSideway.deals} | ${rawSideway.netPnl} |`,
    `| TOTAL | ${rawTrend.deals + rawSideway.deals} | ${rawTotal} |`,
    "",
    "## Management since monitoring baseline",
    "",
    `- Trend entries: ${value.management.TREND.entriesFilled}; BE: ${value.management.TREND.breakEvenApplied}; partial +10: ${value.management.TREND.partialsFilled}; structural tighten: ${value.management.TREND.structuralStopTightens}.`,
    `- Sideway entries: ${value.management.SIDEWAY.entriesFilled}; TP1 partial: ${value.management.SIDEWAY.tp1PartialsFilled}; BE: ${value.management.SIDEWAY.breakEvenApplied}; regime invalidation: ${value.management.SIDEWAY.regimeInvalidations}.`,
    "",
    "## Regime observations (deduplicated)",
    "",
    ...objectBullets(value.regimeDistribution.regime),
    "",
    "## Trend block reasons",
    "",
    ...objectBullets(value.blockedReasons.TREND),
    "",
    "## Sideway block reasons",
    "",
    ...objectBullets(value.blockedReasons.SIDEWAY),
    "",
    "## Recent closed trades",
    "",
  ];

  if (value.closedTradePerformance.rows.length === 0) {
    lines.push("No monitored closed trades in this report window.");
  } else {
    lines.push("| Closed | Strategy | Position | Opened volume | Net P/L |", "|---|---|---|---:|---:|");
    for (const trade of value.closedTradePerformance.rows.slice(0, 20)) {
      lines.push(`| ${trade.closedAtIso} | ${trade.strategy} | ${trade.positionId} | ${trade.openedVolume} | ${trade.netPnl} |`);
    }
  }

  lines.push("", "## Entries with nearest AUTO decision snapshot", "");
  if (value.entries.length === 0) {
    lines.push("No monitored filled entries in this report window.");
  } else {
    lines.push("| Time | Strategy | Side | Volume | Entry | Regime | Recommended | Confidence |", "|---|---|---|---:|---:|---|---|---:|");
    for (const entry of value.entries) {
      lines.push(`| ${entry.timestampIso} | ${entry.strategy} | ${entry.side} | ${entry.volume ?? "n/a"} | ${entry.entryPrice ?? "n/a"} | ${entry.regime ?? "n/a"} | ${entry.recommendedMode ?? "n/a"} | ${entry.confidence ?? "n/a"} |`);
    }
  }

  lines.push("", "Monitored P/L is sourced from MT5 deal history but excludes positions opened before the first AUTO_DECISION baseline. Raw broker-window P/L is retained only for reconciliation. Closed-trade win/loss statistics are position-based, so partial exits are never counted as separate trades. Position ownership is resolved from opening deals before deal-window filtering, so bridge close magic cannot reassign Sideway P/L to Trend. AUTO decision telemetry is deduplicated for analytics while the raw JSONL journal remains unchanged for audit.", "");
  return lines.join("\n");
}

function formatProfitFactor(value, summary) {
  if (value !== null && value !== undefined) return String(value);
  return summary?.grossProfit > 0 && summary?.grossLoss === 0 ? "∞" : "n/a";
}

function objectBullets(object) {
  const entries = Object.entries(object ?? {});
  return entries.length > 0 ? entries.map(([key, value]) => `- ${key}: ${value}`) : ["- None"];
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env ${name}`);
  return value;
}

function requiredNumber(name) {
  const value = Number(requiredEnv(name));
  if (!Number.isFinite(value)) throw new Error(`${name} must be numeric.`);
  return value;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
