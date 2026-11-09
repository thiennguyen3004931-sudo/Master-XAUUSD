import type { Mt5BridgeTradingDayBoundary } from "../models";
import type { Mt5BridgeDeal, Mt5BridgePosition } from "../models";
import { Timeframe, type Candle } from "@xauusd/market-data";

export interface Mt5MarketDataClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

export interface Mt5HistoricalTick {
  symbol: string;
  brokerSymbol: string;
  timestamp: number;
  sequence: number;
  bid: number;
  ask: number;
  last: number;
  volume: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberField(
  row: Record<string, unknown>,
  key: string,
  index: number,
): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid MT5 candle[${index}].${key}`);
  }
  return value;
}

function stringField(
  row: Record<string, unknown>,
  key: string,
  index: number,
): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid MT5 candle[${index}].${key}`);
  }
  return value;
}

export class Mt5MarketDataClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(options: Mt5MarketDataClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 3_000;

    if (!this.baseUrl || !this.apiKey) {
      throw new Error("MT5 market-data client requires baseUrl and apiKey.");
    }
  }

  async getCandles(
    symbol: string,
    timeframe: Timeframe,
    count = 320,
  ): Promise<Candle[]> {
    if (!Number.isInteger(count) || count < 2 || count > 5000) {
      throw new Error("MT5 candle count must be an integer between 2 and 5000.");
    }

    const params = new URLSearchParams({
      timeframe: String(timeframe),
      count: String(count),
    });

    const payload = await this.getJson(
      `/v1/candles/${encodeURIComponent(symbol)}?${params.toString()}`,
    );

    if (!Array.isArray(payload)) {
      throw new Error("MT5 candles response is not an array.");
    }

    const expectedTimeframe = String(timeframe);

    return payload.map((item, index): Candle => {
      if (!isRecord(item)) {
        throw new Error(`Invalid MT5 candle[${index}] payload.`);
      }

      const rowSymbol = stringField(item, "symbol", index);
      const rowTimeframe = stringField(item, "timeframe", index);

      if (rowSymbol !== symbol) {
        throw new Error(`MT5 candle[${index}] symbol mismatch.`);
      }
      if (rowTimeframe !== expectedTimeframe) {
        throw new Error(`MT5 candle[${index}] timeframe mismatch.`);
      }

      const openTime = numberField(item, "openTime", index);
      const closeTime = numberField(item, "closeTime", index);
      const open = numberField(item, "open", index);
      const high = numberField(item, "high", index);
      const low = numberField(item, "low", index);
      const close = numberField(item, "close", index);
      const volume = numberField(item, "volume", index);
      const spreadValue = item.spread;
      const spread =
        typeof spreadValue === "number" && Number.isFinite(spreadValue)
          ? spreadValue
          : undefined;

      if (
        openTime >= closeTime ||
        high < low ||
        open < low ||
        open > high ||
        close < low ||
        close > high ||
        volume < 0 ||
        (spread !== undefined && spread < 0)
      ) {
        throw new Error(`MT5 candle[${index}] failed canonical validation.`);
      }

      return {
        symbol,
        timeframe,
        openTime,
        closeTime,
        open,
        high,
        low,
        close,
        volume,
        ...(spread === undefined ? {} : { spread }),
      };
    });
  }

  async getTradingDayBoundary(
    symbol: string,
  ): Promise<Mt5BridgeTradingDayBoundary> {
    const payload = await this.getJson(
      `/v1/session/day-boundary/${encodeURIComponent(symbol)}`,
    );

    if (
      typeof payload !== "object" ||
      payload === null ||
      typeof (payload as { currentStartTime?: unknown }).currentStartTime
        !== "number" ||
      !Number.isFinite(
        (payload as { currentStartTime: number }).currentStartTime,
      ) ||
      (payload as { currentStartTime: number }).currentStartTime <= 0 ||
      (payload as { source?: unknown }).source !== "MT5_D1_CURRENT_BAR"
    ) {
      throw new Error("Invalid MT5 trading-day boundary response.");
    }

    return payload as Mt5BridgeTradingDayBoundary;
  }

  async getDeals(
    fromMs: number,
    toMs: number,
    symbol?: string,
  ): Promise<Mt5BridgeDeal[]> {
    if (
      !Number.isFinite(fromMs) ||
      !Number.isFinite(toMs) ||
      fromMs < 0 ||
      toMs <= fromMs
    ) {
      throw new Error("Invalid MT5 deal-history range.");
    }

    const params = new URLSearchParams({
      fromMs: String(Math.trunc(fromMs)),
      toMs: String(Math.trunc(toMs)),
    });

    if (symbol) {
      params.set("symbol", symbol);
    }

    const payload = await this.getJson(
      `/v1/history/deals?${params.toString()}`,
    );

    if (!Array.isArray(payload)) {
      throw new Error("MT5 deal-history response is not an array.");
    }

    return payload as Mt5BridgeDeal[];
  }

  async getHistoricalTicks(
    symbol: string,
    fromMs: number,
    toMs: number,
  ): Promise<Mt5HistoricalTick[]> {
    if (
      !Number.isFinite(fromMs) ||
      !Number.isFinite(toMs) ||
      fromMs < 0 ||
      toMs <= fromMs
    ) {
      throw new Error("Invalid MT5 tick-history range.");
    }

    const params = new URLSearchParams({
      fromMs: String(Math.trunc(fromMs)),
      toMs: String(Math.trunc(toMs)),
    });
    const payload = await this.getJson(
      `/v1/history/ticks/${encodeURIComponent(symbol)}?${params.toString()}`,
    );

    if (!Array.isArray(payload)) {
      throw new Error("MT5 tick-history response is not an array.");
    }

    return payload.map((item, index): Mt5HistoricalTick => {
      if (!isRecord(item)) {
        throw new Error(`Invalid MT5 tick[${index}] payload.`);
      }
      const rowSymbol = item.symbol;
      const brokerSymbol = item.brokerSymbol;
      const timestamp = item.timestamp;
      const sequence = item.sequence;
      const bid = item.bid;
      const ask = item.ask;
      const last = item.last;
      const volume = item.volume;
      if (
        rowSymbol !== symbol ||
        typeof brokerSymbol !== "string" ||
        brokerSymbol.length === 0 ||
        typeof timestamp !== "number" ||
        !Number.isFinite(timestamp) ||
        typeof sequence !== "number" ||
        !Number.isInteger(sequence) ||
        sequence < 0 ||
        typeof bid !== "number" ||
        !Number.isFinite(bid) ||
        bid <= 0 ||
        typeof ask !== "number" ||
        !Number.isFinite(ask) ||
        ask <= 0 ||
        ask < bid ||
        typeof last !== "number" ||
        !Number.isFinite(last) ||
        last < 0 ||
        typeof volume !== "number" ||
        !Number.isFinite(volume) ||
        volume < 0
      ) {
        throw new Error(`MT5 tick[${index}] failed canonical validation.`);
      }
      return {
        symbol,
        brokerSymbol,
        timestamp,
        sequence,
        bid,
        ask,
        last,
        volume,
      };
    });
  }

  async getPositions(symbol?: string): Promise<Mt5BridgePosition[]> {
    const suffix = symbol
      ? `?symbol=${encodeURIComponent(symbol)}`
      : "";
    const payload = await this.getJson(`/v1/positions${suffix}`);

    if (!Array.isArray(payload)) {
      throw new Error("MT5 positions response is not an array.");
    }

    return payload as Mt5BridgePosition[];
  }

  private async getJson(path: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-MT5-API-Key": this.apiKey,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `MT5 market-data request failed (${response.status}): ${body.slice(0, 300)}`,
        );
      }

      return (await response.json()) as unknown;
    } finally {
      clearTimeout(timer);
    }
  }
}
