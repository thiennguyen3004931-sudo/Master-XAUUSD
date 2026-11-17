import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const input = path.join(root, ".runtime", "phase7b-autolot-research-v30", "canonical-trades.csv");
const outDir = path.join(root, ".runtime", "phase7b-regime-diagnostics-v32");
if (!fs.existsSync(input)) throw new Error("Missing V30 canonical-trades.csv. Run V30 first.");

const trades = parseCsv(fs.readFileSync(input, "utf8"))
  .map((r) => ({
    entryTime: Date.parse(r.entryTime),
    side: String(r.side),
    pattern: String(r.pattern),
    stopDistance: Number(r.stopDistance),
    pnl: Number(r.pnlFixed003),
    exitReason: String(r.exitReason),
    partialApplied: String(r.partialApplied).toLowerCase() === "true",
  }))
  .filter((t) => Number.isFinite(t.entryTime) && Number.isFinite(t.stopDistance) && Number.isFinite(t.pnl))
  .sort((a, b) => a.entryTime - b.entryTime);
if (!trades.length) throw new Error("No canonical trades parsed.");

const midpoint = Date.parse("2026-05-16T00:00:00Z");
const early = trades.filter((t) => t.entryTime < midpoint);
const late = trades.filter((t) => t.entryTime >= midpoint);

console.log(`PHASE7B_V32_SOURCE_TRADES=${trades.length}`);
console.log(`PHASE7B_V32_EARLY_TRADES=${early.length}`);
console.log(`PHASE7B_V32_LATE_TRADES=${late.length}`);
console.log("PHASE7B_V32_EXECUTION_MUTATION=False");
console.log("PHASE7B_V32_REAL_ACCOUNT_ALLOWED=False");

const monthly = groupSummary(trades, (t) => new Date(t.entryTime).toISOString().slice(0, 7));
const side = groupSummary(trades, (t) => t.side);
const pattern = groupSummary(trades, (t) => t.pattern);
const stopBucket = groupSummary(trades, (t) => t.stopDistance <= 6.000001 ? "SL_6" : t.stopDistance <= 8 ? "SL_GT6_TO_8" : "SL_GT8_TO_10");
const exitReason = groupSummary(trades, (t) => t.exitReason);
const partial = groupSummary(trades, (t) => t.partialApplied ? "PARTIAL_PLUS10" : "NO_PARTIAL_PLUS10");
const earlyLate = [summaryRow("EARLY_BEFORE_2026_05_16", early), summaryRow("LATE_FROM_2026_05_16", late)];
const contributionShift = buildShiftRows(early, late);

console.log("\n=== V32 EARLY VS LATE ===\n");
console.table(earlyLate);
console.log("\n=== V32 MONTHLY ===\n");
console.table(monthly);
console.log("\n=== V32 BY SIDE ===\n");
console.table(side);
console.log("\n=== V32 BY PATTERN ===\n");
console.table(pattern);
console.log("\n=== V32 BY STOP BUCKET ===\n");
console.table(stopBucket);
console.log("\n=== V32 BY EXIT REASON ===\n");
console.table(exitReason);
console.log("\n=== V32 BY PLUS10 PARTIAL ===\n");
console.table(partial);
console.log("\n=== V32 CONTRIBUTION SHIFT EARLY -> LATE ===\n");
console.table(contributionShift);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "early-vs-late.csv"), toCsv(earlyLate), "utf8");
fs.writeFileSync(path.join(outDir, "monthly.csv"), toCsv(monthly), "utf8");
fs.writeFileSync(path.join(outDir, "side.csv"), toCsv(side), "utf8");
fs.writeFileSync(path.join(outDir, "pattern.csv"), toCsv(pattern), "utf8");
fs.writeFileSync(path.join(outDir, "stop-bucket.csv"), toCsv(stopBucket), "utf8");
fs.writeFileSync(path.join(outDir, "exit-reason.csv"), toCsv(exitReason), "utf8");
fs.writeFileSync(path.join(outDir, "partial.csv"), toCsv(partial), "utf8");
fs.writeFileSync(path.join(outDir, "contribution-shift.csv"), toCsv(contributionShift), "utf8");
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify({
  version: 32,
  generatedAt: new Date().toISOString(),
  safety: { readOnly: true, executionMutation: false, realAccountAllowed: false },
  sourceTrades: trades.length,
  split: "2026-05-16T00:00:00Z",
  earlyLate,
  monthly,
  side,
  pattern,
  stopBucket,
  exitReason,
  partial,
  contributionShift,
}, null, 2), "utf8");

