import { describe, expect, it } from "vitest";
import { OrderSide } from "@xauusd/types";
import {
  AiDatasetExporter,
  AiDriftMonitor,
  AiFeatureExtractor
} from "../src";
import {
  createContext
} from "./fixtures";

describe("dataset and drift services", () => {
  it("exports a labeled JSONL record", () => {
    const features =
      new AiFeatureExtractor().extract(
        createContext()
      );
    const exporter =
      new AiDatasetExporter();
    const record = exporter.label(
      exporter.createUnlabeled(
        features,
        "CONFIRM"
      ),
      {
        id: "trade-1",
        symbol: "XAUUSD",
        side: OrderSide.BUY,
        strategyId: "BREAKOUT_RETEST",
        entryTime: 1,
        exitTime: 2,
        entryPrice: 2400,
        averageExitPrice: 2410,
        initialVolume: 0.2,
        grossPnl: 200,
        commission: 7,
        netPnl: 193,
        rMultiple: 1.93,
        durationMinutes: 60,
        exitReason: "TAKE_PROFIT",
        partialExits: []
      }
    );

    expect(record.label?.profitable).toBe(true);
    expect(
      exporter.toJsonLines([record])
    ).toContain('"realizedRMultiple":1.93');
  });

  it("detects a large feature distribution shift", () => {
    const extractor =
      new AiFeatureExtractor();
    const baseline = Array.from(
      { length: 20 },
      () => extractor.extract(createContext())
    );
    const current = baseline.map((item) => ({
      ...item,
      volatilityPercent:
        item.volatilityPercent + 10
    }));

    const report =
      new AiDriftMonitor({
        normalizedShiftThreshold: 0.5
      }).compare(
        baseline,
        current,
        123
      );

    expect(report.drifted).toBe(true);
    expect(
      report.metrics.find(
        (metric) =>
          metric.feature ===
          "volatilityPercent"
      )?.drifted
    ).toBe(true);
  });
});
