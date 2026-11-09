import { describe, expect, it } from "vitest";
import {
  Phase6ADiagnosticsService,
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

function buildPriorM5(signalTimestamp: number): Phase6Bar[] {
  const bars: Phase6Bar[] = [];
  for (let i = 20; i > 0; i -= 1) {
    const closeTime = signalTimestamp - (i - 1) * M5;
    bars.push({
      openTime: closeTime - M5,
      closeTime,
      open: 119.6,
      high: 119.7,
      low: 119.5,
      close: 119.6,
      volume: 100,
    });
  }
  bars.push({
    openTime: signalTimestamp,
    closeTime: signalTimestamp + M5,
    open: 120.2,
    high: 120.25,
    low: 119.5,
    close: 119.8,
    volume: 120,
  });
  return bars;
}

describe("Phase6ADiagnosticsService", () => {
  it("reconciles the Phase 6 risk-blocked population and finds a no-lookahead M5 MA rescue", () => {
    const m15 = buildM15();
    const signalTimestamp = m15.at(-1)!.closeTime;
    const m5 = buildPriorM5(signalTimestamp);
    const request = {
      m15Bars: m15,
      m5Bars: m5,
      riskCapUsd: 0.5,
      tickSize: 0.01,
      tickValuePerLot: 1,
      minVolume: 0.01,
      volumeStep: 0.01,
    };

    const baseline = new Phase6M15TrendEngulfingService({ minConfluenceScore: 0 }).run(request);
    expect(baseline.metrics.riskBlocked).toBe(1);

    const diagnostics = new Phase6ADiagnosticsService().run(baseline, request);
    expect(diagnostics.riskBlockedCount).toBe(1);
    expect(diagnostics.rescuedCount).toBe(1);
    expect(diagnostics.rescueCases[0]!.rescueSource).toBe("M5_MA20");
    expect(diagnostics.rescueCases[0]!.rescueRiskUsd).toBeLessThanOrEqual(0.5);
    expect(diagnostics.rescueCases[0]!.rescueFillTime).toBe(signalTimestamp);
  });

  it("reports side contribution and keeps diagnostics research-only", () => {
    const m15 = buildM15();
    const signalTimestamp = m15.at(-1)!.closeTime;
    const request = {
      m15Bars: m15,
      m5Bars: [
        {
          openTime: signalTimestamp,
          closeTime: signalTimestamp + M5,
          open: 120.2,
          high: 126.5,
          low: 120.1,
          close: 126,
          volume: 100,
        },
      ],
      riskCapUsd: 10,
      tickSize: 0.01,
      tickValuePerLot: 1,
      minVolume: 0.01,
      volumeStep: 0.01,
    };
    const baseline = new Phase6M15TrendEngulfingService({ minConfluenceScore: 0 }).run(request);
    const service = new Phase6ADiagnosticsService();
    const diagnostics = service.run(baseline, request);
    const lines = service.format(diagnostics);

    expect(diagnostics.side.BUY.cases).toBe(1);
    expect(diagnostics.side.SELL.cases).toBe(0);
    expect(lines).toContain("PHASE6A_BASELINE_IMMUTABLE=PASS");
    expect(lines).toContain("PHASE6A_NO_RETUNE=PASS");
    expect(lines).toContain("PHASE6A_PRODUCTION_MUTATION=false");
  });
});
