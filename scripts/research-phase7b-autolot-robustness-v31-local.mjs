import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const inputDir = path.join(root, ".runtime", "phase7b-autolot-research-v30");
const outDir = path.join(root, ".runtime", "phase7b-autolot-research-v31");
const reportPath = path.join(inputDir, "report.json");
const tradesPath = path.join(inputDir, "canonical-trades.csv");

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const raw = arg.replace(/^--/, "");
  const i = raw.indexOf("=");
  return i >= 0 ? [raw.slice(0, i), raw.slice(i + 1)] : [raw, "true"];
}));

const riskPercents = String(args.risks ?? "0.05,0.075,0.10,0.125,0.15,0.175,0.20")
  .split(",")
  .map((v) => Number(v.trim()))
  .filter((v) => Number.isFinite(v) && v > 0 && v <= 1);
const folds = clampInt(Number(args.folds ?? 6), 3, 12);
if (!riskPercents.length) throw new Error("No valid --risks values.");
if (!fs.existsSync(reportPath) || !fs.existsSync(tradesPath)) {
  throw new Error("V31 requires V30 report.json and canonical-trades.csv. Run V30 first.");
}

const v30 = JSON.parse(fs.readFileSync(reportPath, "utf8"));
if (v30?.version !== 30 || v30?.safety?.executionMutation !== false || v30?.safety?.realAccountAllowed !== false) {
  throw new Error("V30 report safety/version contract is invalid.");
}
const startingBalance = Number(v30.account?.startingBalance);
const cashPerPriceUnitPerLot = Number(v30.broker?.cashPerPriceUnitPerLot);
const minVolume = Number(v30.broker?.minVolume);
const volumeStep = Number(v30.broker?.volumeStep);
const brokerMaxVolume = Number(v30.broker?.maxVolume);
const maxAutoLot = Number(v30.configuration?.maxAutoLot ?? 1.5);
const fixedLot = Number(v30.configuration?.fixedLot ?? 0.03);
if (![startingBalance, cashPerPriceUnitPerLot, minVolume, volumeStep, brokerMaxVolume, maxAutoLot, fixedLot]
  .every((v) => Number.isFinite(v) && v > 0)) {
  throw new Error("Invalid V30 broker/account configuration.");
}

const schedule = parseCsv(fs.readFileSync(tradesPath, "utf8"))
  .map((row) => ({
    entryTime: Date.parse(row.entryTime),
    side: row.side,
    pattern: row.pattern,
    stopDistance: Number(row.stopDistance),
    pnl: Number(row.pnlFixed003),
  }))
  .filter((t) => Number.isFinite(t.entryTime) && Number.isFinite(t.stopDistance) && Number.isFinite(t.pnl))
  .sort((a, b) => a.entryTime - b.entryTime);
if (schedule.length < 30) throw new Error(`Insufficient V30 canonical schedule: ${schedule.length}.`);

const minTime = schedule[0].entryTime;
const maxTime = schedule.at(-1).entryTime + 1;
const span = maxTime - minTime;
const foldRows = [];
const laneNames = ["FIXED_0.03", ...riskPercents.map((r) => laneName(r))];
const foldSummaries = new Map(laneNames.map((name) => [name, []]));

for (let fold = 0; fold < folds; fold += 1) {
  const from = minTime + span * fold / folds;
  const to = fold === folds - 1 ? maxTime + 1 : minTime + span * (fold + 1) / folds;
  const trades = schedule.filter((t) => t.entryTime >= from && t.entryTime < to);
  if (!trades.length) continue;

  const fixed = applyFixed(trades, startingBalance);
  const autos = riskPercents.map((risk) => applyAuto(trades, startingBalance, risk));
  for (const lane of [fixed, ...autos]) {
    foldSummaries.get(lane.name).push(lane.metrics);
    foldRows.push({
      Fold: fold + 1,
      From: new Date(from).toISOString().slice(0, 10),
      To: new Date(to).toISOString().slice(0, 10),
      Lane: lane.name,
      Trades: lane.metrics.trades,
      Blocked: lane.metrics.blockedTrades,
      NetPnl: lane.metrics.netPnl,
      ProfitFactor: lane.metrics.profitFactor,
      Expectancy: lane.metrics.expectancy,
      MaxDDPct: lane.metrics.maxDrawdownPercent,
      WorstLossStreak: lane.metrics.worstLosingStreak,
      AvgLot: lane.metrics.averageLot,
      MaxLot: lane.metrics.maxLot,
    });
  }
}

const fullLanes = [applyFixed(schedule, startingBalance), ...riskPercents.map((risk) => applyAuto(schedule, startingBalance, risk))];
validateAgainstV30(fullLanes, v30);

