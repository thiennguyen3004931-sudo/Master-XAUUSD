import type {
  Phase4ShadowManagementConfig,
  Phase4ShadowReplayMetrics,
  Phase4ShadowTradeCase,
  Phase4ShadowTradeResult,
} from "../models";
import { Phase4ShadowReplayService } from "./Phase4ShadowReplayService";

export interface Phase4WalkForwardFoldResult {
  fold: number;
  trainCases: number;
  testCases: number;
  selectedConfigId: string;
  selectedConfig: Phase4ShadowManagementConfig;
  trainMetrics: Phase4ShadowReplayMetrics;
  testMetrics: Phase4ShadowReplayMetrics;
}

export interface Phase4WalkForwardConfigStability {
  id: string;
  management: Phase4ShadowManagementConfig;
  foldMetrics: Phase4ShadowReplayMetrics[];
  positiveExpectancyFolds: number;
  positiveProfitFactorFolds: number;
  positiveNetPnlFolds: number;
  averageExpectancy: number;
  minimumExpectancy: number;
  averageProfitFactor: number;
  totalNetPnl: number;
  aggregateMetrics: Phase4ShadowReplayMetrics;
}

export interface Phase4WalkForwardResult {
  totalCases: number;
  folds: number;
  configs: number;
  walkForward: Phase4WalkForwardFoldResult[];
  stability: Phase4WalkForwardConfigStability[];
  robustConfigs: Phase4WalkForwardConfigStability[];
  robustBest: Phase4WalkForwardConfigStability | null;
  oosMetrics: Phase4ShadowReplayMetrics;
  oosPositiveFolds: number;
}

export class Phase4WalkForwardService {
  run(
    cases: readonly Phase4ShadowTradeCase[],
    configs: readonly Phase4ShadowManagementConfig[] = phase4eConfigs(),
    foldCount = 5,
  ): Phase4WalkForwardResult {
    if (!Number.isInteger(foldCount) || foldCount < 3) {
      throw new Error("Phase4WalkForwardService requires at least 3 folds.");
    }
    if (cases.length < foldCount) {
      throw new Error("Not enough shadow cases for requested folds.");
    }
    if (configs.length === 0) {
      throw new Error("At least one management config is required.");
    }

    const ordered = [...cases].sort(
      (a, b) => a.signalTimestamp - b.signalTimestamp || a.id.localeCompare(b.id),
    );
    const folds = splitContiguous(ordered, foldCount);
    const identifiedConfigs = configs.map((management, index) => ({
      id: `P4E-${String(index + 1).padStart(2, "0")}`,
      management,
    }));

    const stability = identifiedConfigs.map(({ id, management }) => {
      const foldReplays = folds.map((fold) =>
        new Phase4ShadowReplayService(management).run(fold),
      );
      const foldMetrics = foldReplays.map((replay) => replay.metrics);
      const finitePfs = foldMetrics
        .map((item) => item.profitFactor)
        .filter((value): value is number => value !== null && Number.isFinite(value));
      const allTrades = foldReplays.flatMap((replay) => replay.trades);

      return {
        id,
        management,
        foldMetrics,
        positiveExpectancyFolds: foldMetrics.filter((item) => item.expectancy > 0).length,
        positiveProfitFactorFolds: foldMetrics.filter(
          (item) => (item.profitFactor ?? Number.POSITIVE_INFINITY) > 1,
        ).length,
        positiveNetPnlFolds: foldMetrics.filter((item) => item.netPnl > 0).length,
        averageExpectancy: round(avg(foldMetrics.map((item) => item.expectancy)), 4),
        minimumExpectancy: round(Math.min(...foldMetrics.map((item) => item.expectancy)), 4),
        averageProfitFactor: round(avg(finitePfs), 4),
        totalNetPnl: round(foldMetrics.reduce((sum, item) => sum + item.netPnl, 0)),
        aggregateMetrics: aggregateMetrics(allTrades),
      };
    });

    const requiredPositiveFolds = Math.max(3, Math.ceil(folds.length * 0.6));
    const robustConfigs = stability
      .filter((item) =>
        item.positiveExpectancyFolds >= requiredPositiveFolds &&
        item.positiveProfitFactorFolds >= requiredPositiveFolds &&
        item.positiveNetPnlFolds >= requiredPositiveFolds &&
        item.aggregateMetrics.expectancy > 0 &&
        (item.aggregateMetrics.profitFactor ?? Number.POSITIVE_INFINITY) > 1,
      )
      .sort(compareStability);
    const robustBest = robustConfigs[0] ?? null;

    const walkForward: Phase4WalkForwardFoldResult[] = [];
    const oosTrades: Phase4ShadowTradeResult[] = [];

    for (let testIndex = 1; testIndex < folds.length; testIndex += 1) {
      const train = folds.slice(0, testIndex).flat();
      const test = folds[testIndex]!;
      const ranked = identifiedConfigs
        .map(({ id, management }) => ({
          id,
          management,
          replay: new Phase4ShadowReplayService(management).run(train),
        }))
        .sort((left, right) => compareMetrics(right.replay.metrics, left.replay.metrics));
      const selected = ranked[0]!;
      const testReplay = new Phase4ShadowReplayService(selected.management).run(test);
      oosTrades.push(...testReplay.trades);

      walkForward.push({
        fold: testIndex + 1,
        trainCases: train.length,
        testCases: test.length,
        selectedConfigId: selected.id,
        selectedConfig: selected.management,
        trainMetrics: selected.replay.metrics,
        testMetrics: testReplay.metrics,
      });
    }

    return {
      totalCases: ordered.length,
      folds: folds.length,
      configs: configs.length,
      walkForward,
      stability,
      robustConfigs,
      robustBest,
      oosMetrics: aggregateMetrics(oosTrades),
      oosPositiveFolds: walkForward.filter((item) => item.testMetrics.expectancy > 0).length,
    };
  }