console.log(`\nPHASE7B_V32_OUTPUT_DIR=${outDir}`);
console.log("PHASE7B_V32=PASS");

function buildShiftRows(a, b) {
  const dimensions = [
    ["SIDE", (t) => t.side],
    ["PATTERN", (t) => t.pattern],
    ["STOP", (t) => t.stopDistance <= 6.000001 ? "SL_6" : t.stopDistance <= 8 ? "SL_GT6_TO_8" : "SL_GT8_TO_10"],
    ["EXIT", (t) => t.exitReason],
    ["PARTIAL", (t) => t.partialApplied ? "PARTIAL_PLUS10" : "NO_PARTIAL_PLUS10"],
  ];
  const rows = [];
  for (const [dim, keyFn] of dimensions) {
    const ga = mapGroups(a, keyFn);
    const gb = mapGroups(b, keyFn);
    const keys = [...new Set([...ga.keys(), ...gb.keys()])].sort();
    for (const key of keys) {
      const sa = metrics(ga.get(key) ?? []);
      const sb = metrics(gb.get(key) ?? []);
      rows.push({
        Dimension: dim,
        Group: key,
        EarlyTrades: sa.Trades,
        EarlyNetPnl: sa.NetPnl,
        EarlyPF: sa.ProfitFactor,
        LateTrades: sb.Trades,
        LateNetPnl: sb.NetPnl,
        LatePF: sb.ProfitFactor,
        NetShift: round(sb.NetPnl - sa.NetPnl, 2),
        Verdict: shiftVerdict(sa, sb),
      });
    }
  }
  return rows.sort((x, y) => x.NetShift - y.NetShift);
}

function shiftVerdict(a, b) {
  if (a.Trades < 10 || b.Trades < 10) return "LOW_SAMPLE";
  if (a.NetPnl > 0 && b.NetPnl < 0) return "DEGRADED_TO_NEGATIVE";
  if (Number(a.ProfitFactor ?? 0) >= 1 && Number(b.ProfitFactor ?? 0) < 1) return "PF_BROKE_BELOW_1";
  if (b.NetPnl < a.NetPnl * 0.5) return "MATERIAL_DEGRADATION";
  if (b.NetPnl > a.NetPnl) return "IMPROVED";
  return "STABLE_OR_MIXED";
}

function groupSummary(rows, keyFn) {
  return [...mapGroups(rows, keyFn).entries()]
    .map(([key, items]) => ({ Group: key, ...metrics(items) }))
    .sort((a, b) => b.NetPnl - a.NetPnl);
}
function mapGroups(rows, keyFn) {
  const m = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(row);
  }
  return m;
}
function summaryRow(label, rows) { return { Group: label, ...metrics(rows) }; }
function metrics(rows) {
  let grossProfit = 0, grossLoss = 0, wins = 0, losses = 0, net = 0, peak = 0, cumulative = 0, maxDd = 0;
  for (const r of rows) {
    const p = Number(r.pnl);
    net += p;
    cumulative += p;
    peak = Math.max(peak, cumulative);
    maxDd = Math.max(maxDd, peak - cumulative);
    if (p > 0) { grossProfit += p; wins += 1; }
    else if (p < 0) { grossLoss += -p; losses += 1; }
  }
  const pf = grossLoss > 0 ? grossProfit / grossLoss : null;
  return {
    Trades: rows.length,
    Wins: wins,
    Losses: losses,
    WinRatePct: round(rows.length ? wins / rows.length * 100 : 0, 2),
    NetPnl: round(net, 2),
    ProfitFactor: pf === null ? null : round(pf, 4),
    Expectancy: round(rows.length ? net / rows.length : 0, 4),
    MaxDDUsd: round(maxDd, 2),
  };
}
function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const vals = parseCsvLine(line);
    return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? ""]));
  });
}
function parseCsvLine(line) {
  const out = []; let cur = ""; let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i += 1; }
      else quoted = !quoted;
    } else if (ch === "," && !quoted) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur); return out;
}
function round(v, d) { const f = 10 ** d; return Math.round((v + Number.EPSILON) * f) / f; }
function toCsv(rows) {
  if (!rows.length) return "";
  const keys = Object.keys(rows[0]);
  const esc = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [keys.join(","), ...rows.map((r) => keys.map((k) => esc(r[k])).join(","))].join("\r\n") + "\r\n";
}
