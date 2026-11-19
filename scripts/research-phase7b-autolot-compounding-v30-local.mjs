import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const bridgeEnv = path.join(root, "packages", "mt5-broker", "bridge", ".env.phase7b-demo");
const outDir = path.join(root, ".runtime", "phase7b-autolot-research-v30");
const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const raw = arg.replace(/^--/, "");
  const i = raw.indexOf("=");
  return i >= 0 ? [raw.slice(0, i), raw.slice(i + 1)] : [raw, "true"];
}));
const days = clampInt(Number(args.days ?? 180), 30, 370);
const maxAutoLot = finitePositive(Number(args.maxLot ?? 1.5), "maxLot");
const fixedLot = 0.03;
const riskPercents = String(args.risks ?? "0.10,0.15,0.20")
  .split(",")
  .map((v) => Number(v.trim()))
  .filter((v) => Number.isFinite(v) && v > 0 && v <= 1);
if (riskPercents.length === 0) throw new Error("No valid --risks values. Example --risks=0.10,0.15,0.20");

loadEnvFile(bridgeEnv);
const host = process.env.MT5_BRIDGE_HOST ?? "127.0.0.1";
const port = process.env.MT5_BRIDGE_PORT ?? "8765";
const apiKey = String(process.env.MT5_API_KEY ?? "").trim();
if (apiKey.length < 16) throw new Error("MT5_API_KEY unavailable in DEMO bridge env.");
const base = `http://${host}:${port}`;

const [health, quote, spec] = await Promise.all([
  getJson("/health", 10_000),
  getJson("/v1/quotes/XAUUSD", 10_000),
  getJson("/v1/symbols/XAUUSD/spec", 10_000),
]);
if (!health.connected || health.accountMode !== "demo") throw new Error(`V30 requires connected DEMO, got ${health.accountMode ?? "unknown"}.`);
const startingBalance = Number(args.startingBalance ?? health.accountBalance);
if (!(startingBalance > 0)) throw new Error("Starting balance unavailable.");
const cashPerPriceUnitPerLot = Number(spec.cashPerPriceUnitPerLot) > 0
  ? Number(spec.cashPerPriceUnitPerLot)
  : Number(spec.tickSize) > 0 ? Number(spec.effectiveTickValuePerLot) / Number(spec.tickSize) : 0;
if (!(cashPerPriceUnitPerLot > 0)) throw new Error("Invalid broker cashPerPriceUnitPerLot.");
const minVolume = finitePositive(Number(spec.minVolume), "minVolume");
const volumeStep = finitePositive(Number(spec.volumeStep), "volumeStep");
const brokerMaxVolume = finitePositive(Number(spec.maxVolume), "maxVolume");
const toMs = Number(quote.timestamp) + 60_000;
if (!Number.isFinite(toMs)) throw new Error("Broker quote timestamp unavailable.");
const fromMs = toMs - days * 86_400_000;
const warmupFromMs = fromMs - 45 * 86_400_000;

console.log(`PHASE7B_V30_ACCOUNT_LOGIN=${health.accountLogin}`);
console.log(`PHASE7B_V30_ACCOUNT_MODE=${health.accountMode}`);
console.log(`PHASE7B_V30_SERVER=${health.server}`);
console.log(`PHASE7B_V30_STARTING_BALANCE=${round(startingBalance, 2)}`);
console.log(`PHASE7B_V30_DAYS=${days}`);
console.log(`PHASE7B_V30_RISKS=${riskPercents.join(",")}`);
console.log(`PHASE7B_V30_MAX_AUTO_LOT=${maxAutoLot}`);
console.log("PHASE7B_V30_ENTRY=3_PATTERNS_PLUS_SUPERTREND_M15_M5_10_3");
console.log("PHASE7B_V30_THREE_CANDLE=B_LT_A_AND_B_PLUS_C_LE_A_AND_B_PLUS_C_PLUS_D_GT_A");
console.log("PHASE7B_V30_INITIAL_SL=STRUCTURE_LT6_NORMALIZE6_GT10_BLOCK");
console.log("PHASE7B_V30_MANAGEMENT=PLUS6_BE_PLUS10_ONE_THIRD_STRUCTURE_RUNNER");
console.log("PHASE7B_V30_RUNNER_EXIT=M15_SUPERTREND_FLIP_APPROX");
console.log("PHASE7B_V30_FVG_ENTRY_GATE=False");
console.log("PHASE7B_V30_RECOVERY_LOT_ESCALATION=False");
console.log("PHASE7B_V30_EXECUTION_MUTATION=False");
console.log("PHASE7B_V30_REAL_ACCOUNT_ALLOWED=False");

