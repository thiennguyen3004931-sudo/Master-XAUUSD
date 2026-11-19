import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const bridgeEnv = path.join(root, "packages", "mt5-broker", "bridge", ".env.phase7b-demo");
const outDir = path.join(root, ".runtime", "phase7b-delayed-entry-research-v33");
const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const raw = arg.replace(/^--/, "");
  const i = raw.indexOf("=");
  return i >= 0 ? [raw.slice(0, i), raw.slice(i + 1)] : [raw, "true"];
}));
const days = clampInt(Number(args.days ?? 180), 30, 370);
const expiryBarsList = String(args.expiryBars ?? "1,2,3,4")
  .split(",")
  .map((v) => Number(v.trim()))
  .filter((v) => Number.isFinite(v) && v >= 1 && v <= 12)
  .map((v) => Math.round(v));
if (!expiryBarsList.length) throw new Error("No valid --expiryBars values. Example: --expiryBars=1,2,3,4");

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
if (!health.connected || health.accountMode !== "demo") throw new Error(`V33 requires connected DEMO, got ${health.accountMode ?? "unknown"}.`);
const cashPerPriceUnitPerLot = Number(spec.cashPerPriceUnitPerLot) > 0
  ? Number(spec.cashPerPriceUnitPerLot)
  : Number(spec.tickSize) > 0 ? Number(spec.effectiveTickValuePerLot) / Number(spec.tickSize) : 0;
if (!(cashPerPriceUnitPerLot > 0)) throw new Error("Invalid broker cashPerPriceUnitPerLot.");
const fixedLot = 0.03;
const toMs = Number(quote.timestamp) + 60_000;
if (!Number.isFinite(toMs)) throw new Error("Broker quote timestamp unavailable.");
const fromMs = toMs - days * 86_400_000;
const warmupFromMs = fromMs - 45 * 86_400_000;

console.log(`PHASE7B_V33_ACCOUNT_LOGIN=${health.accountLogin}`);
console.log(`PHASE7B_V33_ACCOUNT_MODE=${health.accountMode}`);
console.log(`PHASE7B_V33_SERVER=${health.server}`);
console.log(`PHASE7B_V33_DAYS=${days}`);
console.log(`PHASE7B_V33_EXPIRY_BARS=${expiryBarsList.join(",")}`);
console.log("PHASE7B_V33_ENTRY_BASE=3_PATTERNS_PLUS_SUPERTREND_M15_M5_10_3");
console.log("PHASE7B_V33_THREE_CANDLE=B_LT_A_AND_B_PLUS_C_LE_A_AND_B_PLUS_C_PLUS_D_GT_A");
console.log("PHASE7B_V33_IMMEDIATE_ENTRY=STRUCTURAL_SL_LE_10");
console.log("PHASE7B_V33_DELAYED_ENTRY=STRUCTURAL_SL_GT_10_WAIT_PULLBACK_TO_SL_LE_10");
console.log("PHASE7B_V33_DELAYED_ENTRY_ANCHOR=ORIGINAL_PATTERN_EXTREME");
console.log("PHASE7B_V33_DELAYED_ENTRY_INVALIDATE=STRUCTURE_BREAK_OR_ST_FLIP_OR_EXPIRY");
console.log("PHASE7B_V33_INTRABAR_POLICY=INVALIDATION_FIRST_CONSERVATIVE");
console.log("PHASE7B_V33_EXECUTION_MUTATION=False");
console.log("PHASE7B_V33_REAL_ACCOUNT_ALLOWED=False");

