import fs from "node:fs";
import path from "node:path";
import { phase7BSupertrend } from "@xauusd/risk-engine";

const ENGULF_BODY_TOLERANCE_PRICE = 0.1;
const MIN_INITIAL_SL_PRICE = 6;
const MAX_INITIAL_SL_PRICE = 10;

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return fallback;
  return String(process.argv[index + 1] ?? fallback).trim();
}

function loadEnvFile(file) {
  if (!file || !fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function resolveRuntimeRoot() {
  const explicit = argValue("--runtime", "");
  return path.resolve(explicit || process.env.PHASE7C_RUNTIME_ROOT || ".runtime");
}

function resolveBridgeEnv(runtimeRoot) {
  const explicit = argValue("--env", "");
  if (explicit) return path.resolve(explicit);
  const statePath = path.join(runtimeRoot, "phase7c-account-mode.json");
  if (!fs.existsSync(statePath)) throw new Error(`Account-mode state not found: ${statePath}`);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));

  const version = Number(state?.version);
  const accountMode = String(state?.accountMode ?? "").trim().toUpperCase();
  const liveExecutionEnabled = state?.liveExecutionEnabled === true;
  const envFile = typeof state?.envFile === "string" ? state.envFile.trim() : "";

  if (version !== 1) {
    throw new Error(`Account-mode state version must be 1: ${statePath}`);
  }

  if (accountMode !== "DEMO" && accountMode !== "LIVE") {
    throw new Error(`Unsupported accountMode=${accountMode || "missing"}: ${statePath}`);
  }

  if (accountMode === "DEMO" && liveExecutionEnabled) {
    throw new Error(`Invalid account-mode state: DEMO cannot enable LIVE execution: ${statePath}`);
  }

  if (accountMode === "LIVE" && !liveExecutionEnabled) {
    throw new Error(`Invalid account-mode state: LIVE requires liveExecutionEnabled=true: ${statePath}`);
  }

  if (!envFile) {
    throw new Error(`Account-mode state has no envFile: ${statePath}`);
  }

  const resolvedEnvFile = path.resolve(envFile);
  if (!fs.existsSync(resolvedEnvFile)) {
    throw new Error(`Account-mode envFile not found: ${resolvedEnvFile}`);
  }

  return resolvedEnvFile;
}

