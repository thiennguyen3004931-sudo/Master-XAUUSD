import type {
  Phase4ShadowManagementConfig,
  Phase4ShadowReplayMetrics,
  Phase4ShadowTradeCase,
} from "../models";
import { Phase4ShadowReplayService } from "./Phase4ShadowReplayService";

export interface Phase4ManagementSweepVariant {
  id: string;
  management: Phase4ShadowManagementConfig;
  metrics: Phase4ShadowReplayMetrics;
}

export interface Phase4ManagementSweepResult {
  variants: Phase4ManagementSweepVariant[];
  bestByExpectancy: Phase4ManagementSweepVariant | null;
  bestByProfitFactor: Phase4ManagementSweepVariant | null;
  bestByNetPnl: Phase4ManagementSweepVariant | null;
}

export class Phase4ManagementSweepService {
  run(
    cases: readonly Phase4ShadowTradeCase[],
    configs: readonly Phase4ShadowManagementConfig[] = defaultSweepConfigs(),
  ): Phase4ManagementSweepResult {
    const variants = configs.map((management, index) => {
      const replay = new Phase4ShadowReplayService(management).run(cases);
      return {
        id: `P4D-${String(index + 1).padStart(2, "0")}`,
        management,
        metrics: replay.metrics,
      };
    });

    return {
      variants,
      bestByExpectancy: maxBy(variants, (item) => item.metrics.expectancy),
      bestByProfitFactor: maxBy(
        variants,
        (item) => item.metrics.profitFactor ?? Number.POSITIVE_INFINITY,
      ),
      bestByNetPnl: maxBy(variants, (item) => item.metrics.netPnl),
    };
  }

  format(result: Phase4ManagementSweepResult): string[] {
    const lines: string[] = [
      `PHASE4D_VARIANTS=${result.variants.length}`,
    ];

    for (const item of result.variants) {
      const m = item.metrics;
      const c = item.management;
      lines.push(
        `PHASE4D_VARIANT=${item.id}|BE_TRIGGER=${c.breakEvenTriggerPrice}|BE_OFFSET=${c.breakEvenOffsetPrice}|TRAIL_TRIGGER=${c.trailingTriggerPrice}|TRAIL_DISTANCE=${c.trailingDistancePrice}|FILLED=${m.filledTrades}|WR=${m.winRatePercent}|NET_PNL=${m.netPnl}|PF=${m.profitFactor ?? "INF"}|EXPECTANCY=${m.expectancy}|AVG_R=${m.averageRMultiple}`,
      );
    }

    if (result.bestByExpectancy) {
      lines.push(`PHASE4D_BEST_EXPECTANCY=${result.bestByExpectancy.id}`);
    }
    if (result.bestByProfitFactor) {
      lines.push(`PHASE4D_BEST_PROFIT_FACTOR=${result.bestByProfitFactor.id}`);
    }
    if (result.bestByNetPnl) {
      lines.push(`PHASE4D_BEST_NET_PNL=${result.bestByNetPnl.id}`);
    }

    lines.push("PHASE4D_RESEARCH_ONLY=PASS");
    return lines;
  }
}

export function defaultSweepConfigs(): Phase4ShadowManagementConfig[] {
  const breakEvenTriggers = [6, 8, 10];
  const breakEvenOffsets = [0.1, 1, 2];
  const trailingTriggers = [10, 12, 15];
  const trailingDistances = [3, 4, 6];

  const configs: Phase4ShadowManagementConfig[] = [];
  for (const breakEvenTriggerPrice of breakEvenTriggers) {
    for (const breakEvenOffsetPrice of breakEvenOffsets) {
      for (const trailingTriggerPrice of trailingTriggers) {
        if (trailingTriggerPrice < breakEvenTriggerPrice) continue;
        for (const trailingDistancePrice of trailingDistances) {
          configs.push({
            breakEvenTriggerPrice,
            breakEvenOffsetPrice,
            trailingTriggerPrice,
            trailingDistancePrice,
          });
        }
      }
    }
  }
  return configs;
}

function maxBy<T>(items: readonly T[], score: (item: T) => number): T | null {
  let best: T | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const value = score(item);
    if (Number.isNaN(value)) continue;
    if (best === null || value > bestScore) {
      best = item;
      bestScore = value;
    }
  }
  return best;
}