const [m15Raw, m5Raw] = await Promise.all([
  getJson(`/v1/history/candles/XAUUSD?timeframe=M15&fromMs=${Math.round(warmupFromMs)}&toMs=${Math.round(toMs)}`, 60_000),
  getJson(`/v1/history/candles/XAUUSD?timeframe=M5&fromMs=${Math.round(warmupFromMs)}&toMs=${Math.round(toMs)}`, 90_000),
]);
const m15 = [...m15Raw].sort((a, b) => a.openTime - b.openTime);
const m5 = [...m5Raw].sort((a, b) => a.openTime - b.openTime);
if (m15.length < 200 || m5.length < 50) throw new Error(`Insufficient history M15=${m15.length}, M5=${m5.length}.`);
const st15 = supertrend(m15, 10, 3);
const st5 = supertrend(m5, 10, 3);
const m5OpenTimes = m5.map((b) => b.openTime);
const m5CloseTimes = m5.map((b) => b.closeTime);
const m15CloseTimes = m15.map((b) => b.closeTime);
const swingsBuy = buildSwings(m15, "BUY");
const swingsSell = buildSwings(m15, "SELL");

const immediateSignals = [];
const delayedSignals = [];
const blocked = { noM5: 0, stMismatch: 0, invalidStructure: 0 };
for (let i = 20; i < m15.length; i += 1) {
  const bar = m15[i];
  if (bar.closeTime < fromMs || bar.closeTime >= toMs) continue;
  const pattern = detectPattern(m15, i);
  if (!pattern) continue;
  if (st15.direction[i] !== pattern.side) { blocked.stMismatch += 1; continue; }
  const m5Index = upperBound(m5CloseTimes, bar.closeTime) - 1;
  if (m5Index < 0) { blocked.noM5 += 1; continue; }
  if (st5.direction[m5Index] !== pattern.side) { blocked.stMismatch += 1; continue; }
  const structural = pattern.side === "BUY" ? bar.close - pattern.extreme : pattern.extreme - bar.close;
  if (!(structural > 0)) { blocked.invalidStructure += 1; continue; }
  const signal = {
    side: pattern.side,
    pattern: pattern.pattern,
    signalTimestamp: bar.closeTime,
    patternExtreme: pattern.extreme,
    structuralStopDistance: structural,
    m15Index: i,
  };
  if (structural <= 10 + 1e-9) {
    immediateSignals.push({ ...signal, stopDistance: Math.max(6, structural), entryType: "IMMEDIATE" });
  } else {
    delayedSignals.push({ ...signal, entryType: "WAIT_PULLBACK" });
  }
}

const immediateRaw = immediateSignals.map((signal) => simulateImmediate(signal)).filter(Boolean);
const baseline = selectNonOverlapping(immediateRaw);
const baselineMetrics = summarize(baseline);

const variants = [];
for (const expiryBars of expiryBarsList) {
  const delayedResults = delayedSignals.map((signal) => simulateDelayed(signal, expiryBars));
  const delayedRaw = delayedResults.map((x) => x.trade).filter(Boolean);
  const combinedRaw = [...immediateRaw, ...delayedRaw];
  const selected = selectNonOverlapping(combinedRaw);
  const metrics = summarize(selected);
  const selectedDelayed = selected.filter((t) => t.entryType === "DELAYED_PULLBACK");
  const reasons = countReasons(delayedResults);
  const fold = foldSummary(selected, 6);
  variants.push({
    expiryBars,
    expiryMinutes: expiryBars * 15,
    selected,
    metrics,
    delayed: {
      candidates: delayedSignals.length,
      rawFilled: delayedRaw.length,
      selectedFilled: selectedDelayed.length,
      reasons,
    },
    fold,
  });
}

const summaryRows = [
  {
    Variant: "BASELINE_NO_DELAYED",
    ExpiryMin: 0,
    Trades: baselineMetrics.trades,
    DelayedSelected: 0,
    NetPnl: baselineMetrics.netPnl,
    ProfitFactor: baselineMetrics.profitFactor,
    Expectancy: baselineMetrics.expectancy,
    MaxDDUsd: baselineMetrics.maxDrawdownUsd,
    WinRatePct: baselineMetrics.winRatePercent,
    ProfitableFolds: `${foldSummary(baseline, 6).profitableFolds}/6`,
    MedianFoldPnl: foldSummary(baseline, 6).medianFoldPnl,
  },
  ...variants.map((v) => ({
    Variant: `DELAYED_${v.expiryMinutes}MIN`,
    ExpiryMin: v.expiryMinutes,
    Trades: v.metrics.trades,
    DelayedSelected: v.delayed.selectedFilled,
    NetPnl: v.metrics.netPnl,
    ProfitFactor: v.metrics.profitFactor,
    Expectancy: v.metrics.expectancy,
    MaxDDUsd: v.metrics.maxDrawdownUsd,
    WinRatePct: v.metrics.winRatePercent,
    ProfitableFolds: `${v.fold.profitableFolds}/6`,
    MedianFoldPnl: v.fold.medianFoldPnl,
  })),
];

