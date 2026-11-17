import { describe, expect, it } from "vitest";
import {
  InMemoryCandleRepository,
  Timeframe,
  type Candle,
} from "../src";

const candle = (openTime: number, close: number): Candle => ({
  symbol: "XAUUSD",
  timeframe: Timeframe.M1,
  openTime,
  closeTime: openTime + 59_999,
  open: close - 1,
  high: close + 1,
  low: close - 2,
  close,
  volume: 1000,
});

describe("InMemoryCandleRepository", () => {
  it("stores candles in time order and replaces duplicate openTime", async () => {
    const repository = new InMemoryCandleRepository();

    await repository.saveMany([candle(2, 200), candle(1, 100)]);
    await repository.save(candle(2, 250));

    const history = await repository.getHistory("XAUUSD", Timeframe.M1, 10);

    expect(history.map((item) => item.openTime)).toEqual([1, 2]);
    expect(history[1]?.close).toBe(250);
  });

  it("returns defensive copies", async () => {
    const repository = new InMemoryCandleRepository();
    await repository.save(candle(1, 100));

    const latest = await repository.getLatest("XAUUSD", Timeframe.M1);
    if (!latest) throw new Error("Expected a candle");
    latest.close = 999;

    const stored = await repository.getLatest("XAUUSD", Timeframe.M1);
    expect(stored?.close).toBe(100);
  });
});