const [m15Raw, m5Raw] = await Promise.all([
  getJson(`/v1/history/candles/XAUUSD?timeframe=M15&fromMs=${Math.round(warmupFromMs)}&toMs=${Math.round(toMs)}`, 60_000),
  getJson(`/v1/history/candles/XAUUSD?timeframe=M5&fromMs=${Math.round(warmupFromMs)}&toMs=${Math.round(toMs)}`, 90_000),
]);
const m15 = [...m15Raw].sort((a, b) => a.openTime - b.openTime);
const m5 = [...m5Raw].sort((a, b) => a.openTime - b.openTime);
if (m15.length < 200 || m5.length < 50) throw new Error(`Insufficient history M15=${m15.length}, M5=${m5.length}.`);
const st15 = supertrend(m15, 10, 3);
const st5 = supertrend(m5, 10, 3);
const m5CloseTimes = m5.map((b) => b.closeTime);
const m15CloseTimes = m15.map((b) => b.closeTime);
const swingsBuy = buildSwings(m15, "BUY");
const swingsSell = buildSwings(m15, "SELL");

const candidates = [];
const blocked = { structuralOver10: 0, noM5: 0, stMismatch: 0, invalidStructure: 0 };
for (let i = 20; i < m15.length; i += 1) {
  const bar = m15[i];
  if (bar.closeTime < fromMs || bar.closeTime >= toMs) continue;
  const pattern = detectPattern(m15, i);
  if (!pattern) continue;
  const dir15 = st15.direction[i];
  if (dir15 !== pattern.side) { blocked.stMismatch += 1; continue; }
  const m5Index = upperBound(m5CloseTimes, bar.closeTime) - 1;
  if (m5Index < 0) { blocked.noM5 += 1; continue; }
  if (st5.direction[m5Index] !== pattern.side) { blocked.stMismatch += 1; continue; }
  const structural = pattern.side === "BUY" ? bar.close - pattern.extreme : pattern.extreme - bar.close;
  if (!(structural > 0)) { blocked.invalidStructure += 1; continue; }
  if (structural > 10 + 1e-9) { blocked.structuralOver10 += 1; continue; }
  const stopDistance = Math.max(6, structural);
  candidates.push({
    side: pattern.side,
    pattern: pattern.pattern,
    signalTimestamp: bar.closeTime,
    stopDistance,
    structuralStopDistance: structural,
    m15Index: i,
  });
}

const rawTrades = candidates
  .map((signal) => simulateTrade(signal))
  .filter(Boolean)
  .sort((a, b) => a.signalTimestamp - b.signalTimestamp);
const trades = [];
let busyUntil = -Infinity;
let skippedWhileOpen = 0;
for (const trade of rawTrades) {
  if (trade.signalTimestamp < busyUntil) { skippedWhileOpen += 1; continue; }
  trades.push(trade);
  busyUntil = trade.exitTime;
}
if (trades.length === 0) throw new Error("V30 produced zero canonical research trades.");

const fixed = applyFixed(trades, startingBalance, fixedLot);
const auto = riskPercents.map((riskPercent) => applyAuto(trades, startingBalance, riskPercent));
const summaryRows = [fixed, ...auto].map((x) => ({
  Lane: x.name,
  Trades: x.metrics.trades,
  Blocked: x.metrics.blockedTrades,
  NetPnl: x.metrics.netPnl,
  EndingBalance: x.metrics.endingBalance,
  ProfitFactor: x.metrics.profitFactor,
  Expectancy: x.metrics.expectancy,
  MaxDDUsd: x.metrics.maxDrawdownUsd,
  MaxDDPct: x.metrics.maxDrawdownPercent,
  WorstLossStreak: x.metrics.worstLosingStreak,
  AvgLot: x.metrics.averageLot,
  MinLot: x.metrics.minLot,
  MaxLot: x.metrics.maxLot,
}));

console.log("\n=== V30 AUTO-LOT COMPOUNDING COMPARISON ===\n");
console.table(summaryRows);
console.log("\n=== V30 ENTRY COUNTS ===\n");
console.table([{
  M15Bars: m15.filter((b) => b.closeTime >= fromMs && b.closeTime < toMs).length,
  M5Bars: m5.filter((b) => b.closeTime >= fromMs && b.closeTime < toMs).length,
  Candidates: candidates.length,
  Trades: trades.length,
  SkippedWhileOpen: skippedWhileOpen,
  StructuralOver10Blocked: blocked.structuralOver10,
  SupertrendMismatchBlocked: blocked.stMismatch,
}]);