function bodySize(bar) {
  return Math.abs(Number(bar.close) - Number(bar.open));
}
function isBullish(bar) {
  return Number(bar.close) > Number(bar.open);
}
function isBearish(bar) {
  return Number(bar.close) < Number(bar.open);
}
function round(value, digits = 5) {
  if (!Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function patternDiagnostics(bars, index) {
  const current = bars[index];
  const three = { name: "THREE_CANDLE_BODY_DOMINANCE", pass: false, side: null, reason: "Không đủ dữ liệu 4 nến." };
  const two = { name: "TWO_CANDLE_BODY_DOMINANCE", pass: false, side: null, reason: "Không đủ dữ liệu 3 nến." };
  const engulf = { name: "ENGULFING", pass: false, side: null, reason: "Không đủ dữ liệu 2 nến." };

  let selected = null;
  if (index >= 3) {
    const anchor = bars[index - 3];
    const b = bars[index - 2];
    const c = bars[index - 1];
    const d = current;
    const anchorBody = bodySize(anchor);
    const bcBodyTotal = bodySize(b) + bodySize(c);
    const bcdBodyTotal = bcBodyTotal + bodySize(d);
    const buy = isBearish(anchor) && isBullish(b) && isBullish(c) && isBullish(d) && bcBodyTotal < anchorBody && bcdBodyTotal > anchorBody;
    const sell = isBullish(anchor) && isBearish(b) && isBearish(c) && isBearish(d) && bcBodyTotal < anchorBody && bcdBodyTotal > anchorBody;
    three.pass = buy || sell;
    three.side = buy ? "BUY" : sell ? "SELL" : null;
    three.reason = three.pass
      ? `PASS ${three.side}: tổng thân 2 nến đầu < thân anchor và tổng 3 nến > thân anchor.`
      : `FAIL: direction/body dominance không đạt (anchorBody=${round(anchorBody)}, bc=${round(bcBodyTotal)}, bcd=${round(bcdBodyTotal)}).`;
    if (three.pass) selected = { side: three.side, pattern: three.name, patternExtreme: three.side === "BUY" ? Math.min(anchor.low, b.low, c.low, d.low) : Math.max(anchor.high, b.high, c.high, d.high) };
  }

  if (index >= 2) {
    const anchor = bars[index - 2];
    const b = bars[index - 1];
    const c = current;
    const anchorBody = bodySize(anchor);
    const bBody = bodySize(b);
    const bcBodyTotal = bBody + bodySize(c);
    const buy = isBearish(anchor) && isBullish(b) && isBullish(c) && bBody < anchorBody && bcBodyTotal > anchorBody;
    const sell = isBullish(anchor) && isBearish(b) && isBearish(c) && bBody < anchorBody && bcBodyTotal > anchorBody;
    two.pass = buy || sell;
    two.side = buy ? "BUY" : sell ? "SELL" : null;
    two.reason = two.pass
      ? `PASS ${two.side}: thân nến 1 < anchor và tổng 2 nến > anchor.`
      : `FAIL: direction/body dominance không đạt (anchorBody=${round(anchorBody)}, b=${round(bBody)}, bc=${round(bcBodyTotal)}).`;
    if (!selected && two.pass) selected = { side: two.side, pattern: two.name, patternExtreme: two.side === "BUY" ? Math.min(anchor.low, b.low, c.low) : Math.max(anchor.high, b.high, c.high) };
  }

  if (index >= 1) {
    const previous = bars[index - 1];
    const buy = isBearish(previous) && isBullish(current) && current.open <= previous.close + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 && current.close + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 >= previous.open;
    const sell = isBullish(previous) && isBearish(current) && current.open + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 >= previous.close && current.close <= previous.open + ENGULF_BODY_TOLERANCE_PRICE + 1e-9;
    engulf.pass = buy || sell;
    engulf.side = buy ? "BUY" : sell ? "SELL" : null;
    engulf.reason = engulf.pass
      ? `PASS ${engulf.side}: engulf body với tolerance ${ENGULF_BODY_TOLERANCE_PRICE}.`
      : `FAIL: không engulf thân nến trước với tolerance ${ENGULF_BODY_TOLERANCE_PRICE}.`;
    if (!selected && engulf.pass) selected = { side: engulf.side, pattern: engulf.name, patternExtreme: engulf.side === "BUY" ? current.low : current.high };
  }

  return { priority: [three, two, engulf], selected };
}

async function getJson(base, apiKey, route) {
  const response = await fetch(`${base}${route}`, { headers: { "x-mt5-api-key": apiKey, accept: "application/json" } });
  const text = await response.text();
  if (!response.ok) throw new Error(`MT5 bridge GET ${route} failed ${response.status}: ${text}`);
  return JSON.parse(text);
}

async function getOptionalJson(url) {
  try {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

const runtimeRoot = resolveRuntimeRoot();
const bridgeEnv = resolveBridgeEnv(runtimeRoot);
loadEnvFile(bridgeEnv);

const symbol = (argValue("--symbol", process.env.ZIQ_DEMO_SYMBOL || "XAUUSD") || "XAUUSD").toUpperCase();
const bridgeHost = process.env.MT5_BRIDGE_HOST || "127.0.0.1";
const bridgePort = process.env.MT5_BRIDGE_PORT || "8765";
const apiKey = String(process.env.MT5_API_KEY || "").trim();
if (!apiKey) throw new Error(`MT5_API_KEY missing after loading ${bridgeEnv}`);
const bridgeBase = `http://${bridgeHost}:${bridgePort}`;

const [m15, m5, quote, spec, health, regime] = await Promise.all([
  getJson(bridgeBase, apiKey, `/v1/candles/${encodeURIComponent(symbol)}?timeframe=M15&count=320`),
  getJson(bridgeBase, apiKey, `/v1/candles/${encodeURIComponent(symbol)}?timeframe=M5&count=420`),
  getJson(bridgeBase, apiKey, `/v1/quotes/${encodeURIComponent(symbol)}`),
  getJson(bridgeBase, apiKey, `/v1/symbols/${encodeURIComponent(symbol)}/spec`),
  getJson(bridgeBase, apiKey, "/health"),
  getOptionalJson(`http://127.0.0.1:${Number(process.env.PORT || 3711)}/api/v1/phase7c/live-regime?symbol=${encodeURIComponent(symbol)}`),
]);

if (!Array.isArray(m15) || m15.length < 201) throw new Error(`Need >=201 M15 bars; got ${Array.isArray(m15) ? m15.length : 0}`);
if (!Array.isArray(m5) || m5.length < 10) throw new Error(`Need >=10 M5 bars; got ${Array.isArray(m5) ? m5.length : 0}`);

const index = m15.length - 1;
const current = m15[index];
const patterns = patternDiagnostics(m15, index);
const trigger = patterns.selected;
let finalCode = "NO_PATTERN_MATCH";
let finalReason = "Không có mẫu Trend 3 nến / 2 nến / Engulfing hợp lệ theo đúng thứ tự canonical.";
let m15St = { expected: trigger?.side ?? null, actual: null, pass: false };
let m5St = { expected: trigger?.side ?? null, actual: null, pass: false, closeTime: null };
let plan = null;

if (trigger) {
  const m15Supertrend = phase7BSupertrend(m15.slice(0, index + 1), 10, 3);
  const actualM15 = m15Supertrend.direction[index] ?? null;
  m15St = { expected: trigger.side, actual: actualM15, pass: actualM15 === trigger.side };

  let m5SignalIndex = m5.length - 1;
  while (m5SignalIndex >= 0 && Number(m5[m5SignalIndex].closeTime) > Number(current.closeTime)) m5SignalIndex -= 1;
  if (m5SignalIndex >= 9) {
    const m5Supertrend = phase7BSupertrend(m5.slice(0, m5SignalIndex + 1), 10, 3);
    const actualM5 = m5Supertrend.direction[m5SignalIndex] ?? null;
    m5St = { expected: trigger.side, actual: actualM5, pass: actualM5 === trigger.side, closeTime: m5[m5SignalIndex].closeTime };
  }

  if (!m15St.pass) {
    finalCode = "M15_SUPERTREND_MISMATCH";
    finalReason = `Có mẫu ${trigger.pattern} ${trigger.side}, nhưng Supertrend M15=${m15St.actual ?? "NONE"} không cùng hướng.`;
  } else if (!m5St.pass) {
    finalCode = "M5_SUPERTREND_MISMATCH";
    finalReason = `Mẫu + Supertrend M15 PASS, nhưng Supertrend M5=${m5St.actual ?? "NONE"} không cùng hướng ${trigger.side}.`;
  } else {
    const signalEntry = Number(current.close);
    const structuralStopDistance = trigger.side === "BUY" ? signalEntry - Number(trigger.patternExtreme) : Number(trigger.patternExtreme) - signalEntry;
    if (!(structuralStopDistance > 0)) {
      finalCode = "INVALID_STRUCTURE_DISTANCE";
      finalReason = `Pattern extreme không tạo structural stop hợp lệ (${round(structuralStopDistance)}).`;
    } else {
      const marketEntry = trigger.side === "BUY" ? Number(quote.ask) : Number(quote.bid);
      const marketStructuralDistance = trigger.side === "BUY" ? marketEntry - Number(trigger.patternExtreme) : Number(trigger.patternExtreme) - marketEntry;
      const state = marketStructuralDistance > MAX_INITIAL_SL_PRICE ? "WAIT_PULLBACK" : "ENTRY_IMMEDIATE";
      const stopDistance = marketStructuralDistance > MAX_INITIAL_SL_PRICE ? marketStructuralDistance : Math.max(MIN_INITIAL_SL_PRICE, marketStructuralDistance);
      const stopLoss = trigger.side === "BUY" ? marketEntry - stopDistance : marketEntry + stopDistance;
      plan = {
        side: trigger.side,
        pattern: trigger.pattern,
        signalEntry: round(signalEntry),
        marketEntry: round(marketEntry),
        patternExtreme: round(trigger.patternExtreme),
        signalStructuralStopDistance: round(structuralStopDistance),
        marketStructuralStopDistance: round(marketStructuralDistance),
        stopDistance: round(stopDistance),
        stopLoss: round(stopLoss, Number(spec.digits ?? 2)),
        entryState: state,
      };
      finalCode = state === "WAIT_PULLBACK" ? "WAIT_PULLBACK_STOP_GT_10" : "SIGNAL_READY";
      finalReason = state === "WAIT_PULLBACK"
        ? `Setup ${trigger.pattern} ${trigger.side} PASS, nhưng structural SL theo market=${round(marketStructuralDistance)} > 10; chờ pullback.`
        : `Setup ${trigger.pattern} ${trigger.side} PASS; M15/M5 Supertrend cùng hướng; structural SL đủ điều kiện entry.`;
    }
  }
}

const output = {
  schemaVersion: 2,
  source: "PHASE7C_TREND_DIAGNOSTICS_V2_READ_ONLY",
  generatedAt: Date.now(),
  symbol,
  account: { mode: health.accountMode ?? null, server: health.server ?? null, connected: Boolean(health.connected) },
  regime: regime ? { regime: regime.regime ?? null, confidence: regime.confidence ?? null, activeMode: regime.activeMode ?? null, recommendedMode: regime.recommendedMode ?? null } : null,
  candle: { closeTime: Number(current.closeTime), open: Number(current.open), high: Number(current.high), low: Number(current.low), close: Number(current.close) },
  patterns,
  supertrend: { m15: m15St, m5: m5St },
  plan,
  finalCode,
  finalReason,
  safety: { readOnly: true, orderSend: false, positionMutation: false, accountSwitch: false, botModeMutation: false, liveArmMutation: false },
};

console.log(`PHASE7C_TREND_DIAGNOSTICS_V2_CODE=${finalCode}`);
console.log(`PHASE7C_TREND_DIAGNOSTICS_V2_REASON=${finalReason}`);
for (const item of patterns.priority) console.log(`PHASE7C_TREND_DIAGNOSTICS_V2_PATTERN_${item.name}=${item.pass ? "PASS" : "FAIL"}|${item.reason}`);
console.log(`PHASE7C_TREND_DIAGNOSTICS_V2_M15_ST=${m15St.pass ? "PASS" : "FAIL"}|EXPECTED=${m15St.expected ?? "NONE"}|ACTUAL=${m15St.actual ?? "NONE"}`);
console.log(`PHASE7C_TREND_DIAGNOSTICS_V2_M5_ST=${m5St.pass ? "PASS" : "FAIL"}|EXPECTED=${m5St.expected ?? "NONE"}|ACTUAL=${m5St.actual ?? "NONE"}`);
console.log(JSON.stringify(output, null, 2));
console.log("PHASE7C_TREND_DIAGNOSTICS_V2=PASS");
