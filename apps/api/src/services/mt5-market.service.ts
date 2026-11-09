import {
  Mt5MarketDataClient,
  type Mt5BridgeQuote,
  type Mt5BridgeSymbolSpec,
} from "@xauusd/mt5-broker";
import { Timeframe, type Candle } from "@xauusd/market-data";
import { getMt5Telemetry } from "./mt5.service";

export interface Mt5BrokerAccountSnapshot {
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  profit: number;
  leverage: number;
  currency: string;
  server: string;
}

export interface Mt5RealMarketSnapshot {
  candles: Candle[];
  quote: Mt5BridgeQuote;
  spec: Mt5BridgeSymbolSpec;
account: Mt5BrokerAccountSnapshot;
}

let cachedClient:
  | {
      key: string;
      client: Mt5MarketDataClient;
    }
  | undefined;

function getClient(): Mt5MarketDataClient {
  const baseUrl = process.env.MT5_BRIDGE_BASE_URL?.trim() ?? "";
  const apiKey = process.env.MT5_BRIDGE_API_KEY?.trim() ?? "";
  const timeoutText = process.env.MT5_BRIDGE_REQUEST_TIMEOUT_MS?.trim();
  const parsedTimeout = timeoutText ? Number(timeoutText) : 3_000;
  const timeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 3_000;

  if (!baseUrl || !apiKey) {
    throw new Error(
      "MT5 real market pipeline is not configured (base URL/API key missing).",
    );
  }

  const key = `${baseUrl}|${apiKey}|${timeoutMs}`;
  if (!cachedClient || cachedClient.key !== key) {
    cachedClient = {
      key,
      client: new Mt5MarketDataClient({
        baseUrl,
        apiKey,
        timeoutMs,
      }),
    };
  }
  return cachedClient.client;
}

function validateSeries(
  symbol: string,
  timeframe: Timeframe,
  candles: Candle[],
  expectedCount: number,
): void {
  if (candles.length !== expectedCount) {
    throw new Error(
      `MT5 history incomplete: ${candles.length}/${expectedCount} candles.`,
    );
  }

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index]!;

    if (candle.symbol !== symbol || candle.timeframe !== timeframe) {
      throw new Error(`MT5 candle[${index}] identity mismatch.`);
    }

    if (
      candle.low > candle.open ||
      candle.open > candle.high ||
      candle.low > candle.close ||
      candle.close > candle.high ||
      candle.high < candle.low
    ) {
      throw new Error(`MT5 candle[${index}] OHLC invariant failed.`);
    }

    if (
      index > 0 &&
      candles[index - 1]!.openTime >= candle.openTime
    ) {
      throw new Error("MT5 candle timestamps are not strictly ascending.");
    }
  }
}

export async function getMt5TradingDayBoundary(
  symbol: string,
) {
  return getClient().getTradingDayBoundary(symbol);
}

export async function getMt5DealHistory(
  fromMs: number,
  toMs: number,
  symbol?: string,
) {
  return getClient().getDeals(fromMs, toMs, symbol);
}

export async function getMt5AllPositions() {
  return getClient().getPositions();
}

export async function getMt5HistoricalTicks(
  symbol: string,
  fromMs: number,
  toMs: number,
) {
  return getClient().getHistoricalTicks(symbol, fromMs, toMs);
}

export async function getMt5RealMarketData(
  symbol: string,
  timeframe: Timeframe,
  count = 320,
): Promise<Mt5RealMarketSnapshot> {
  const telemetry = await getMt5Telemetry(symbol);

  const health = telemetry.health;
  const quote = telemetry.quote;
  const spec = telemetry.spec;

  if (
    !telemetry.enabled ||
    !telemetry.configured ||
    !telemetry.reachable ||
    telemetry.status !== "HEALTHY" ||
    !health?.connected
  ) {
    throw new Error(`MT5 market pipeline unavailable: ${telemetry.message}`);
  }

  if (health.accountMode !== "demo") {
    throw new Error("MT5 market pipeline is DEMO-only at Phase 3B.");
  }

  if (health.tradingEnabled) {
    throw new Error(
      "Phase 3B requires MT5_TRADING_ENABLED=false. Market pipeline failed closed.",
    );
  }

  // Phase 3D.2: open MT5 positions are now reconciled by the
  // portfolio risk pipeline. Do not reject market data merely
  // because an XAUUSD position is open.

  if (!quote || !spec) {
    throw new Error("MT5 quote/spec is unavailable.");
  }

  if (
    !Number.isFinite(quote.bid) ||
    !Number.isFinite(quote.ask) ||
    quote.bid <= 0 ||
    quote.ask <= 0 ||
    quote.ask < quote.bid ||
    quote.spread < 0
  ) {
    throw new Error("MT5 live quote failed validation.");
  }

  const accountBalance = health.accountBalance;
  const accountEquity = health.accountEquity;
  const accountMargin = health.accountMargin;
  const accountFreeMargin = health.accountFreeMargin;
  const accountProfit = health.accountProfit;
  const accountLeverage = health.accountLeverage;
  const accountCurrency = health.accountCurrency?.trim();

  if (
    typeof accountBalance !== "number" ||
    !Number.isFinite(accountBalance) ||
    accountBalance <= 0 ||
    typeof accountEquity !== "number" ||
    !Number.isFinite(accountEquity) ||
    accountEquity <= 0 ||
    typeof accountMargin !== "number" ||
    !Number.isFinite(accountMargin) ||
    accountMargin < 0 ||
    typeof accountFreeMargin !== "number" ||
    !Number.isFinite(accountFreeMargin) ||
    accountFreeMargin < 0 ||
    typeof accountProfit !== "number" ||
    !Number.isFinite(accountProfit) ||
    typeof accountLeverage !== "number" ||
    !Number.isFinite(accountLeverage) ||
    accountLeverage <= 0 ||
    !accountCurrency
  ) {
    throw new Error("MT5 DEMO account telemetry failed validation.");
  }

  const candles = await getClient().getCandles(symbol, timeframe, count);
  validateSeries(symbol, timeframe, candles, count);

  return {
    candles,
    quote,
    spec,
    account: {
      balance: accountBalance,
      equity: accountEquity,
      margin: accountMargin,
      freeMargin: accountFreeMargin,
      profit: accountProfit,
      leverage: accountLeverage,
      currency: accountCurrency,
      server: health.server ?? "MT5 Demo",
    },
  };
}

