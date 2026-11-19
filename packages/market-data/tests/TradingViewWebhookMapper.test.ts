import { describe, expect, it } from "vitest";
import { Timeframe, TradingViewWebhookMapper } from "../src";

describe("TradingViewWebhookMapper", () => {
  it("maps and normalizes a payload", () => {
    const candle = TradingViewWebhookMapper.toCandle({
      symbol: " xauusd ",
      timeframe: "m15",
      openTime: 1,
      closeTime: 2,
      open: 3300,
      high: 3310,
      low: 3290,
      close: 3305,
      volume: 1234,
    });

    expect(candle.symbol).toBe("XAUUSD");
    expect(candle.timeframe).toBe(Timeframe.M15);
  });

  it("rejects unsupported timeframes", () => {
    expect(() =>
      TradingViewWebhookMapper.toCandle({
        symbol: "XAUUSD",
        timeframe: "H2",
        openTime: 1,
        closeTime: 2,
        open: 3300,
        high: 3310,
        low: 3290,
        close: 3305,
        volume: 1234,
      }),
    ).toThrow("Unsupported timeframe");
  });
});