console.log("\n=== V33 DELAYED PULLBACK ENTRY SUMMARY ===\n");
console.table(summaryRows);
console.log("\n=== V33 DELAYED CANDIDATE OUTCOMES ===\n");
console.table(variants.map((v) => ({
  ExpiryMin: v.expiryMinutes,
  Candidates: v.delayed.candidates,
  RawFilled: v.delayed.rawFilled,
  SelectedFilled: v.delayed.selectedFilled,
  StructureInvalidated: v.delayed.reasons.STRUCTURE_INVALIDATED ?? 0,
  SupertrendInvalidated: v.delayed.reasons.SUPERTREND_INVALIDATED ?? 0,
  ExpiredNoPullback: v.delayed.reasons.EXPIRED_NO_PULLBACK ?? 0,
  NoM5: v.delayed.reasons.NO_M5 ?? 0,
}))); 

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "summary.csv"), toCsv(summaryRows), "utf8");
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify({
  version: 33,
  generatedAt: new Date().toISOString(),
  safety: { readOnly: true, executionMutation: false, realAccountAllowed: false },
  account: { login: health.accountLogin, mode: health.accountMode, server: health.server },
  configuration: {
    days,
    expiryBarsList,
    immediateEntry: "STRUCTURAL_STOP_DISTANCE<=10",
    delayedEntry: "IF_STRUCTURAL>10_WAIT_FOR_PULLBACK_UNTIL_SAME_STRUCTURE_ANCHOR_IS_WITHIN_10",
    delayedEntryStopDistance: 10,
    invalidation: "ORIGINAL_STRUCTURE_BREAK_OR_M15_M5_SUPERTREND_FLIP_OR_EXPIRY",
    intrabarPolicy: "INVALIDATION_FIRST_CONSERVATIVE",
    fixedLot,
  },
  counts: {
    immediateSignals: immediateSignals.length,
    delayedSignals: delayedSignals.length,
    baseBlocked: blocked,
  },
  baseline: { metrics: baselineMetrics, fold: foldSummary(baseline, 6) },
  variants: variants.map((v) => ({
    expiryBars: v.expiryBars,
    expiryMinutes: v.expiryMinutes,
    metrics: v.metrics,
    delayed: v.delayed,
    fold: v.fold,
  })),
}, null, 2), "utf8");
for (const v of variants) {
  fs.writeFileSync(path.join(outDir, `trades-delayed-${v.expiryMinutes}min.csv`), toCsv(v.selected.map(tradeRow)), "utf8");
}
fs.writeFileSync(path.join(outDir, "trades-baseline.csv"), toCsv(baseline.map(tradeRow)), "utf8");

console.log(`\nPHASE7B_V33_OUTPUT_DIR=${outDir}`);
console.log(`PHASE7B_V33_IMMEDIATE_SIGNALS=${immediateSignals.length}`);
console.log(`PHASE7B_V33_DELAYED_SIGNALS=${delayedSignals.length}`);
console.log("PHASE7B_V33_EXECUTION_MUTATION=False");
console.log("PHASE7B_V33_REAL_ACCOUNT_ALLOWED=False");
console.log("PHASE7B_V33=PASS");

function simulateImmediate(signal) {
  const start = lowerBound(m5OpenTimes, signal.signalTimestamp);
  const first = m5[start];
  if (!first || first.openTime > signal.signalTimestamp + 15 * 60_000) return null;
  const spread = Number(first.spread ?? 0);
  const entry = signal.side === "BUY" ? first.open + spread : first.open;
  return simulateFromEntry({ ...signal, entryType: "IMMEDIATE" }, start, first.openTime, entry, signal.stopDistance);
}