fs.mkdirSync(outDir, { recursive: true });
const report = {
  version: 30,
  generatedAt: new Date().toISOString(),
  safety: { readOnly: true, executionMutation: false, realAccountAllowed: false },
  account: { login: health.accountLogin, mode: health.accountMode, server: health.server, startingBalance },
  configuration: {
    days, fixedLot, riskPercents, maxAutoLot,
    capitalBasis: "REALIZED_BALANCE_ONLY",
    drawdownThrottle: "DD<2%=1.00|2-4%=0.75|4-6%=0.50|>=6%=BLOCK",
    recoveryLotEscalation: false,
    entry: "ENGULFING_OR_TWO_OR_EXCLUSIVE_THREE_CANDLE + ST_M15_10_3 + ST_M5_10_3",
    initialStop: "STRUCTURE<6=>6;6-10=>ACTUAL;>10=>BLOCK",
    management: "+6 BE;+10 close 1/3;runner structure trail;M15 ST flip approximate exit",
  },
  broker: { cashPerPriceUnitPerLot, minVolume, volumeStep, maxVolume: brokerMaxVolume },
  entryCounts: { candidates: candidates.length, trades: trades.length, skippedWhileOpen, blocked },
  fixed,
  auto,
};
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
fs.writeFileSync(path.join(outDir, "summary.csv"), toCsv(summaryRows), "utf8");
fs.writeFileSync(path.join(outDir, "canonical-trades.csv"), toCsv(trades.map((t) => ({
  entryTime: new Date(t.entryTime).toISOString(), side: t.side, pattern: t.pattern,
  stopDistance: round(t.stopDistance, 4), entry: round(t.entry, 5), exit: round(t.exit, 5),
  pnlFixed003: round(t.pnl, 2), exitReason: t.exitReason, partialApplied: t.partialApplied,
}))), "utf8");
for (const lane of auto) {
  fs.writeFileSync(path.join(outDir, `trades-risk-${lane.riskPercent.toFixed(2)}.csv`), toCsv(lane.trades), "utf8");
}

console.log(`\nPHASE7B_V30_OUTPUT_DIR=${outDir}`);
console.log(`PHASE7B_V30_CANONICAL_TRADES=${trades.length}`);
console.log("PHASE7B_V30_COMPOUNDING=REALIZED_BALANCE_ONLY");
console.log("PHASE7B_V30_DRAWDOWN_THROTTLE=2PCT_0.75|4PCT_0.50|6PCT_BLOCK");
console.log("PHASE7B_V30_EXECUTION_MUTATION=False");
console.log("PHASE7B_V30_REAL_ACCOUNT_ALLOWED=False");
console.log("PHASE7B_V30=PASS");

function simulateTrade(signal) {
  const start = lowerBound(m5.map((b) => b.openTime), signal.signalTimestamp);
  const first = m5[start];
  if (!first || first.openTime > signal.signalTimestamp + 15 * 60_000) return null;
  const entry = signal.side === "BUY" ? first.open + Number(first.spread ?? 0) : first.open;
  const initialStop = signal.side === "BUY" ? entry - signal.stopDistance : entry + signal.stopDistance;
  let stop = initialStop;
  let remaining = fixedLot;
  let partialApplied = false;
  let partialPnl = 0;
  let partialVolume = 0;
  let breakEvenApplied = false;
  let lastM15Checked = signal.signalTimestamp;
  for (let i = start; i < m5.length; i += 1) {
    const bar = m5[i];
    if (stopTouched(signal.side, bar, stop)) {
      return closeTrade(signal, first.openTime, entry, initialStop, bar.closeTime, stop, remaining, partialPnl, partialVolume, partialApplied, breakEvenApplied, "STOP");
    }
    const favorable = signal.side === "BUY" ? bar.high - entry : entry - bar.low;
    if (!breakEvenApplied && favorable >= 6) {
      stop = improveStop(signal.side, stop, entry);
      breakEvenApplied = true;
    }
    if (!partialApplied && favorable >= 10) {
      partialVolume = fixedLot / 3;
      const partialPrice = signal.side === "BUY" ? entry + 10 : entry - 10;
      partialPnl = pnlUsd(signal.side, entry, partialPrice, partialVolume);
      remaining = fixedLot - partialVolume;
      partialApplied = true;
    }
    if (partialApplied) {
      const swing = latestSwing(signal.side, signal.signalTimestamp, bar.closeTime);
      if (swing !== null) stop = improveStop(signal.side, stop, swing);
      const mi = upperBound(m15CloseTimes, bar.closeTime) - 1;
      if (mi >= 0) {
        const closed = m15[mi];
        if (closed.closeTime > lastM15Checked) {
          lastM15Checked = closed.closeTime;
          const direction = st15.direction[mi];
          if (direction && direction !== signal.side) {
            const exit = signal.side === "BUY" ? closed.close - Number(closed.spread ?? 0) : closed.close;
            return closeTrade(signal, first.openTime, entry, initialStop, closed.closeTime, exit, remaining, partialPnl, partialVolume, partialApplied, breakEvenApplied, "M15_SUPERTREND_FLIP");
          }
        }
      }
    }
  }
  const last = m5.at(-1);
  const exit = signal.side === "BUY" ? last.close - Number(last.spread ?? 0) : last.close;
  return closeTrade(signal, first.openTime, entry, initialStop, last.closeTime, exit, remaining, partialPnl, partialVolume, partialApplied, breakEvenApplied, "END_OF_DATA");
}