const robustnessRows = fullLanes.map((lane) => {
  const rows = foldSummaries.get(lane.name) ?? [];
  const profitable = rows.filter((m) => m.netPnl > 0).length;
  const pfAbove1 = rows.filter((m) => Number(m.profitFactor ?? 0) > 1).length;
  const positiveExpectancy = rows.filter((m) => m.expectancy > 0).length;
  const foldNet = rows.map((m) => m.netPnl);
  const foldDd = rows.map((m) => m.maxDrawdownPercent);
  const medianNet = median(foldNet);
  const worstFoldNet = foldNet.length ? Math.min(...foldNet) : 0;
  const worstFoldDd = foldDd.length ? Math.max(...foldDd) : 0;
  const verdict = verdictFor({ lane, rows, profitable, medianNet, worstFoldDd });
  return {
    Lane: lane.name,
    FullNetPnl: lane.metrics.netPnl,
    FullPF: lane.metrics.profitFactor,
    FullExpectancy: lane.metrics.expectancy,
    FullMaxDDPct: lane.metrics.maxDrawdownPercent,
    ProfitableFolds: `${profitable}/${rows.length}`,
    PFGt1Folds: `${pfAbove1}/${rows.length}`,
    PositiveExpFolds: `${positiveExpectancy}/${rows.length}`,
    MedianFoldPnl: round(medianNet, 2),
    WorstFoldPnl: round(worstFoldNet, 2),
    WorstFoldDDPct: round(worstFoldDd, 4),
    AvgLot: lane.metrics.averageLot,
    MaxLot: lane.metrics.maxLot,
    Verdict: verdict,
  };
});

console.log(`PHASE7B_V31_SOURCE_TRADES=${schedule.length}`);
console.log(`PHASE7B_V31_FOLDS=${folds}`);
console.log(`PHASE7B_V31_RISKS=${riskPercents.join(",")}`);
console.log("PHASE7B_V31_CAPITAL_RESET_PER_FOLD=True");
console.log("PHASE7B_V31_COMPOUNDING_WITHIN_FOLD=REALIZED_BALANCE_ONLY");
console.log("PHASE7B_V31_DRAWDOWN_THROTTLE=2PCT_0.75|4PCT_0.50|6PCT_BLOCK");
console.log("PHASE7B_V31_EXECUTION_MUTATION=False");
console.log("PHASE7B_V31_REAL_ACCOUNT_ALLOWED=False");
console.log("\n=== V31 ROBUSTNESS SUMMARY ===\n");
console.table(robustnessRows);
console.log("\n=== V31 FOLD DETAILS ===\n");
console.table(foldRows);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "robustness-summary.csv"), toCsv(robustnessRows), "utf8");
fs.writeFileSync(path.join(outDir, "fold-details.csv"), toCsv(foldRows), "utf8");
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify({
  version: 31,
  generatedAt: new Date().toISOString(),
  safety: { readOnly: true, executionMutation: false, realAccountAllowed: false },
  source: { v30Report: reportPath, v30Trades: tradesPath, canonicalTrades: schedule.length },
  configuration: { folds, riskPercents, startingBalance, maxAutoLot, fixedLot, drawdownThrottle: "DD<2%=1|2-4%=0.75|4-6%=0.50|>=6%=BLOCK" },
  robustnessRows,
  foldRows,
}, null, 2), "utf8");
console.log(`\nPHASE7B_V31_OUTPUT_DIR=${outDir}`);
console.log("PHASE7B_V31=PASS");

function verdictFor({ lane, rows, profitable, medianNet, worstFoldDd }) {
  const full = lane.metrics;
  if (!rows.length) return "INSUFFICIENT";
  if (!(full.netPnl > 0) || !(Number(full.profitFactor ?? 0) > 1)) return "REJECT";
  if (profitable < Math.ceil(rows.length * 2 / 3) || medianNet <= 0) return "NOT_ROBUST";
  if (Number(full.profitFactor ?? 0) < 1.05 || worstFoldDd > 3) return "WATCH_ONLY";
  return "SHADOW_CANDIDATE";
}

function validateAgainstV30(lanes, report) {
  const expected = [report.fixed, ...(Array.isArray(report.auto) ? report.auto : [])];
  for (const lane of lanes) {
    const match = expected.find((x) => x?.name === lane.name);
    if (!match) continue;
    const netDelta = Math.abs(Number(match.metrics?.netPnl) - lane.metrics.netPnl);
    const ddDelta = Math.abs(Number(match.metrics?.maxDrawdownPercent) - lane.metrics.maxDrawdownPercent);
    if (netDelta > 0.5 || ddDelta > 0.05) {
      throw new Error(`V31 reproduction mismatch ${lane.name}: netDelta=${netDelta}, ddDelta=${ddDelta}`);
    }
  }
}

