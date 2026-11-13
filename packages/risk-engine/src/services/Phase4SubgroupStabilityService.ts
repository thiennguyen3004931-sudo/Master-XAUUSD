import type {
  Phase4ShadowManagementConfig,
  Phase4ShadowReplayMetrics,
  Phase4ShadowTradeCase,
} from "../models";
import { Phase4ShadowReplayService } from "./Phase4ShadowReplayService";

export type Phase4SubgroupLabel =
  | "CANONICAL_BUY"
  | "CANONICAL_SELL"
  | "RESCUED_BUY"
  | "RESCUED_SELL";

export type Phase4SubgroupStabilityStatus =
  | "STABLE_POSITIVE"
  | "UNSTABLE_POSITIVE"
  | "NON_POSITIVE";

export interface Phase4SubgroupFoldMetrics {
  fold: number;
  cases: number;
  metrics: Phase4ShadowReplayMetrics;
}

export interface Phase4SubgroupStability {
  label: Phase4SubgroupLabel;
  cases: number;
  activeFolds: number;
  positiveExpectancyFolds: number;
  positiveProfitFactorFolds: number;
  positiveNetPnlFolds: number;
  requiredPositiveFolds: number;
  aggregateMetrics: Phase4ShadowReplayMetrics;
  folds: Phase4SubgroupFoldMetrics[];
  status: Phase4SubgroupStabilityStatus;
}

export interface Phase4SubgroupStabilityResult {
  management: Phase4ShadowManagementConfig;
  foldCount: number;
  groups: Phase4SubgroupStability[];
  stablePositiveGroups: Phase4SubgroupLabel[];
}

const PHASE4H_MANAGEMENT: Phase4ShadowManagementConfig = {
  breakEvenTriggerPrice: 6,
  breakEvenOffsetPrice: 2,
  trailingTriggerPrice: 10,
  trailingDistancePrice: 5,
};

const GROUPS: Array<[
  Phase4SubgroupLabel,
  (item: Phase4ShadowTradeCase) => boolean,
]> = [
  ["CANONICAL_BUY", (item) => isCanonical(item) && item.side === "BUY"],
  ["CANONICAL_SELL", (item) => isCanonical(item) && item.side === "SELL"],
  ["RESCUED_BUY", (item) => !isCanonical(item) && item.side === "BUY"],
  ["RESCUED_SELL", (item) => !isCanonical(item) && item.side === "SELL"],
];

export class Phase4SubgroupStabilityService {
  run(
    cases: readonly Phase4ShadowTradeCase[],
    management: Phase4ShadowManagementConfig = PHASE4H_MANAGEMENT,
    foldCount = 5,
  ): Phase4SubgroupStabilityResult {
    if (!Number.isInteger(foldCount) || foldCount < 3) {
      throw new Error("Phase4SubgroupStabilityService requires at least 3 folds.");
    }

    const ordered = [...cases].sort(
      (a, b) => a.signalTimestamp - b.signalTimestamp || a.id.localeCompare(b.id),
    );
    const folds = splitContiguous(ordered, foldCount);
    const replay = new Phase4ShadowReplayService(management);

    const groups = GROUPS.map(([label, predicate]) => {
      const selected = ordered.filter(predicate);
      const foldMetrics = folds.map((foldCases, index) => {
        const groupCases = foldCases.filter(predicate);
        return {
          fold: index + 1,
          cases: groupCases.length,
          metrics: replay.run(groupCases).metrics,
        };
      });
      const active = foldMetrics.filter((item) => item.cases > 0);
      const activeFolds = active.length;
      const requiredPositiveFolds = activeFolds >= 3
        ? Math.ceil(activeFolds * 0.6)
        : 3;
      const positiveExpectancyFolds = active.filter(
        (item) => item.metrics.expectancy > 0,
      ).length;
      const positiveProfitFactorFolds = active.filter(
        (item) => effectiveProfitFactor(item.metrics) > 1,
      ).length;
      const positiveNetPnlFolds = active.filter(
        (item) => item.metrics.netPnl > 0,
      ).length;
      const aggregateMetrics = replay.run(selected).metrics;
      const aggregatePositive =
        aggregateMetrics.expectancy > 0 &&
        effectiveProfitFactor(aggregateMetrics) > 1 &&
        aggregateMetrics.netPnl > 0;
      const stablePositive =
        aggregatePositive &&
        activeFolds >= 3 &&
        positiveExpectancyFolds >= requiredPositiveFolds &&
        positiveProfitFactorFolds >= requiredPositiveFolds &&
        positiveNetPnlFolds >= requiredPositiveFolds;

      const status: Phase4SubgroupStabilityStatus = stablePositive
        ? "STABLE_POSITIVE"
        : aggregatePositive
          ? "UNSTABLE_POSITIVE"
          : "NON_POSITIVE";

      return {
        label,
        cases: selected.length,
        activeFolds,
        positiveExpectancyFolds,
        positiveProfitFactorFolds,
        positiveNetPnlFolds,
        requiredPositiveFolds,
        aggregateMetrics,
        folds: foldMetrics,
        status,
      };
    });

    return {
      management,
      foldCount: folds.length,
      groups,
      stablePositiveGroups: groups
        .filter((item) => item.status === "STABLE_POSITIVE")
        .map((item) => item.label),
    };
  }