function closeTrade(signal, entryTime, entry, initialStop, exitTime, exit, remaining, partialPnl, partialVolume, partialApplied, breakEvenApplied, exitReason) {
  const pnl = partialPnl + pnlUsd(signal.side, entry, exit, remaining);
  return {
    ...signal, entryTime, entry, stopLoss: initialStop, exitTime, exit,
    pnl: round(pnl, 2), volume: fixedLot, partialVolume, partialApplied, breakEvenApplied, exitReason,
  };
}

function applyFixed(schedule, balance, lot) {
  const laneTrades = schedule.map((t) => ({ lot, pnl: round(t.pnl * lot / fixedLot, 2) }));
  return laneSummary("FIXED_0.03", null, balance, laneTrades, schedule, 0);
}

function applyAuto(schedule, starting, riskPercent) {
  let balance = starting;
  let peak = starting;
  const laneTrades = [];
  let blockedTrades = 0;
  for (const t of schedule) {
    const ddPct = peak > 0 ? (peak - balance) / peak * 100 : 0;
    const throttle = ddPct >= 6 ? 0 : ddPct >= 4 ? 0.5 : ddPct >= 2 ? 0.75 : 1;
    if (throttle === 0) {
      laneTrades.push({ lot: 0, pnl: 0, blocked: true, balanceBefore: round(balance, 2), balanceAfter: round(balance, 2), ddPct: round(ddPct, 4), throttle });
      blockedTrades += 1;
      continue;
    }
    const targetRiskUsd = balance * riskPercent / 100 * throttle;
    const oneLotRisk = t.stopDistance * cashPerPriceUnitPerLot;
    const rawLot = targetRiskUsd / oneLotRisk;
    const cap = Math.min(rawLot, maxAutoLot, brokerMaxVolume);
    const lot = canonicalCompatibleLot(cap, minVolume, volumeStep);
    if (!(lot >= minVolume - 1e-9)) {
      laneTrades.push({ lot: 0, pnl: 0, blocked: true, balanceBefore: round(balance, 2), balanceAfter: round(balance, 2), ddPct: round(ddPct, 4), throttle, targetRiskUsd: round(targetRiskUsd, 2) });
      blockedTrades += 1;
      continue;
    }
    const pnl = round(t.pnl * lot / fixedLot, 2);
    const before = balance;
    balance += pnl;
    peak = Math.max(peak, balance);
    laneTrades.push({ lot, pnl, blocked: false, balanceBefore: round(before, 2), balanceAfter: round(balance, 2), ddPct: round(ddPct, 4), throttle, targetRiskUsd: round(targetRiskUsd, 2), actualRiskUsd: round(oneLotRisk * lot, 2) });
  }
  return laneSummary(`AUTO_${riskPercent.toFixed(2)}PCT`, riskPercent, starting, laneTrades, schedule, blockedTrades);
}