function simulateDelayed(signal, expiryBars) {
  const start = lowerBound(m5OpenTimes, signal.signalTimestamp);
  if (start >= m5.length) return { trade: null, reason: "NO_M5" };
  const expiryTime = signal.signalTimestamp + expiryBars * 15 * 60_000;
  const targetEntry = signal.side === "BUY" ? signal.patternExtreme + 10 : signal.patternExtreme - 10;

  for (let i = start; i < m5.length; i += 1) {
    const bar = m5[i];
    if (bar.openTime >= expiryTime) break;

    const latestClosedM15 = upperBound(m15CloseTimes, bar.openTime) - 1;
    const latestClosedM5 = i - 1;
    if (latestClosedM15 < 0 || latestClosedM5 < 0) continue;
    if (st15.direction[latestClosedM15] !== signal.side || st5.direction[latestClosedM5] !== signal.side) {
      return { trade: null, reason: "SUPERTREND_INVALIDATED" };
    }

    if (signal.side === "BUY") {
      if (bar.low <= signal.patternExtreme + 1e-9) return { trade: null, reason: "STRUCTURE_INVALIDATED" };
      const spread = Number(bar.spread ?? 0);
      const askLowApprox = bar.low + spread;
      if (askLowApprox <= targetEntry + 1e-9) {
        const trade = simulateFromEntry({ ...signal, entryType: "DELAYED_PULLBACK", delayedExpiryBars: expiryBars }, i, bar.openTime, targetEntry, 10);
        return { trade, reason: trade ? "FILLED" : "NO_TRADE" };
      }
    } else {
      if (bar.high >= signal.patternExtreme - 1e-9) return { trade: null, reason: "STRUCTURE_INVALIDATED" };
      if (bar.high >= targetEntry - 1e-9) {
        const trade = simulateFromEntry({ ...signal, entryType: "DELAYED_PULLBACK", delayedExpiryBars: expiryBars }, i, bar.openTime, targetEntry, 10);
        return { trade, reason: trade ? "FILLED" : "NO_TRADE" };
      }
    }
  }
  return { trade: null, reason: "EXPIRED_NO_PULLBACK" };
}

function simulateFromEntry(signal, startIndex, entryTime, entry, stopDistance) {
  const initialStop = signal.side === "BUY" ? entry - stopDistance : entry + stopDistance;
  let stop = initialStop;
  let remaining = fixedLot;
  let partialApplied = false;
  let partialPnl = 0;
  let partialVolume = 0;
  let breakEvenApplied = false;
  let lastM15Checked = signal.signalTimestamp;

  for (let i = startIndex; i < m5.length; i += 1) {
    const bar = m5[i];
    if (bar.closeTime < entryTime) continue;
    if (stopTouched(signal.side, bar, stop)) {
      return closeTrade(signal, entryTime, entry, initialStop, bar.closeTime, stop, remaining, partialPnl, partialVolume, partialApplied, breakEvenApplied, "STOP", stopDistance);
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
            return closeTrade(signal, entryTime, entry, initialStop, closed.closeTime, exit, remaining, partialPnl, partialVolume, partialApplied, breakEvenApplied, "M15_SUPERTREND_FLIP", stopDistance);
          }
        }
      }
    }
  }

  const last = m5.at(-1);
  const exit = signal.side === "BUY" ? last.close - Number(last.spread ?? 0) : last.close;
  return closeTrade(signal, entryTime, entry, initialStop, last.closeTime, exit, remaining, partialPnl, partialVolume, partialApplied, breakEvenApplied, "END_OF_DATA", stopDistance);
}

function closeTrade(signal, entryTime, entry, initialStop, exitTime, exit, remaining, partialPnl, partialVolume, partialApplied, breakEvenApplied, exitReason, stopDistance) {
  const pnl = partialPnl + pnlUsd(signal.side, entry, exit, remaining);
  return {
    ...signal,
    entryTime,
    entry,
    stopLoss: initialStop,
    stopDistance,
    exitTime,
    exit,
    pnl: round(pnl, 2),
    volume: fixedLot,
    partialVolume,
    partialApplied,
    breakEvenApplied,
    exitReason,
  };
}

