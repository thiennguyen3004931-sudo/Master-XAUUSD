import type {
  ExecutionRecord,
  PositionManagementPlan,
} from "@xauusd/execution-engine";

import type { DurableSemiAdoptionState } from "./phase7c-semi-adoption-state.service";
import { createPhase7CSemiTrendManagementPlan } from "./phase7c-semi-trend-management-plan.service";

export type TrendManagementOwner =
  | {
      kind: "SYSTEM";
      ownerId: string;
      ticket: string;
      plan: PositionManagementPlan;
      semiAdoption: null;
    }
  | {
      kind: "MANUAL_SEMI";
      ownerId: string;
      ticket: string;
      plan: PositionManagementPlan;
      semiAdoption: DurableSemiAdoptionState;
    };

export type TrendManagementOwnerResolution =
  | { status: "NONE"; reason: string; owner: null }
  | { status: "BLOCKED"; reason: string; owner: null }
  | { status: "SELECTED"; reason: string; owner: TrendManagementOwner };

function isSystemTrendOwner(
  record: ExecutionRecord,
  symbol: string,
): boolean {
  return (
    record.strategyPlan?.order.symbol === symbol &&
    record.strategyPlan?.selectedStrategy.strategyId === "TREND_CONTINUATION"
  );
}

export function resolveTrendManagementOwner(input: {
  symbol: string;
  openExecutionRecords: readonly ExecutionRecord[];
  semiAdoptions: readonly DurableSemiAdoptionState[];
}): TrendManagementOwnerResolution {
  const symbol = input.symbol.trim().toUpperCase();

  const systemCandidates = input.openExecutionRecords
    .filter((record) => isSystemTrendOwner(record, symbol))
    .map((record): TrendManagementOwner | null => {
      const ticket = record.receipt?.ticket;
      const plan = record.strategyPlan;
      if (!ticket || !plan) return null;
      if (
        plan.management.trendHoldUntilStructureBreak !== true ||
        plan.management.trailingStop.mode !== "TREND_STRUCTURE"
      ) {
        return null;
      }
      return {
        kind: "SYSTEM",
        ownerId: record.id,
        ticket,
        plan,
        semiAdoption: null,
      };
    })
    .filter((owner): owner is TrendManagementOwner => owner !== null);

  const semiCandidates = input.semiAdoptions
    .filter(
      (adoption) =>
        adoption.symbol === symbol &&
        adoption.entrySource === "MANUAL" &&
        adoption.managementStrategy === "TREND" &&
        (adoption.protectionStatus === "PROTECTED" ||
          adoption.protectionStatus === "MANAGED"),
    )
    .map((adoption): TrendManagementOwner => ({
      kind: "MANUAL_SEMI",
      ownerId: adoption.ownershipId,
      ticket: adoption.ticket,
      plan: createPhase7CSemiTrendManagementPlan(adoption),
      semiAdoption: structuredClone(adoption),
    }));

  const candidates = [...systemCandidates, ...semiCandidates];

  if (candidates.length === 0) {
    return {
      status: "NONE",
      reason: "No durable Trend management owner is open.",
      owner: null,
    };
  }

  if (candidates.length !== 1) {
    return {
      status: "BLOCKED",
      reason: `Expected exactly one durable Trend management owner; found ${candidates.length}.`,
      owner: null,
    };
  }

  const owner = candidates[0]!;
  return {
    status: "SELECTED",
    reason:
      owner.kind === "MANUAL_SEMI"
        ? "Durable protected SEMI manual ownership selected."
        : "Durable system TrendContinuation ownership selected.",
    owner,
  };
}
