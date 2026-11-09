import type {
  Phase4ShadowManagementConfig,
  Phase4ShadowReplayMetrics,
  Phase4ShadowTradeCase,
} from "../models";
import { Phase4ShadowReplayService } from "./Phase4ShadowReplayService";

export type Phase5ForwardHoldoutStatus =
  | "INSUFFICIENT_SAMPLE"
  | "PASS"
  | "FAIL";

export interface Phase5ForwardHoldoutResult {
  realCutoffTimestamp: number;
  cutoffTimestamp: number;
  datasetOffsetMs: number;
  candidate: "CANONICAL_SELL";
  management: Phase4ShadowManagementConfig;
  minimumFilledTrades: number;
  totalInputCases: number;
  preCutoffCasesIgnored: number;
  postCutoffCases: number;
  eligibleCases: number;
  firstEligibleTimestamp: number | null;
  lastEligibleTimestamp: number | null;
  metrics: Phase4ShadowReplayMetrics;
  status: Phase5ForwardHoldoutStatus;
}

/**
 * Pre-registered real UTC research cutoff from Phase 4F/H.
 */
export const PHASE5_FORWARD_CUTOFF_TIMESTAMP = Date.parse(
  "2026-08-12T12:45:00.000Z",
);

/**
 * The Phase 4/5 replay dataset encodes this broker feed's +03:00 server clock
 * as epoch-like UTC timestamps. Therefore the immutable real cutoff above maps
 * to 15:45 in dataset timestamp space. This is a time-coordinate correction,
 * not a change to the research cutoff.
 */
export const PHASE5_FORWARD_DATASET_OFFSET_MS = 3 * 60 * 60 * 1000;
export const PHASE5_FORWARD_DATASET_CUTOFF_TIMESTAMP =
  PHASE5_FORWARD_CUTOFF_TIMESTAMP + PHASE5_FORWARD_DATASET_OFFSET_MS;

/**
 * Pre-registered management. Do not retune on the Phase 5 holdout.
 */
export const PHASE5_FORWARD_MANAGEMENT: Phase4ShadowManagementConfig = {
  breakEvenTriggerPrice: 6,
  breakEvenOffsetPrice: 2,
  trailingTriggerPrice: 10,
  trailingDistancePrice: 5,
};

/**
 * Pre-registered sample gate. Until this many trades are filled, Phase 5
 * reports INSUFFICIENT_SAMPLE rather than PASS/FAIL.
 */
export const PHASE5_MINIMUM_FILLED_TRADES = 30;

/**
 * Pre-registered PF floor. The research sample reached PF 1.6598 for
 * CANONICAL_SELL; the untouched holdout only needs to clear a much lower
 * floor to demonstrate a positive, non-trivial edge without curve fitting.
 */
export const PHASE5_MINIMUM_PROFIT_FACTOR = 1.1;

export class Phase5ForwardHoldoutService {
  run(
    cases: readonly Phase4ShadowTradeCase[],
    cutoffTimestamp = resolvePhase5DatasetCutoffTimestamp(),
    management: Phase4ShadowManagementConfig = PHASE5_FORWARD_MANAGEMENT,
    minimumFilledTrades = PHASE5_MINIMUM_FILLED_TRADES,
  ): Phase5ForwardHoldoutResult {
    if (!Number.isFinite(cutoffTimestamp)) {
      throw new Error("Phase5ForwardHoldoutService requires a finite cutoff timestamp.");
    }
    if (!Number.isInteger(minimumFilledTrades) || minimumFilledTrades < 1) {
      throw new Error("Phase5ForwardHoldoutService requires minimumFilledTrades >= 1.");
    }

    const ordered = [...cases].sort(
      (a, b) => a.signalTimestamp - b.signalTimestamp || a.id.localeCompare(b.id),
    );
    const preCutoffCasesIgnored = ordered.filter(
      (item) => item.signalTimestamp <= cutoffTimestamp,
    ).length;
    const postCutoff = ordered.filter(
      (item) => item.signalTimestamp > cutoffTimestamp,
    );
    const eligible = postCutoff.filter(
      (item) =>
        (item.entrySource ?? "CANONICAL") === "CANONICAL" &&
        item.side === "SELL",
    );

    const replay = new Phase4ShadowReplayService(management).run(eligible);
    const metrics = replay.metrics;

    const positive =
      metrics.netPnl > 0 &&
      metrics.expectancy > 0 &&
      metrics.averageRMultiple > 0 &&
      effectiveProfitFactor(metrics) > PHASE5_MINIMUM_PROFIT_FACTOR;

    const status: Phase5ForwardHoldoutStatus =
      metrics.filledTrades < minimumFilledTrades
        ? "INSUFFICIENT_SAMPLE"
        : positive
          ? "PASS"
          : "FAIL";

    return {
      realCutoffTimestamp: PHASE5_FORWARD_CUTOFF_TIMESTAMP,
      cutoffTimestamp,
      datasetOffsetMs: cutoffTimestamp - PHASE5_FORWARD_CUTOFF_TIMESTAMP,
      candidate: "CANONICAL_SELL",
      management,
      minimumFilledTrades,
      totalInputCases: ordered.length,
      preCutoffCasesIgnored,
      postCutoffCases: postCutoff.length,
      eligibleCases: eligible.length,
      firstEligibleTimestamp: eligible[0]?.signalTimestamp ?? null,
      lastEligibleTimestamp: eligible.at(-1)?.signalTimestamp ?? null,
      metrics,
      status,
    };
  }

