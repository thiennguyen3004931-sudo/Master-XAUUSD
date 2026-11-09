import fs from "node:fs";
import path from "node:path";
import {
  Phase7BPullbackEntryService,
  phase7BSupertrend,
  type Phase7Bar,
  type Phase7BPendingPullback,
} from "@xauusd/risk-engine";

type Health = {
  status: "ok" | "degraded";
  connected: boolean;
  accountLogin?: number;
  accountMode?: "demo" | "contest" | "real";
  server?: string;
};

type Quote = {
  symbol: string;
  bid: number;
  ask: number;
  spread: number;
  timestamp: number;
};

type ShadowState = {
  version: 1;
  lastEvaluatedM15Close: number;
  lastEvaluatedM5Close: number;
  pending: Phase7BPendingPullback | null;
};

type Pattern = {
  side: "BUY" | "SELL";
  pattern: "ENGULFING" | "TWO_CANDLE_BODY_DOMINANCE" | "THREE_CANDLE_BODY_DOMINANCE";
  extreme: number;
};

const symbol = process.env.ZIQ_DEMO_SYMBOL ?? "XAUUSD";
const intervalSeconds = Math.max(1, Number(process.env.ZIQ_PHASE7B_SHADOW_INTERVAL_SECONDS ?? "5"));
const waitMinutes = Math.max(1, Number(process.env.ZIQ_PHASE7B_PULLBACK_WAIT_MINUTES ?? "60"));
const workDir = requiredEnv("ZIQ_DEMO_WORK_DIR");
const bridgeEnvPath = process.env.ZIQ_BRIDGE_ENV ?? path.resolve("packages/mt5-broker/bridge/.env.phase7b-demo");
const MAX_STRUCTURAL_SL = 10;
const ENGULF_BODY_TOLERANCE_PRICE = 0.1;

loadEnvFile(bridgeEnvPath);
const bridgeHost = process.env.MT5_BRIDGE_HOST ?? "127.0.0.1";
const bridgePort = process.env.MT5_BRIDGE_PORT ?? "8765";
const apiKey = requiredEnv("MT5_API_KEY");
const bridgeBase = `http://${bridgeHost}:${bridgePort}`;

fs.mkdirSync(workDir, { recursive: true });
const statePath = path.join(workDir, "phase7b-wait-pullback-shadow-state.json");
const journalPath = path.join(workDir, "phase7b-wait-pullback-shadow-events.jsonl");
const entryService = new Phase7BPullbackEntryService();
let state = loadState();

console.log("PHASE7B_WAIT_PULLBACK_SHADOW=ON");
console.log("PHASE7B_WAIT_PULLBACK_EXECUTION_MUTATION=False");
console.log("PHASE7B_WAIT_PULLBACK_REAL_ACCOUNT_ALLOWED=False");
console.log("PHASE7B_WAIT_PULLBACK_ENTRY_GATE=3_PATTERNS_PLUS_SUPERTREND_M15_M5_10_3");
console.log(`PHASE7B_WAIT_PULLBACK_MAX_STRUCTURAL_SL=${MAX_STRUCTURAL_SL}`);
console.log(`PHASE7B_WAIT_PULLBACK_WAIT_MINUTES=${waitMinutes}`);
console.log(`PHASE7B_WAIT_PULLBACK_STATE=${statePath}`);
console.log(`PHASE7B_WAIT_PULLBACK_JOURNAL=${journalPath}`);

await preflight();

while (true) {
  try {
    await cycle();
  } catch (error) {
    journal("SHADOW_CYCLE_ERROR", { message: errorMessage(error) });
  }
  await sleep(intervalSeconds * 1000);
}

async function preflight(): Promise<void> {
  const health = await get<Health>("/health");
  if (!health.connected || health.status !== "ok") throw new Error("MT5 bridge is not healthy/connected.");
  if (health.accountMode !== "demo") throw new Error(`Phase 7B shadow requires DEMO account, got ${health.accountMode ?? "unknown"}.`);
  console.log(`PHASE7B_WAIT_PULLBACK_ACCOUNT_LOGIN=${health.accountLogin ?? "UNKNOWN"}`);
  console.log(`PHASE7B_WAIT_PULLBACK_ACCOUNT_MODE=${health.accountMode}`);
  console.log(`PHASE7B_WAIT_PULLBACK_SERVER=${health.server ?? "UNKNOWN"}`);
}

