import type {
  Phase4ShadowManagementConfig,
  Phase4ShadowReplayMetrics,
  Phase4ShadowTradeCase,
} from "../models";
import { Phase4ShadowReplayService } from "./Phase4ShadowReplayService";

export interface Phase4ShadowDiagnosticFold {
  fold: number;
  fromTimestamp: number;
  toTimestamp: number;
  totalCases: number;
  canonicalCases: number;
  rescuedCases: number;
  buyCases: number;
  sellCases: number;
  metrics: Phase4ShadowReplayMetrics;
  bySource: Array<{
    source: string;
    cases: number;
    metrics: Phase4ShadowReplayMetrics;
  }>;
}

export interface Phase4ShadowDiagnosticsResult {
  totalCases: number;
  uniqueCaseIds: number;
  duplicateCaseIds: string[];
  canonicalCases: number;
  rescuedCases: number;
  buyCases: number;
  sellCases: number;
  management: Phase4ShadowManagementConfig;
  folds: Phase4ShadowDiagnosticFold[];
}

const PHASE4F_MANAGEMENT: Phase4ShadowManagementConfig = {
  breakEvenTriggerPrice: 6,
  breakEvenOffsetPrice: 2,
  trailingTriggerPrice: 10,
  trailingDistancePrice: 5,
};

export class Phase4ShadowDiagnosticsService {
  run(
    cases: readonly Phase4ShadowTradeCase[],
    management: Phase4ShadowManagementConfig = PHASE4F_MANAGEMENT,
    foldCount = 5,
  ): Phase4ShadowDiagnosticsResult {
    const ordered = [...cases].sort(
      (a, b) => a.signalTimestamp - b.signalTimestamp || a.id.localeCompare(b.id),
    );
    const duplicateCaseIds = findDuplicates(ordered.map((item) => item.id));
    const folds = splitContiguous(ordered, foldCount).map((foldCases, index) => {
      const sourceNames = [...new Set(foldCases.map((item) => item.entrySource ?? "CANONICAL"))]
        .sort();
      return {
        fold: index + 1,
        fromTimestamp: foldCases[0]?.signalTimestamp ?? 0,
        toTimestamp: foldCases.at(-1)?.signalTimestamp ?? 0,
        totalCases: foldCases.length,
        canonicalCases: foldCases.filter(isCanonical).length,
        rescuedCases: foldCases.filter((item) => !isCanonical(item)).length,
        buyCases: foldCases.filter((item) => item.side === "BUY").length,
        sellCases: foldCases.filter((item) => item.side === "SELL").length,
        metrics: new Phase4ShadowReplayService(management).run(foldCases).metrics,
        bySource: sourceNames.map((source) => {
          const sourceCases = foldCases.filter(
            (item) => (item.entrySource ?? "CANONICAL") === source,
          );
          return {
            source,
            cases: sourceCases.length,
            metrics: new Phase4ShadowReplayService(management).run(sourceCases).metrics,
          };
        }),
      };
    });

    return {
      totalCases: ordered.length,
      uniqueCaseIds: new Set(ordered.map((item) => item.id)).size,
      duplicateCaseIds,
      canonicalCases: ordered.filter(isCanonical).length,
      rescuedCases: ordered.filter((item) => !isCanonical(item)).length,
      buyCases: ordered.filter((item) => item.side === "BUY").length,
      sellCases: ordered.filter((item) => item.side === "SELL").length,
      management,
      folds,
    };
  }

  format(result: Phase4ShadowDiagnosticsResult): string[] {
    const c = result.management;
    const lines = [
      `PHASE4F_TOTAL_CASES=${result.totalCases}`,
      `PHASE4F_UNIQUE_CASE_IDS=${result.uniqueCaseIds}`,
      `PHASE4F_DUPLICATE_CASE_IDS=${result.duplicateCaseIds.length}`,
      `PHASE4F_DUPLICATE_IDS=${result.duplicateCaseIds.join(",") || "NONE"}`,
      `PHASE4F_CANONICAL_CASES=${result.canonicalCases}`,
      `PHASE4F_RESCUED_CASES=${result.rescuedCases}`,
      `PHASE4F_BUY_CASES=${result.buyCases}`,
      `PHASE4F_SELL_CASES=${result.sellCases}`,
      `PHASE4F_CONFIG=BE_TRIGGER=${c.breakEvenTriggerPrice}|BE_OFFSET=${c.breakEvenOffsetPrice}|TRAIL_TRIGGER=${c.trailingTriggerPrice}|TRAIL_DISTANCE=${c.trailingDistancePrice}`,
    ];

    for (const fold of result.folds) {
      const m = fold.metrics;
      lines.push(
        `PHASE4F_FOLD=${fold.fold}|FROM=${iso(fold.fromTimestamp)}|TO=${iso(fold.toTimestamp)}|CASES=${fold.totalCases}|CANONICAL=${fold.canonicalCases}|RESCUED=${fold.rescuedCases}|BUY=${fold.buyCases}|SELL=${fold.sellCases}|WR=${m.winRatePercent}|NET_PNL=${m.netPnl}|PF=${m.profitFactor ?? "INF"}|EXPECTANCY=${m.expectancy}|AVG_R=${m.averageRMultiple}`,
      );
      for (const source of fold.bySource) {
        const sm = source.metrics;
        lines.push(
          `PHASE4F_SOURCE=FOLD=${fold.fold}|SOURCE=${source.source}|CASES=${source.cases}|WR=${sm.winRatePercent}|NET_PNL=${sm.netPnl}|PF=${sm.profitFactor ?? "INF"}|EXPECTANCY=${sm.expectancy}|AVG_R=${sm.averageRMultiple}`,
        );
      }
    }

    lines.push("PHASE4F_RESEARCH_ONLY=PASS");
    lines.push("PHASE4F_PRODUCTION_MUTATION=false");
    return lines;
  }
}

function isCanonical(item: Phase4ShadowTradeCase): boolean {
  return (item.entrySource ?? "CANONICAL") === "CANONICAL";
}

function findDuplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates].sort();
}

function splitContiguous<T>(items: readonly T[], foldCount: number): T[][] {
  const count = Math.min(Math.max(1, foldCount), Math.max(1, items.length));
  const result: T[][] = [];
  for (let fold = 0; fold < count; fold += 1) {
    const start = Math.floor((fold * items.length) / count);
    const end = Math.floor(((fold + 1) * items.length) / count);
    result.push(items.slice(start, end));
  }
  return result;
}

function iso(timestamp: number): string {
  return Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp).toISOString()
    : "NA";
}