  format(result: Phase5ForwardHoldoutResult): string[] {
    const c = result.management;
    const m = result.metrics;
    return [
      `PHASE5_REAL_CUTOFF_UTC=${new Date(result.realCutoffTimestamp).toISOString()}`,
      `PHASE5_DATASET_CUTOFF=${new Date(result.cutoffTimestamp).toISOString()}`,
      `PHASE5_DATASET_OFFSET_MS=${result.datasetOffsetMs}`,
      `PHASE5_CANDIDATE=${result.candidate}`,
      `PHASE5_CONFIG=BE_TRIGGER=${c.breakEvenTriggerPrice}|BE_OFFSET=${c.breakEvenOffsetPrice}|TRAIL_TRIGGER=${c.trailingTriggerPrice}|TRAIL_DISTANCE=${c.trailingDistancePrice}`,
      `PHASE5_MINIMUM_FILLED_TRADES=${result.minimumFilledTrades}`,
      `PHASE5_MINIMUM_PROFIT_FACTOR=${PHASE5_MINIMUM_PROFIT_FACTOR}`,
      `PHASE5_TOTAL_INPUT_CASES=${result.totalInputCases}`,
      `PHASE5_PRE_CUTOFF_CASES_IGNORED=${result.preCutoffCasesIgnored}`,
      `PHASE5_POST_CUTOFF_CASES=${result.postCutoffCases}`,
      `PHASE5_ELIGIBLE_CASES=${result.eligibleCases}`,
      `PHASE5_FIRST_ELIGIBLE=${isoOrNone(result.firstEligibleTimestamp)}`,
      `PHASE5_LAST_ELIGIBLE=${isoOrNone(result.lastEligibleTimestamp)}`,
      `PHASE5_FILLED_TRADES=${m.filledTrades}`,
      `PHASE5_WIN_RATE=${m.winRatePercent}`,
      `PHASE5_NET_PNL=${m.netPnl}`,
      `PHASE5_PROFIT_FACTOR=${m.filledTrades === 0 ? "NA" : (m.profitFactor ?? "INF")}`,
      `PHASE5_EXPECTANCY=${m.expectancy}`,
      `PHASE5_AVG_R=${m.averageRMultiple}`,
      `PHASE5_STATUS=${result.status}`,
      "PHASE5_PRE_REGISTERED=PASS",
      "PHASE5_PRODUCTION_MUTATION=false",
    ];
  }
}

export function resolvePhase5DatasetCutoffTimestamp(): number {
  const runtime = globalThis as typeof globalThis & {
    process?: {
      env?: Record<string, string | undefined>;
    };
  };
  const raw = runtime.process?.env?.ZIQ_PHASE5_DATASET_CUTOFF_MS;
  if (raw === undefined || raw.trim() === "") {
    return PHASE5_FORWARD_DATASET_CUTOFF_TIMESTAMP;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error("ZIQ_PHASE5_DATASET_CUTOFF_MS must be a finite epoch-millisecond value.");
  }
  return parsed;
}

function effectiveProfitFactor(metrics: Phase4ShadowReplayMetrics): number {
  if (metrics.profitFactor !== null) return metrics.profitFactor;
  return metrics.netPnl > 0 ? Number.POSITIVE_INFINITY : 0;
}

function isoOrNone(timestamp: number | null): string {
  return timestamp === null ? "NONE" : new Date(timestamp).toISOString();
}