  format(result: Phase4WalkForwardResult): string[] {
    const lines = [
      `PHASE4E_TOTAL_CASES=${result.totalCases}`,
      `PHASE4E_FOLDS=${result.folds}`,
      `PHASE4E_CONFIGS=${result.configs}`,
    ];

    for (const item of result.walkForward) {
      const c = item.selectedConfig;
      const m = item.testMetrics;
      lines.push(
        `PHASE4E_OOS_FOLD=${item.fold}|TRAIN=${item.trainCases}|TEST=${item.testCases}|SELECTED=${item.selectedConfigId}|BE_TRIGGER=${c.breakEvenTriggerPrice}|BE_OFFSET=${c.breakEvenOffsetPrice}|TRAIL_TRIGGER=${c.trailingTriggerPrice}|TRAIL_DISTANCE=${c.trailingDistancePrice}|WR=${m.winRatePercent}|NET_PNL=${m.netPnl}|PF=${m.profitFactor ?? "INF"}|EXPECTANCY=${m.expectancy}|AVG_R=${m.averageRMultiple}`,
      );
    }

    const oos = result.oosMetrics;
    lines.push(`PHASE4E_OOS_FILLED=${oos.filledTrades}`);
    lines.push(`PHASE4E_OOS_WIN_RATE=${oos.winRatePercent}`);
    lines.push(`PHASE4E_OOS_NET_PNL=${oos.netPnl}`);
    lines.push(`PHASE4E_OOS_PROFIT_FACTOR=${oos.profitFactor ?? "INF"}`);
    lines.push(`PHASE4E_OOS_EXPECTANCY=${oos.expectancy}`);
    lines.push(`PHASE4E_OOS_AVG_R=${oos.averageRMultiple}`);
    lines.push(`PHASE4E_OOS_POSITIVE_FOLDS=${result.oosPositiveFolds}/${result.walkForward.length}`);
    lines.push(`PHASE4E_ROBUST_CONFIGS=${result.robustConfigs.length}`);

    if (result.robustBest) {
      const b = result.robustBest;
      const c = b.management;
      const m = b.aggregateMetrics;
      lines.push(
        `PHASE4E_ROBUST_BEST=${b.id}|BE_TRIGGER=${c.breakEvenTriggerPrice}|BE_OFFSET=${c.breakEvenOffsetPrice}|TRAIL_TRIGGER=${c.trailingTriggerPrice}|TRAIL_DISTANCE=${c.trailingDistancePrice}|POS_EXP_FOLDS=${b.positiveExpectancyFolds}/${result.folds}|POS_PF_FOLDS=${b.positiveProfitFactorFolds}/${result.folds}|POS_PNL_FOLDS=${b.positiveNetPnlFolds}/${result.folds}|AVG_EXPECTANCY=${b.averageExpectancy}|MIN_EXPECTANCY=${b.minimumExpectancy}|AVG_PF=${b.averageProfitFactor}|NET_PNL=${m.netPnl}|PF=${m.profitFactor ?? "INF"}|EXPECTANCY=${m.expectancy}|AVG_R=${m.averageRMultiple}`,
      );
    } else {
      lines.push("PHASE4E_ROBUST_BEST=NONE");
    }

    lines.push("PHASE4E_RESEARCH_ONLY=PASS");
    lines.push("PHASE4E_PRODUCTION_MUTATION=false");
    return lines;
  }
}

