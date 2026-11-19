import fs from "node:fs";
import path from "node:path";

type Bar = {
  openTime?: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  forming?: boolean;
};

type Quote = {
  bid: number;
  ask: number;
  timestamp: number;
};

type Pattern = {
  side: "BUY" | "SELL";
  pattern: "ENGULFING" | "TWO_CANDLE_BODY_DOMINANCE";
  extreme: number;
};

const enabled = !/^(0|false|no|off)$/i.test(process.env.ZIQ_PRE_CLOSE_ENTRY_ENABLED ?? "true");
const minSeconds = numberEnv("ZIQ_PRE_CLOSE_MIN_SECONDS", 5);
const maxSeconds = numberEnv("ZIQ_PRE_CLOSE_MAX_SECONDS", 10);
const symbol = process.env.ZIQ_DEMO_SYMBOL ?? "XAUUSD";
const workDir = process.env.ZIQ_DEMO_WORK_DIR ?? "";
const originalFetch = globalThis.fetch.bind(globalThis);
const m15Ms = 15 * 60_000;
const ENGULF_BODY_TOLERANCE_PRICE = 0.1;
let lastExposedCloseTime = -1;

if (!(minSeconds > 0 && maxSeconds > minSeconds && maxSeconds <= 30)) {
  throw new Error(`Invalid Phase 7B pre-close window ${minSeconds}-${maxSeconds}s.`);
}

console.log(`PHASE7B_PRE_CLOSE_ENTRY=${enabled ? "ENABLED" : "DISABLED"}`);
console.log(`PHASE7B_PRE_CLOSE_WINDOW_SECONDS=${minSeconds}-${maxSeconds}`);
console.log(`PHASE7B_PRE_CLOSE_ENGULF_BODY_TOLERANCE_PRICE=${ENGULF_BODY_TOLERANCE_PRICE}`);
console.log("PHASE7B_PRE_CLOSE_SIGNAL=PROVISIONAL_FORMING_M15");
console.log("PHASE7B_PRE_CLOSE_FALLBACK=CLOSED_M15_IF_NO_PRE_CLOSE_SIGNAL");

globalThis.fetch = async function phase7bPreCloseFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  if (!enabled || !isTargetCandleRequest(input, init)) {
    return originalFetch(input, init);
  }

  // Avoid extra MT5 reads for most of the 15-minute candle. This is only a
  // coarse wall-clock filter; the exact gate below uses the broker tick time.
  const wallRemainingMs = m15Ms - (Date.now() % m15Ms);
  const coarseMinMs = Math.max(0, (minSeconds - 3) * 1000);
  const coarseMaxMs = (maxSeconds + 3) * 1000;
  if (wallRemainingMs < coarseMinMs || wallRemainingMs > coarseMaxMs) {
    return originalFetch(input, init);
  }

  try {
    const requestUrl = requestUrlOf(input);
    const formingUrl = new URL(requestUrl);
    formingUrl.searchParams.set("includeForming", "true");
    const quoteUrl = new URL(`/v1/quotes/${encodeURIComponent(symbol)}`, formingUrl.origin);
    const headers = init?.headers ?? (input instanceof Request ? input.headers : undefined);

    const [formingResponse, quoteResponse] = await Promise.all([
      originalFetch(formingUrl, init),
      originalFetch(quoteUrl, { method: "GET", headers }),
    ]);

    if (!formingResponse.ok || !quoteResponse.ok) {
      return originalFetch(input, init);
    }

    const bars = (await formingResponse.clone().json()) as Bar[];
    const quote = (await quoteResponse.json()) as Quote;
    const current = bars.at(-1);
    if (!current || current.forming !== true) {
      return originalFetch(input, init);
    }

    if (current.closeTime === lastExposedCloseTime) {
      // Once a provisional candle has been exposed to the controller, all
      // subsequent reads for that same M15 return closed bars. This prevents
      // position management from treating the still-forming candle as closed.
      return originalFetch(input, init);
    }

    const tickTimestamp = Number(quote.timestamp);
    const brokerNow = Number.isFinite(tickTimestamp) && Math.abs(Date.now() - tickTimestamp) <= 30_000
      ? tickTimestamp
      : Date.now();
    const remainingMs = current.closeTime - brokerNow;
    if (remainingMs < minSeconds * 1000 || remainingMs > maxSeconds * 1000) {
      return originalFetch(input, init);
    }

    const candidate = provisionalEntryCandidate(bars);
    if (!candidate) {
      // Do not expose the forming candle when the provisional Pattern + MA gate
      // is not valid. The controller therefore keeps its prior closed-candle
      // state and can evaluate again on the next one-second polling cycle.
      return originalFetch(input, init);
    }

    lastExposedCloseTime = current.closeTime;
    const secondsBeforeClose = Math.round(remainingMs) / 1000;
    const event = {
      timestamp: new Date().toISOString(),
      type: "PRE_CLOSE_SIGNAL_READY",
      side: candidate.side,
      pattern: candidate.pattern,
      formingM15CloseTime: current.closeTime,
      secondsBeforeClose,
      provisional: true,
      entryRule: "PATTERN_PLUS_MA",
      engulfBodyTolerancePrice: ENGULF_BODY_TOLERANCE_PRICE,
      fvgRequiredForEntry: false,
    };
    appendJournal(event);
    console.log(`PHASE7B_PRE_CLOSE_SIGNAL_READY=${candidate.side}|PATTERN=${candidate.pattern}|SECONDS_BEFORE_CLOSE=${secondsBeforeClose.toFixed(3)}`);

    // Return the already-fetched forming response exactly once. The unchanged
    // Phase 7B controller then applies its canonical Pattern + MA + structural
    // SL checks and normal DEMO order guard before any order is submitted.
    return formingResponse;
  } catch (error) {
    console.error(`PHASE7B_PRE_CLOSE_HOOK_ERROR=${errorMessage(error)}`);
    return originalFetch(input, init);
  }
};

