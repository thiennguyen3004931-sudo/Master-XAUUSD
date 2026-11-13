import type {
  Phase4ShadowManagementConfig,
  Phase4ShadowReplayMetrics,
  Phase4ShadowTradeCase,
} from "../models";
import { Phase4ShadowReplayService } from "./Phase4ShadowReplayService";

export interface Phase4ContributionSlice {
  label: string;
  cases: number;
  metrics: Phase4ShadowReplayMetrics;
}

export interface Phase4ContributionDiagnosticsResult {
  management: Phase4ShadowManagementConfig;
  slices: Phase4ContributionSlice[];
}

const PHASE4G_MANAGEMENT: Phase4ShadowManagementConfig = {
  breakEvenTriggerPrice: 6,
  breakEvenOffsetPrice: 2,
  trailingTriggerPrice: 10,
  trailingDistancePrice: 5,
};

export class Phase4ContributionDiagnosticsService {
  run(
    cases: readonly Phase4ShadowTradeCase[],
    management: Phase4ShadowManagementConfig = PHASE4G_MANAGEMENT,
  ): Phase4ContributionDiagnosticsResult {
    const isCanonical = (item: Phase4ShadowTradeCase) =>
      (item.entrySource ?? "CANONICAL") === "CANONICAL";

    const definitions: Array<[string, (item: Phase4ShadowTradeCase) => boolean]> = [
      ["ALL", () => true],
      ["CANONICAL", isCanonical],
      ["RESCUED", (item) => !isCanonical(item)],
      ["BUY", (item) => item.side === "BUY"],
      ["SELL", (item) => item.side === "SELL"],
      ["CANONICAL_BUY", (item) => isCanonical(item) && item.side === "BUY"],
      ["CANONICAL_SELL", (item) => isCanonical(item) && item.side === "SELL"],
      ["RESCUED_BUY", (item) => !isCanonical(item) && item.side === "BUY"],
      ["RESCUED_SELL", (item) => !isCanonical(item) && item.side === "SELL"],
    ];

    const replayService = new Phase4ShadowReplayService(management);
    const slices = definitions.map(([label, predicate]) => {
      const selected = cases.filter(predicate);
      return {
        label,
        cases: selected.length,
        metrics: replayService.run(selected).metrics,
      };
    });

    return { management, slices };
  }

  format(result: Phase4ContributionDiagnosticsResult): string[] {
    const c = result.management;
    const lines = [
      `PHASE4G_CONFIG=BE_TRIGGER=${c.breakEvenTriggerPrice}|BE_OFFSET=${c.breakEvenOffsetPrice}|TRAIL_TRIGGER=${c.trailingTriggerPrice}|TRAIL_DISTANCE=${c.trailingDistancePrice}`,
    ];

    for (const slice of result.slices) {
      const m = slice.metrics;
      lines.push(
        `PHASE4G_SLICE=${slice.label}|CASES=${slice.cases}|WR=${m.winRatePercent}|NET_PNL=${m.netPnl}|PF=${m.profitFactor ?? "INF"}|EXPECTANCY=${m.expectancy}|AVG_R=${m.averageRMultiple}`,
      );
    }

    const canonical = result.slices.find((item) => item.label === "CANONICAL");
    const rescued = result.slices.find((item) => item.label === "RESCUED");
    if (canonical && rescued) {
      lines.push(`PHASE4G_RESCUE_NET_CONTRIBUTION=${rescued.metrics.netPnl}`);
      lines.push(`PHASE4G_CANONICAL_NET_CONTRIBUTION=${canonical.metrics.netPnl}`);
      lines.push(
        `PHASE4G_RESCUE_EDGE_STATUS=${rescued.metrics.expectancy > 0 && (rescued.metrics.profitFactor ?? Number.POSITIVE_INFINITY) > 1 ? "POSITIVE" : "NON_POSITIVE"}`,
      );
    }

    lines.push("PHASE4G_RESEARCH_ONLY=PASS");
    lines.push("PHASE4G_PRODUCTION_MUTATION=false");
    return lines;
  }
}