function laneSummary(name, riskPercent, starting, laneTrades, schedule, blockedTrades) {
  let balance = starting;
  let peak = starting;
  let maxDdUsd = 0;
  let maxDdPct = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let lossStreak = 0;
  let worstLossStreak = 0;
  const lots = [];
  let executed = 0;
  let net = 0;
  for (let i = 0; i < laneTrades.length; i += 1) {
    const row = laneTrades[i];
    if (row.blocked) continue;
    const pnl = Number(row.pnl ?? 0);
    executed += 1;
    net += pnl;
    balance += pnl;
    peak = Math.max(peak, balance);
    const dd = peak - balance;
    const ddPct = peak > 0 ? dd / peak * 100 : 0;
    maxDdUsd = Math.max(maxDdUsd, dd);
    maxDdPct = Math.max(maxDdPct, ddPct);
    if (pnl > 0) { grossProfit += pnl; lossStreak = 0; }
    else if (pnl < 0) { grossLoss += -pnl; lossStreak += 1; worstLossStreak = Math.max(worstLossStreak, lossStreak); }
    lots.push(Number(row.lot ?? 0));
  }
  const pf = grossLoss > 0 ? grossProfit / grossLoss : null;
  const metrics = {
    trades: executed, blockedTrades, netPnl: round(net, 2), endingBalance: round(starting + net, 2),
    profitFactor: pf === null ? null : round(pf, 4), expectancy: round(executed ? net / executed : 0, 4),
    maxDrawdownUsd: round(maxDdUsd, 2), maxDrawdownPercent: round(maxDdPct, 4), worstLosingStreak: worstLossStreak,
    averageLot: round(avg(lots), 4), minLot: lots.length ? round(Math.min(...lots), 4) : 0,
    maxLot: lots.length ? round(Math.max(...lots), 4) : 0,
  };
  const trades = laneTrades.map((row, i) => ({
    entryTime: new Date(schedule[i].entryTime).toISOString(), side: schedule[i].side, pattern: schedule[i].pattern,
    stopDistance: round(schedule[i].stopDistance, 4), lot: row.lot, pnl: row.pnl, blocked: Boolean(row.blocked),
    balanceBefore: row.balanceBefore ?? null, balanceAfter: row.balanceAfter ?? null,
    drawdownPercentBefore: row.ddPct ?? null, throttle: row.throttle ?? null,
    targetRiskUsd: row.targetRiskUsd ?? null, actualRiskUsd: row.actualRiskUsd ?? null,
  }));
  return { name, riskPercent, metrics, trades };
}

function detectPattern(bars, i) {
  const d = bars[i];
  const c = bars[i - 1];
  if (!c) return null;
  if (bear(c) && bull(d) && d.open <= c.close + 0.1 + 1e-9 && d.close + 0.1 + 1e-9 >= c.open)
    return { side: "BUY", pattern: "ENGULFING", extreme: d.low };
  if (bull(c) && bear(d) && d.open + 0.1 + 1e-9 >= c.close && d.close <= c.open + 0.1 + 1e-9)
    return { side: "SELL", pattern: "ENGULFING", extreme: d.high };
  if (i >= 2) {
    const a = bars[i - 2];
    const b = bars[i - 1];
    const ba = body(a), bb = body(b), bd = body(d);
    if (bear(a) && bull(b) && bull(d) && bb < ba && bb + bd > ba)
      return { side: "BUY", pattern: "TWO_CANDLE_BODY_DOMINANCE", extreme: Math.min(a.low, b.low, d.low) };
    if (bull(a) && bear(b) && bear(d) && bb < ba && bb + bd > ba)
      return { side: "SELL", pattern: "TWO_CANDLE_BODY_DOMINANCE", extreme: Math.max(a.high, b.high, d.high) };
  }
  if (i >= 3) {
    const a = bars[i - 3], b = bars[i - 2], c2 = bars[i - 1];
    const ba = body(a), bb = body(b), bc = body(c2), bd = body(d);
    if (bear(a) && bull(b) && bull(c2) && bull(d) && bb < ba && bb + bc <= ba + 1e-9 && bb + bc + bd > ba)
      return { side: "BUY", pattern: "THREE_CANDLE_BODY_DOMINANCE", extreme: Math.min(a.low, b.low, c2.low, d.low) };
    if (bull(a) && bear(b) && bear(c2) && bear(d) && bb < ba && bb + bc <= ba + 1e-9 && bb + bc + bd > ba)
      return { side: "SELL", pattern: "THREE_CANDLE_BODY_DOMINANCE", extreme: Math.max(a.high, b.high, c2.high, d.high) };
  }
  return null;
}