async function cycle(): Promise<void> {
  const [m15, m5, quote] = await Promise.all([
    get<Phase7Bar[]>(`/v1/candles/${encodeURIComponent(symbol)}?timeframe=M15&count=360`),
    get<Phase7Bar[]>(`/v1/candles/${encodeURIComponent(symbol)}?timeframe=M5&count=720`),
    get<Quote>(`/v1/quotes/${encodeURIComponent(symbol)}`),
  ]);
  if (m15.length < 20 || m5.length < 20) return;

  const st15 = phase7BSupertrend(m15, 10, 3);
  const st5 = phase7BSupertrend(m5, 10, 3);
  const latestM15 = m15.at(-1)!;
  const latestM5 = m5.at(-1)!;

  if (state.pending) {
    if (latestM5.closeTime <= state.lastEvaluatedM5Close) return;
    state.lastEvaluatedM5Close = latestM5.closeTime;
    saveState();

    const pending = state.pending;
    const latestM15Index = latestClosedIndex(m15, latestM5.closeTime);
    const latestM5Index = m5.length - 1;
    const m15Aligned = latestM15Index >= 0 && st15.direction[latestM15Index] === pending.side;
    const m5Aligned = st5.direction[latestM5Index] === pending.side;
    const marketEntry = pending.side === "BUY" ? quote.ask : quote.bid;

    const result = entryService.evaluatePullback({
      pending,
      timestamp: latestM5.closeTime,
      candidateEntryPrice: marketEntry,
      barLow: latestM5.low,
      barHigh: latestM5.high,
      setupStillValid: true,
      m15SupertrendAligned: m15Aligned,
      m5SupertrendAligned: m5Aligned,
    });

    journal(result.state, {
      signalId: pending.signalId,
      side: pending.side,
      pattern: pending.pattern,
      structuralStopPrice: pending.structuralStopPrice,
      structuralStopDistanceAtSignal: pending.structuralStopDistanceAtSignal,
      structuralStopDistanceNow: result.structuralStopDistance,
      marketEntry,
      m15Aligned,
      m5Aligned,
      m5CloseTime: latestM5.closeTime,
      expiresAt: pending.expiresAt,
    });

    if (result.terminal) {
      state.pending = null;
      saveState();
    }
    return;
  }

  if (latestM15.closeTime <= state.lastEvaluatedM15Close) return;
  state.lastEvaluatedM15Close = latestM15.closeTime;
  saveState();

  const pattern = detectPattern(m15, m15.length - 1);
  if (!pattern) {
    journal("M15_NO_VALID_PATTERN", { m15CloseTime: latestM15.closeTime });
    return;
  }

  const m15Aligned = st15.direction[m15.length - 1] === pattern.side;
  const m5IndexAtSignal = latestClosedIndex(m5, latestM15.closeTime);
  const m5Aligned = m5IndexAtSignal >= 0 && st5.direction[m5IndexAtSignal] === pattern.side;
  if (!m15Aligned || !m5Aligned) {
    journal("M15_SIGNAL_REJECTED_SUPERTREND", {
      m15CloseTime: latestM15.closeTime,
      side: pattern.side,
      pattern: pattern.pattern,
      m15Aligned,
      m5Aligned,
    });
    return;
  }

  const signalId = `p7b-shadow-${latestM15.closeTime}-${pattern.side}-${pattern.pattern}`;
  const decision = entryService.decideInitial({
    signalId,
    side: pattern.side,
    pattern: pattern.pattern,
    signalTimestamp: latestM15.closeTime,
    referenceEntryPrice: latestM15.close,
    structuralStopPrice: pattern.extreme,
    maxStopDistancePrice: MAX_STRUCTURAL_SL,
    waitMinutes,
  });

  if (decision.state === "ENTRY_IMMEDIATE") {
    journal("ENTRY_IMMEDIATE", {
      signalId,
      side: pattern.side,
      pattern: pattern.pattern,
      signalEntry: latestM15.close,
      structuralStopPrice: pattern.extreme,
      structuralStopDistance: decision.structuralStopDistance,
      m15CloseTime: latestM15.closeTime,
      executionMutation: false,
    });
    return;
  }

  state.pending = decision.pending;
  state.lastEvaluatedM5Close = latestM15.closeTime;
  saveState();
  journal("WAIT_PULLBACK", {
    signalId,
    side: pattern.side,
    pattern: pattern.pattern,
    signalEntry: latestM15.close,
    structuralStopPrice: pattern.extreme,
    structuralStopDistance: decision.structuralStopDistance,
    expiresAt: decision.pending!.expiresAt,
    executionMutation: false,
  });
}