  format(result: Phase4SubgroupStabilityResult): string[] {
    const c = result.management;
    const lines = [
      `PHASE4H_CONFIG=BE_TRIGGER=${c.breakEvenTriggerPrice}|BE_OFFSET=${c.breakEvenOffsetPrice}|TRAIL_TRIGGER=${c.trailingTriggerPrice}|TRAIL_DISTANCE=${c.trailingDistancePrice}`,
      `PHASE4H_FOLDS=${result.foldCount}`,
    ];

    for (const group of result.groups) {
      const m = group.aggregateMetrics;
      lines.push(
        `PHASE4H_GROUP=${group.label}|CASES=${group.cases}|ACTIVE_FOLDS=${group.activeFolds}|POS_EXP_FOLDS=${group.positiveExpectancyFolds}/${group.activeFolds}|POS_PF_FOLDS=${group.positiveProfitFactorFolds}/${group.activeFolds}|POS_PNL_FOLDS=${group.positiveNetPnlFolds}/${group.activeFolds}|REQUIRED=${group.requiredPositiveFolds}|NET_PNL=${m.netPnl}|PF=${m.profitFactor ?? "INF"}|EXPECTANCY=${m.expectancy}|AVG_R=${m.averageRMultiple}|STATUS=${group.status}`,
      );

      for (const fold of group.folds) {
        const fm = fold.metrics;
        lines.push(
          `PHASE4H_FOLD=${fold.fold}|GROUP=${group.label}|CASES=${fold.cases}|WR=${fm.winRatePercent}|NET_PNL=${fm.netPnl}|PF=${fm.profitFactor ?? "INF"}|EXPECTANCY=${fm.expectancy}|AVG_R=${fm.averageRMultiple}`,
        );
      }
    }

    lines.push(
      `PHASE4H_STABLE_POSITIVE_GROUPS=${result.stablePositiveGroups.join(",") || "NONE"}`,
    );
    lines.push("PHASE4H_RESEARCH_ONLY=PASS");
    lines.push("PHASE4H_PRODUCTION_MUTATION=false");
    return lines;
  }
}

function isCanonical(item: Phase4ShadowTradeCase): boolean {
  return (item.entrySource ?? "CANONICAL") === "CANONICAL";
}

function effectiveProfitFactor(metrics: Phase4ShadowReplayMetrics): number {
  if (metrics.profitFactor !== null) return metrics.profitFactor;
  return metrics.netPnl > 0 ? Number.POSITIVE_INFINITY : 0;
}

function splitContiguous<T>(items: readonly T[], foldCount: number): T[][] {
  const result: T[][] = [];
  for (let fold = 0; fold < foldCount; fold += 1) {
    const start = Math.floor((fold * items.length) / foldCount);
    const end = Math.floor(((fold + 1) * items.length) / foldCount);
    result.push(items.slice(start, end));
  }
  return result;
}