function isTargetCandleRequest(input: string | URL | Request, init?: RequestInit): boolean {
  const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method !== "GET") return false;
  try {
    const url = new URL(requestUrlOf(input));
    if (!url.pathname.endsWith(`/v1/candles/${encodeURIComponent(symbol)}`)) return false;
    if ((url.searchParams.get("timeframe") ?? "M15").toUpperCase() !== "M15") return false;
    if (/^(1|true|yes|on)$/i.test(url.searchParams.get("includeForming") ?? "false")) return false;
    return true;
  } catch {
    return false;
  }
}

function provisionalEntryCandidate(bars: Bar[]): Pattern | null {
  const index = bars.length - 1;
  if (index < 200) return null;
  const current = bars[index]!;
  const pattern = detectPattern(bars, index);
  if (!pattern) return null;

  const closes = bars.slice(0, index + 1).map((bar) => bar.close);
  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);
  const ma200 = sma(closes, 200);
  const trendAligned = pattern.side === "BUY"
    ? ma20 > ma50 && ma50 > ma200 && current.close > ma20
    : ma20 < ma50 && ma50 < ma200 && current.close < ma20;
  if (!trendAligned) return null;

  const structuralStopDistance = pattern.side === "BUY"
    ? current.close - pattern.extreme
    : pattern.extreme - current.close;
  if (!(structuralStopDistance > 0)) return null;

  return pattern;
}

function detectPattern(bars: Bar[], index: number): Pattern | null {
  const current = bars[index]!;
  const previous = bars[index - 1]!;

  if (
    isBearish(previous) &&
    isBullish(current) &&
    current.open <= previous.close + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 &&
    current.close + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 >= previous.open
  ) {
    return { side: "BUY", pattern: "ENGULFING", extreme: current.low };
  }
  if (
    isBullish(previous) &&
    isBearish(current) &&
    current.open + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 >= previous.close &&
    current.close <= previous.open + ENGULF_BODY_TOLERANCE_PRICE + 1e-9
  ) {
    return { side: "SELL", pattern: "ENGULFING", extreme: current.high };
  }

  if (index < 2) return null;
  const priorOpposite = bars[index - 2]!;
  const first = bars[index - 1]!;
  const priorBody = bodySize(priorOpposite);
  const firstBody = bodySize(first);
  const combinedBody = firstBody + bodySize(current);
  const firstBodyStillSmaller = firstBody < priorBody;

  if (
    isBearish(priorOpposite) &&
    isBullish(first) &&
    isBullish(current) &&
    firstBodyStillSmaller &&
    combinedBody > priorBody
  ) {
    return {
      side: "BUY",
      pattern: "TWO_CANDLE_BODY_DOMINANCE",
      extreme: Math.min(priorOpposite.low, first.low, current.low),
    };
  }
  if (
    isBullish(priorOpposite) &&
    isBearish(first) &&
    isBearish(current) &&
    firstBodyStillSmaller &&
    combinedBody > priorBody
  ) {
    return {
      side: "SELL",
      pattern: "TWO_CANDLE_BODY_DOMINANCE",
      extreme: Math.max(priorOpposite.high, first.high, current.high),
    };
  }
  return null;
}

function appendJournal(event: Record<string, unknown>): void {
  if (!workDir) return;
  try {
    fs.mkdirSync(workDir, { recursive: true });
    fs.appendFileSync(
      path.join(workDir, "phase7b-demo-events.jsonl"),
      `${JSON.stringify(event)}\n`,
      "utf8",
    );
  } catch (error) {
    console.error(`PHASE7B_PRE_CLOSE_JOURNAL_ERROR=${errorMessage(error)}`);
  }
}

function requestUrlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function isBullish(bar: Bar): boolean {
  return bar.close > bar.open;
}

function isBearish(bar: Bar): boolean {
  return bar.close < bar.open;
}

function bodySize(bar: Bar): number {
  return Math.abs(bar.close - bar.open);
}

function sma(values: number[], period: number): number {
  if (values.length < period) throw new Error(`Not enough M15 values for SMA${period}.`);
  return values.slice(-period).reduce((sum, value) => sum + value, 0) / period;
}

function numberEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric env ${name}.`);
  return parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