function selectNonOverlapping(raw) {
  const sorted = [...raw].sort((a, b) => a.entryTime - b.entryTime || entryPriority(a) - entryPriority(b));
  const selected = [];
  let busyUntil = -Infinity;
  for (const trade of sorted) {
    if (trade.entryTime < busyUntil) continue;
    selected.push(trade);
    busyUntil = trade.exitTime;
  }
  return selected;
}
function entryPriority(t) { return t.entryType === "IMMEDIATE" ? 0 : 1; }

function summarize(trades) {
  let net = 0, grossProfit = 0, grossLoss = 0, wins = 0, peak = 0, cumulative = 0, maxDd = 0;
  for (const t of trades) {
    const p = Number(t.pnl);
    net += p;
    cumulative += p;
    peak = Math.max(peak, cumulative);
    maxDd = Math.max(maxDd, peak - cumulative);
    if (p > 0) { grossProfit += p; wins += 1; }
    else if (p < 0) grossLoss += -p;
  }
  return {
    trades: trades.length,
    netPnl: round(net, 2),
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : null,
    expectancy: round(trades.length ? net / trades.length : 0, 4),
    winRatePercent: round(trades.length ? wins / trades.length * 100 : 0, 2),
    maxDrawdownUsd: round(maxDd, 2),
  };
}

function foldSummary(trades, folds) {
  const rows = [];
  for (let i = 0; i < folds; i += 1) {
    const start = fromMs + (toMs - fromMs) * i / folds;
    const end = i === folds - 1 ? toMs + 1 : fromMs + (toMs - fromMs) * (i + 1) / folds;
    const foldTrades = trades.filter((t) => t.entryTime >= start && t.entryTime < end);
    rows.push({ fold: i + 1, ...summarize(foldTrades) });
  }
  const profitableFolds = rows.filter((r) => r.netPnl > 0).length;
  const medianFoldPnl = round(median(rows.map((r) => r.netPnl)), 2);
  return { profitableFolds, medianFoldPnl, rows };
}

function countReasons(results) {
  const counts = {};
  for (const r of results) counts[r.reason] = (counts[r.reason] ?? 0) + 1;
  return counts;
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
    const a = bars[i - 2], b = bars[i - 1];
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
function lowerBound(a, x) { let l = 0, r = a.length; while (l < r) { const m = (l + r) >> 1; if (a[m] < x) l = m + 1; else r = m; } return l; }
function upperBound(a, x) { let l = 0, r = a.length; while (l < r) { const m = (l + r) >> 1; if (a[m] <= x) l = m + 1; else r = m; } return l; }
function median(a) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function round(v, d) { const f = 10 ** d; return Math.round((v + Number.EPSILON) * f) / f; }
function clampInt(v, min, max) { if (!Number.isFinite(v)) return min; return Math.max(min, Math.min(max, Math.round(v))); }
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
function tradeRow(t) {
  return {
    entryTime: new Date(t.entryTime).toISOString(),
    signalTime: new Date(t.signalTimestamp).toISOString(),
    side: t.side,
    pattern: t.pattern,
    entryType: t.entryType,
    structuralStopDistanceAtSignal: round(t.structuralStopDistance, 4),
    stopDistanceAtEntry: round(t.stopDistance, 4),
    entry: round(t.entry, 5),
    stopLoss: round(t.stopLoss, 5),
    exit: round(t.exit, 5),
    pnl: t.pnl,
    partialApplied: t.partialApplied,
    exitReason: t.exitReason,
  };
}
function toCsv(rows) {
  if (!rows.length) return "";
  const keys = Object.keys(rows[0]);
  const esc = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [keys.join(","), ...rows.map((r) => keys.map((k) => esc(r[k])).join(","))].join("\r\n") + "\r\n";
}
