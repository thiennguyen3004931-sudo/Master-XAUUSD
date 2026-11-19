import { describe, expect, it } from "vitest";
import type { Phase7Bar } from "../src/models";
import { phase7BSupertrend } from "../src/services/Phase7BSupertrendService";

function bar(index: number, open: number, high: number, low: number, close: number): Phase7Bar {
  return {
    openTime: index * 300_000,
    closeTime: (index + 1) * 300_000,
    open,
    high,
    low,
    close,
  };
}

describe("phase7BSupertrend", () => {
  it("uses a 10-bar ATR warmup and then flips BUY on a confirmed upside break", () => {
    const bars = Array.from({ length: 10 }, (_, i) => bar(i, 100, 101, 99, 100));
    bars.push(bar(10, 119, 121, 119, 120));

    const result = phase7BSupertrend(bars, 10, 3);

    expect(result.direction.slice(0, 9).every((value) => value === null)).toBe(true);
    expect(result.direction[9]).toBe("SELL");
    expect(result.direction[10]).toBe("BUY");
  });

  it("flips back SELL after a confirmed downside break", () => {
    const bars = Array.from({ length: 10 }, (_, i) => bar(i, 100, 101, 99, 100));
    bars.push(bar(10, 119, 121, 119, 120));
    bars.push(bar(11, 81, 81, 79, 80));

    const result = phase7BSupertrend(bars, 10, 3);

    expect(result.direction[10]).toBe("BUY");
    expect(result.direction[11]).toBe("SELL");
  });
});