function applyFixed(trades, starting) {
  const rows = trades.map((t) => ({ lot: fixedLot, pnl: round(t.pnl, 2), blocked: false }));
  return summarize("FIXED_0.03", null, starting, rows);
}

function applyAuto(trades, starting, riskPercent) {
  let balance = starting;
  let peak = starting;
  const rows = [];
  for (const t of trades) {
    const ddPct = peak > 0 ? (peak - balance) / peak * 100 : 0;
    const throttle = ddPct >= 6 ? 0 : ddPct >= 4 ? 0.5 : ddPct >= 2 ? 0.75 : 1;
    if (throttle === 0) {
      rows.push({ lot: 0, pnl: 0, blocked: true });
      continue;
    }
    const targetRiskUsd = balance * riskPercent / 100 * throttle;
    const oneLotRisk = t.stopDistance * cashPerPriceUnitPerLot;
    const rawLot = oneLotRisk > 0 ? targetRiskUsd / oneLotRisk : 0;
    const cap = Math.min(rawLot, maxAutoLot, brokerMaxVolume);
    const lot = canonicalCompatibleLot(cap, minVolume, volumeStep);
    if (!(lot >= minVolume - 1e-9)) {
      rows.push({ lot: 0, pnl: 0, blocked: true });
      continue;
    }
    const pnl = round(t.pnl * lot / fixedLot, 2);
    balance += pnl;
    peak = Math.max(peak, balance);
    rows.push({ lot, pnl, blocked: false });
  }
  return summarize(laneName(riskPercent), riskPercent, starting, rows);
}

function summarize(name, riskPercent, starting, rows) {
  let balance = starting;
  let peak = starting;
  let maxDdUsd = 0;
  let maxDdPct = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let losing = 0;
  let worstLosing = 0;
  let blocked = 0;
  let executed = 0;
  let net = 0;
  const lots = [];
  for (const row of rows) {
    if (row.blocked) { blocked += 1; continue; }
    const pnl = Number(row.pnl ?? 0);
    executed += 1;
    net += pnl;
    balance += pnl;
    peak = Math.max(peak, balance);
    const dd = peak - balance;
    const ddPct = peak > 0 ? dd / peak * 100 : 0;
    maxDdUsd = Math.max(maxDdUsd, dd);
    maxDdPct = Math.max(maxDdPct, ddPct);
    if (pnl > 0) { grossProfit += pnl; losing = 0; }
    else if (pnl < 0) { grossLoss += -pnl; losing += 1; worstLosing = Math.max(worstLosing, losing); }
    lots.push(Number(row.lot ?? 0));
  }
  const pf = grossLoss > 0 ? grossProfit / grossLoss : null;
  return {
    name,
    riskPercent,
    metrics: {
      trades: executed,
      blockedTrades: blocked,
      netPnl: round(net, 2),
      endingBalance: round(starting + net, 2),
      profitFactor: pf === null ? null : round(pf, 4),
      expectancy: round(executed ? net / executed : 0, 4),
      maxDrawdownUsd: round(maxDdUsd, 2),
      maxDrawdownPercent: round(maxDdPct, 4),
      worstLosingStreak: worstLosing,
      averageLot: round(avg(lots), 4),
      minLot: lots.length ? round(Math.min(...lots), 4) : 0,
      maxLot: lots.length ? round(Math.max(...lots), 4) : 0,
    },
  };
}

function canonicalCompatibleLot(cap, min, step) {
  if (!(cap > 0)) return 0;
  const minUnits = Math.max(1, Math.ceil((min - 1e-12) / step));
  let units = Math.floor((cap + 1e-12) / step);
  while (units >= minUnits * 3) {
    if (units % 3 === 0 && units / 3 >= minUnits && (units * 2) / 3 >= minUnits) return round(units * step, 8);
    units -= 1;
  }
  return 0;
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((x) => x.length);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ""]));
  });
}
function parseCsvLine(line) {
  const out = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i += 1; }
      else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      out.push(current); current = "";
    } else current += ch;
  }
  out.push(current);
  return out;
}
function laneName(risk) { return `AUTO_${risk.toFixed(risk % 0.01 === 0 ? 2 : 3)}PCT`; }
function avg(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function median(a) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function round(v, d) { const f = 10 ** d; return Math.round((v + Number.EPSILON) * f) / f; }
function clampInt(v, min, max) { if (!Number.isFinite(v)) return min; return Math.max(min, Math.min(max, Math.round(v))); }
function toCsv(rows) {
  if (!rows.length) return "";
  const keys = Object.keys(rows[0]);
  const esc = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [keys.join(","), ...rows.map((r) => keys.map((k) => esc(r[k])).join(","))].join("\r\n") + "\r\n";
}