export function phase4eConfigs(): Phase4ShadowManagementConfig[] {
  const configs: Phase4ShadowManagementConfig[] = [];
  for (const breakEvenOffsetPrice of [1, 1.5, 2]) {
    for (const trailingTriggerPrice of [10, 12]) {
      for (const trailingDistancePrice of [5, 6, 7]) {
        configs.push({
          breakEvenTriggerPrice: 6,
          breakEvenOffsetPrice,
          trailingTriggerPrice,
          trailingDistancePrice,
        });
      }
    }
  }
  return configs;
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

function compareMetrics(
  left: Phase4ShadowReplayMetrics,
  right: Phase4ShadowReplayMetrics,
): number {
  if (left.expectancy !== right.expectancy) return left.expectancy - right.expectancy;
  const leftPf = left.profitFactor ?? Number.POSITIVE_INFINITY;
  const rightPf = right.profitFactor ?? Number.POSITIVE_INFINITY;
  if (leftPf !== rightPf) return leftPf - rightPf;
  return left.netPnl - right.netPnl;
}

function compareStability(
  a: Phase4WalkForwardConfigStability,
  b: Phase4WalkForwardConfigStability,
): number {
  return (
    b.positiveExpectancyFolds - a.positiveExpectancyFolds ||
    b.positiveProfitFactorFolds - a.positiveProfitFactorFolds ||
    b.positiveNetPnlFolds - a.positiveNetPnlFolds ||
    b.minimumExpectancy - a.minimumExpectancy ||
    b.averageExpectancy - a.averageExpectancy ||
    b.totalNetPnl - a.totalNetPnl
  );
}

function aggregateMetrics(trades: readonly Phase4ShadowTradeResult[]): Phase4ShadowReplayMetrics {
  const filled = trades.filter((trade) => trade.filled);
  const wins = filled.filter((trade) => trade.pnl > 0);
  const losses = filled.filter((trade) => trade.pnl < 0);
  const flat = filled.length - wins.length - losses.length;
  const grossProfit = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0));
  const netPnl = filled.reduce((sum, trade) => sum + trade.pnl, 0);

  return {
    totalCases: trades.length,
    filledTrades: filled.length,
    unfilledTrades: trades.length - filled.length,
    wins: wins.length,
    losses: losses.length,
    flat,
    winRatePercent: round(filled.length ? (wins.length / filled.length) * 100 : 0),
    netPnl: round(netPnl),
    grossProfit: round(grossProfit),
    grossLoss: round(grossLoss),
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : null,
    expectancy: round(filled.length ? netPnl / filled.length : 0, 4),
    averageRMultiple: round(avg(filled.map((trade) => trade.rMultiple)), 4),
    averageMfePrice: round(avg(filled.map((trade) => trade.mfePrice)), 4),
    averageMaePrice: round(avg(filled.map((trade) => trade.maePrice)), 4),
    reachedPlus6: filled.filter((trade) => trade.reachedPlus6).length,
    reachedPlus10: filled.filter((trade) => trade.reachedPlus10).length,
    breakEvenApplied: filled.filter((trade) => trade.breakEvenApplied).length,
    trailingActivated: filled.filter((trade) => trade.trailingActivated).length,
  };
}

function avg(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}