function detectPattern(bars: readonly Phase7Bar[], index: number): Pattern | null {
  const current = bars[index];
  const previous = bars[index - 1];
  if (!current || !previous) return null;

  if (
    bearish(previous) && bullish(current) &&
    current.open <= previous.close + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 &&
    current.close + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 >= previous.open
  ) {
    return { side: "BUY", pattern: "ENGULFING", extreme: current.low };
  }
  if (
    bullish(previous) && bearish(current) &&
    current.open + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 >= previous.close &&
    current.close <= previous.open + ENGULF_BODY_TOLERANCE_PRICE + 1e-9
  ) {
    return { side: "SELL", pattern: "ENGULFING", extreme: current.high };
  }

  if (index >= 2) {
    const a = bars[index - 2]!;
    const b = bars[index - 1]!;
    const bodyA = body(a);
    const bodyB = body(b);
    const bodyD = body(current);
    if (bearish(a) && bullish(b) && bullish(current) && bodyB < bodyA && bodyB + bodyD > bodyA) {
      return { side: "BUY", pattern: "TWO_CANDLE_BODY_DOMINANCE", extreme: Math.min(a.low, b.low, current.low) };
    }
    if (bullish(a) && bearish(b) && bearish(current) && bodyB < bodyA && bodyB + bodyD > bodyA) {
      return { side: "SELL", pattern: "TWO_CANDLE_BODY_DOMINANCE", extreme: Math.max(a.high, b.high, current.high) };
    }
  }

  if (index >= 3) {
    const a = bars[index - 3]!;
    const b = bars[index - 2]!;
    const c = bars[index - 1]!;
    const bodyA = body(a);
    const bodyB = body(b);
    const bodyC = body(c);
    const bodyD = body(current);
    if (
      bearish(a) && bullish(b) && bullish(c) && bullish(current) &&
      bodyB < bodyA && bodyB + bodyC <= bodyA + 1e-9 && bodyB + bodyC + bodyD > bodyA
    ) {
      return { side: "BUY", pattern: "THREE_CANDLE_BODY_DOMINANCE", extreme: Math.min(a.low, b.low, c.low, current.low) };
    }
    if (
      bullish(a) && bearish(b) && bearish(c) && bearish(current) &&
      bodyB < bodyA && bodyB + bodyC <= bodyA + 1e-9 && bodyB + bodyC + bodyD > bodyA
    ) {
      return { side: "SELL", pattern: "THREE_CANDLE_BODY_DOMINANCE", extreme: Math.max(a.high, b.high, c.high, current.high) };
    }
  }
  return null;
}

function latestClosedIndex(bars: readonly Phase7Bar[], timestamp: number): number {
  let result = -1;
  for (let i = 0; i < bars.length; i += 1) {
    if (bars[i]!.closeTime <= timestamp) result = i;
    else break;
  }
  return result;
}

function bullish(bar: Phase7Bar): boolean { return bar.close > bar.open; }
function bearish(bar: Phase7Bar): boolean { return bar.close < bar.open; }
function body(bar: Phase7Bar): number { return Math.abs(bar.close - bar.open); }

function loadState(): ShadowState {
  if (!fs.existsSync(statePath)) {
    return { version: 1, lastEvaluatedM15Close: 0, lastEvaluatedM5Close: 0, pending: null };
  }
  const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as ShadowState;
  if (parsed.version !== 1) throw new Error("Unsupported Phase 7B wait-pullback shadow state version.");
  return parsed;
}

function saveState(): void {
  const temp = `${statePath}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(temp, statePath);
}

function journal(type: string, data: Record<string, unknown>): void {
  const row = { timestamp: new Date().toISOString(), type, ...data };
  fs.appendFileSync(journalPath, `${JSON.stringify(row)}\n`, "utf8");
  console.log(`PHASE7B_WAIT_PULLBACK_EVENT=${JSON.stringify(row)}`);
}

function loadEnvFile(file: string): void {
  if (!fs.existsSync(file)) throw new Error(`Bridge env file not found: ${file}`);
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    const name = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[name] === undefined) process.env[name] = value;
  }
}

async function get<T>(endpoint: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${bridgeBase}${endpoint}`, {
      headers: { "x-mt5-api-key": apiKey },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`MT5 bridge GET ${endpoint} failed ${response.status}: ${text}`);
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env ${name}`);
  return value;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