function supertrend(bars, period, multiplier) {
  const n = bars.length;
  const tr = Array(n).fill(null), atr = Array(n).fill(null), upper = Array(n).fill(null), lower = Array(n).fill(null), st = Array(n).fill(null), direction = Array(n).fill(null);
  for (let i = 0; i < n; i += 1) {
    const prevClose = i > 0 ? bars[i - 1].close : bars[i].close;
    tr[i] = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - prevClose), Math.abs(bars[i].low - prevClose));
    if (i === period - 1) atr[i] = tr.slice(0, period).reduce((s, v) => s + v, 0) / period;
    else if (i >= period) atr[i] = ((atr[i - 1] * (period - 1)) + tr[i]) / period;
    if (atr[i] == null) continue;
    const mid = (bars[i].high + bars[i].low) / 2;
    const basicUpper = mid + multiplier * atr[i];
    const basicLower = mid - multiplier * atr[i];
    if (i === period - 1 || upper[i - 1] == null) {
      upper[i] = basicUpper; lower[i] = basicLower;
      st[i] = bars[i].close <= upper[i] ? upper[i] : lower[i];
      direction[i] = st[i] === lower[i] ? "BUY" : "SELL";
      continue;
    }
    upper[i] = basicUpper < upper[i - 1] || bars[i - 1].close > upper[i - 1] ? basicUpper : upper[i - 1];
    lower[i] = basicLower > lower[i - 1] || bars[i - 1].close < lower[i - 1] ? basicLower : lower[i - 1];
    if (st[i - 1] === upper[i - 1]) st[i] = bars[i].close <= upper[i] ? upper[i] : lower[i];
    else st[i] = bars[i].close >= lower[i] ? lower[i] : upper[i];
    direction[i] = st[i] === lower[i] ? "BUY" : "SELL";
  }
  return { line: st, direction };
}

function buildSwings(bars, side) {
  const rows = [];
  for (let i = 1; i < bars.length - 1; i += 1) {
    const l = bars[i - 1], m = bars[i], r = bars[i + 1];
    if (side === "BUY" && m.low < l.low && m.low <= r.low) rows.push({ confirmedAt: r.closeTime, level: m.low });
    if (side === "SELL" && m.high > l.high && m.high >= r.high) rows.push({ confirmedAt: r.closeTime, level: m.high });
  }
  return rows;
}
function latestSwing(side, after, at) {
  const rows = side === "BUY" ? swingsBuy : swingsSell;
  let value = null;
  for (const s of rows) {
    if (s.confirmedAt <= after) continue;
    if (s.confirmedAt > at) break;
    value = s.level;
  }
  return value;
}
function stopTouched(side, bar, stop) { return side === "BUY" ? bar.low <= stop : bar.high >= stop; }
function improveStop(side, current, candidate) { return side === "BUY" ? Math.max(current, candidate) : Math.min(current, candidate); }
function pnlUsd(side, entry, exit, volume) { const move = side === "BUY" ? exit - entry : entry - exit; return move * cashPerPriceUnitPerLot * volume; }
function bull(b) { return b.close > b.open; }
function bear(b) { return b.close < b.open; }
function body(b) { return Math.abs(b.close - b.open); }
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
function lowerBound(a, x) { let l = 0, r = a.length; while (l < r) { const m = (l + r) >> 1; if (a[m] < x) l = m + 1; else r = m; } return l; }
function upperBound(a, x) { let l = 0, r = a.length; while (l < r) { const m = (l + r) >> 1; if (a[m] <= x) l = m + 1; else r = m; } return l; }
function avg(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function round(v, d) { const f = 10 ** d; return Math.round((v + Number.EPSILON) * f) / f; }
function clampInt(v, min, max) { if (!Number.isFinite(v)) return min; return Math.max(min, Math.min(max, Math.round(v))); }
function finitePositive(v, name) { if (!(Number.isFinite(v) && v > 0)) throw new Error(`${name} must be positive.`); return v; }
function loadEnvFile(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing env: ${file}`);
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("="); const name = line.slice(0, i).trim(); let value = line.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[name] === undefined) process.env[name] = value;
  }
}
async function getJson(endpoint, timeoutMs) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${endpoint}`, { headers: { "x-mt5-api-key": apiKey }, signal: controller.signal });
    const text = await res.text(); if (!res.ok) throw new Error(`Bridge ${res.status} ${endpoint}: ${text}`); return JSON.parse(text);
  } finally { clearTimeout(timer); }
}
function toCsv(rows) {
  if (!rows.length) return "";
  const keys = Object.keys(rows[0]);
  const esc = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [keys.join(","), ...rows.map((r) => keys.map((k) => esc(r[k])).join(","))].join("\r\n") + "\r\n";
}
