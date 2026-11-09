import { describe, expect, it } from "vitest";
import {
  Phase6M15TrendEngulfingService,
  type Phase6Bar,
} from "../src";

const M15 = 15 * 60_000;
const M5 = 5 * 60_000;

function buildM15(): Phase6Bar[] {
  const bars: Phase6Bar[] = [];
  for (let i = 0; i < 200; i += 1) {
    const open = 100 + i * 0.1;
    bars.push({
      openTime: i * M15,
      closeTime: (i + 1) * M15,
      open,
      high: open + 0.12,
      low: open - 0.08,
      close: open + 0.05,
      volume: 100 + i,
    });
  }
  bars.push({
    openTime: 200 * M15,
    closeTime: 201 * M15,
    open: 120,
    high: 120.2,
    low: 119.3,
    close: 119.5,
    volume: 250,
  });
  bars.push({
    openTime: 201 * M15,
    closeTime: 202 * M15,
    open: 119.4,
    high: 120.4,
    low: 119.2,
    close: 120.2,
    volume: 300,
  });
  return bars;
}

function buildM5(signalTimestamp: number): Phase6Bar[] {
  return [
    {
      openTime: signalTimestamp,
      closeTime: signalTimestamp + M5,
      open: 120.2,
      high: 126.5,
      low: 120.1,
      close: 126,
      volume: 100,
    },
    {
      openTime: signalTimestamp + M5,
      closeTime: signalTimestamp + 2 * M5,
      open: 126,
      high: 131,
      low: 125,
      close: 130,
      volume: 110,
    },
    {
      openTime: signalTimestamp + 2 * M5,
      closeTime: signalTimestamp + 3 * M5,
      open: 130,
      high: 130,
      low: 125.5,
      close: 126,
      volume: 120,
    },
  ];
}

describe("Phase6M15TrendEngulfingService", () => {
  it("creates a trend-aligned bullish engulfing trade and applies positive management", () => {
    const m15 = buildM15();
    const signalTimestamp = m15.at(-1)!.closeTime;
    const service = new Phase6M15TrendEngulfingService({ minConfluenceScore: 0 });
    const result = service.run({
      m15Bars: m15,
      m5Bars: buildM5(signalTimestamp),
      riskCapUsd: 10,
      tickSize: 0.01,
      tickValuePerLot: 1,
      minVolume: 0.01,
      volumeStep: 0.01,
    });

    expect(result.metrics.trendAligned).toBe(1);
    expect(result.metrics.signals).toBe(1);
    expect(result.metrics.buySignals).toBe(1);
    expect(result.metrics.filledTrades).toBe(1);
    expect(result.metrics.netPnl).toBeGreaterThan(0);
    expect(result.metrics.reachedPlus6).toBe(1);
    expect(result.metrics.reachedPlus10).toBe(1);
    expect(result.metrics.trailingActivated).toBe(1);
    expect(result.trades[0]!.initialRiskUsd).toBeLessThanOrEqual(10);
    expect(result.trades[0]!.exitReason).toBe("STOP");
  });

  it("blocks the same signal when broker minimum volume cannot fit the risk cap", () => {
    const m15 = buildM15();
    const service = new Phase6M15TrendEngulfingService({ minConfluenceScore: 0 });
    const result = service.run({
      m15Bars: m15,
      m5Bars: buildM5(m15.at(-1)!.closeTime),
      riskCapUsd: 0.05,
      tickSize: 0.01,
      tickValuePerLot: 1,
      minVolume: 0.01,
      volumeStep: 0.01,
    });

    expect(result.metrics.confluencePassed).toBe(1);
    expect(result.metrics.riskBlocked).toBe(1);
    expect(result.metrics.signals).toBe(0);
    expect(result.metrics.filledTrades).toBe(0);
  });

  it("keeps the research lane explicitly non-production", () => {
    const service = new Phase6M15TrendEngulfingService({ minConfluenceScore: 0 });
    const result = service.run({
      m15Bars: buildM15(),
      m5Bars: [],
      riskCapUsd: 10,
      tickSize: 0.01,
      tickValuePerLot: 1,
    });
    const lines = service.format(result);
    expect(lines).toContain("PHASE6_RESEARCH_ONLY=PASS");
    expect(lines).toContain("PHASE6_PRODUCTION_MUTATION=false");
  });
});
