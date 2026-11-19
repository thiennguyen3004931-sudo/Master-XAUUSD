import { describe, expect, it } from "vitest";
import { MockProvider, Timeframe } from "../src";

describe("MockProvider", () => {
  it("requires a connection", async () => {
    const provider = new MockProvider();
    await expect(provider.getLatestTick("XAUUSD")).rejects.toThrow(
      "not connected",
    );
  });

  it("generates deterministic valid candles", async () => {
    const provider = new MockProvider({ seed: 7, now: () => 1_000_000 });
    await provider.connect();

    const candles = await provider.getCandles("xauusd", Timeframe.M5, 5);

    expect(candles).toHaveLength(5);
    expect(candles[0]?.symbol).toBe("XAUUSD");
    expect(candles.every((item) => item.high >= item.low)).toBe(true);
  });
});
