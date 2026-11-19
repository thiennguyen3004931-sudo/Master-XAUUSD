import type { IExecutionAdapter } from "@xauusd/execution-engine";
import type { Position } from "@xauusd/types";

import type {
  DurableSemiAdoptionState,
} from "./phase7c-semi-adoption-state.service";

export interface Phase7CSemiProtectionExecutorDependencies {
  now: () => number;
  adoptionRepository: {
    findByTicket(ticket: string): Promise<DurableSemiAdoptionState | null>;
    save(state: DurableSemiAdoptionState): Promise<void>;
  };
  adapter: Pick<IExecutionAdapter, "getOpenPositions" | "modifyPosition">;
}

export type Phase7CSemiProtectionExecutorStatus =
  | "PROTECTED"
  | "PROTECTION_BLOCKED";

export interface Phase7CSemiProtectionExecutorResult {
  status: Phase7CSemiProtectionExecutorStatus;
  ticket: string;
  brokerMutationAttempted: boolean;
  reason: string;
  generatedAt: number;
}

const EPSILON = 1e-8;

function approximatelyEqual(left: number, right: number): boolean {
  return Number.isFinite(left) &&
    Number.isFinite(right) &&
    Math.abs(left - right) <= EPSILON;
}

function sideMatches(
  state: DurableSemiAdoptionState,
  position: Position,
): boolean {
  return String(position.side) === state.side;
}

function identityMatches(
  state: DurableSemiAdoptionState,
  position: Position,
): boolean {
  if (
    position.ticket !== state.ticket ||
    position.symbol.trim().toUpperCase() !== "XAUUSD" ||
    !sideMatches(state, position) ||
    !approximatelyEqual(position.entry, state.entry) ||
    !Number.isFinite(position.volume) ||
    position.volume <= 0 ||
    position.volume - state.initialVolume > EPSILON
  ) {
    return false;
  }

  return true;
}

function stopIsEqualOrTighter(
  state: DurableSemiAdoptionState,
  position: Position,
): boolean {
  if (!Number.isFinite(position.stopLoss) || position.stopLoss <= 0) {
    return false;
  }

  return state.side === "LONG"
    ? position.stopLoss + EPSILON >= state.targetStopLoss
    : position.stopLoss - EPSILON <= state.targetStopLoss;
}

function fixedTakeProfitMatches(
  state: DurableSemiAdoptionState,
  position: Position,
): boolean {
  if (!state.fixedTakeProfit.enabled) return true;

  const target = state.fixedTakeProfit.targetPrice;
  return target !== null &&
    approximatelyEqual(position.takeProfit, target);
}

function brokerProtectionMatches(
  state: DurableSemiAdoptionState,
  position: Position,
): boolean {
  return identityMatches(state, position) &&
    stopIsEqualOrTighter(state, position) &&
    fixedTakeProfitMatches(state, position);
}

function verifiedTightestStop(
  state: DurableSemiAdoptionState,
  position: Position,
): number {
  if (!stopIsEqualOrTighter(state, position)) {
    return state.tightestStopLoss;
  }

  return state.side === "LONG"
    ? Math.max(state.tightestStopLoss, position.stopLoss)
    : Math.min(state.tightestStopLoss, position.stopLoss);
}

function nextTimestamp(
  state: DurableSemiAdoptionState,
  now: number,
): number {
  return Math.max(state.updatedAt, now);
}

async function saveProtected(
  dependencies: Phase7CSemiProtectionExecutorDependencies,
  state: DurableSemiAdoptionState,
  position: Position,
): Promise<DurableSemiAdoptionState> {
  const stop = verifiedTightestStop(state, position);
  const next: DurableSemiAdoptionState = {
    ...state,
    targetStopLoss: stop,
    tightestStopLoss: stop,
    expectedRemainingVolume: position.volume,
    protectionStatus: "PROTECTED",
    protectionReason: "BROKER_CONFIRMED",
    updatedAt: nextTimestamp(state, dependencies.now()),
  };
  await dependencies.adoptionRepository.save(next);
  return next;
}

async function saveBlocked(
  dependencies: Phase7CSemiProtectionExecutorDependencies,
  state: DurableSemiAdoptionState,
  reason: string,
): Promise<void> {
  const next: DurableSemiAdoptionState = {
    ...state,
    protectionStatus: "PROTECTION_BLOCKED",
    protectionReason: reason,
    updatedAt: nextTimestamp(state, dependencies.now()),
  };
  await dependencies.adoptionRepository.save(next);
}

function result(
  status: Phase7CSemiProtectionExecutorStatus,
  ticket: string,
  brokerMutationAttempted: boolean,
  reason: string,
  generatedAt: number,
): Phase7CSemiProtectionExecutorResult {
  return {
    status,
    ticket,
    brokerMutationAttempted,
    reason,
    generatedAt,
  };
}

export function createPhase7CSemiProtectionExecutor(
  dependencies: Phase7CSemiProtectionExecutorDependencies,
) {
  return async function executePhase7CSemiProtection(
    ticket: string,
  ): Promise<Phase7CSemiProtectionExecutorResult> {
    const generatedAt = dependencies.now();
    const state = await dependencies.adoptionRepository.findByTicket(ticket);

    if (!state) {
      return result(
        "PROTECTION_BLOCKED",
        ticket,
        false,
        "ADOPTION_NOT_FOUND",
        generatedAt,
      );
    }

    if (
      state.protectionStatus === "PROTECTED" ||
      state.protectionStatus === "MANAGED"
    ) {
      return result(
        "PROTECTED",
        ticket,
        false,
        "ALREADY_PROTECTED",
        generatedAt,
      );
    }

    const initialPositions = await dependencies.adapter.getOpenPositions("XAUUSD");
    const initial = initialPositions.find((position) => position.ticket === ticket);

    if (!initial) {
      await saveBlocked(dependencies, state, "BROKER_POSITION_MISSING");
      return result(
        "PROTECTION_BLOCKED",
        ticket,
        false,
        "BROKER_POSITION_MISSING",
        generatedAt,
      );
    }

    if (!identityMatches(state, initial)) {
      await saveBlocked(dependencies, state, "BROKER_POSITION_IDENTITY_MISMATCH");
      return result(
        "PROTECTION_BLOCKED",
        ticket,
        false,
        "BROKER_POSITION_IDENTITY_MISMATCH",
        generatedAt,
      );
    }

    if (brokerProtectionMatches(state, initial)) {
      await saveProtected(dependencies, state, initial);
      return result(
        "PROTECTED",
        ticket,
        false,
        "BROKER_CONFIRMED",
        generatedAt,
      );
    }

    const targetStopLoss = stopIsEqualOrTighter(state, initial)
      ? initial.stopLoss
      : state.targetStopLoss;
    const takeProfit = state.fixedTakeProfit.enabled
      ? state.fixedTakeProfit.targetPrice ?? undefined
      : undefined;
    const commandId = `semi-protect:${state.ownershipId}`;

    let brokerMutationAttempted = false;
    try {
      brokerMutationAttempted = true;
      await dependencies.adapter.modifyPosition(
        ticket,
        targetStopLoss,
        takeProfit,
        commandId,
      );
    } catch {
      // The mutation outcome is uncertain after a transport exception.
      // Never infer success/failure here; the fresh broker read below is authoritative.
    }

    const confirmedPositions = await dependencies.adapter.getOpenPositions("XAUUSD");
    const confirmed = confirmedPositions.find((position) => position.ticket === ticket);

    if (!confirmed) {
      await saveBlocked(dependencies, state, "BROKER_POSITION_MISSING");
      return result(
        "PROTECTION_BLOCKED",
        ticket,
        brokerMutationAttempted,
        "BROKER_POSITION_MISSING",
        generatedAt,
      );
    }

    const confirmationState: DurableSemiAdoptionState = {
      ...state,
      targetStopLoss,
      tightestStopLoss: state.side === "LONG"
        ? Math.max(state.tightestStopLoss, targetStopLoss)
        : Math.min(state.tightestStopLoss, targetStopLoss),
    };

    if (brokerProtectionMatches(confirmationState, confirmed)) {
      await saveProtected(dependencies, confirmationState, confirmed);
      return result(
        "PROTECTED",
        ticket,
        brokerMutationAttempted,
        "BROKER_CONFIRMED",
        generatedAt,
      );
    }

    await saveBlocked(dependencies, state, "BROKER_CONFIRMATION_MISMATCH");
    return result(
      "PROTECTION_BLOCKED",
      ticket,
      brokerMutationAttempted,
      "BROKER_CONFIRMATION_MISMATCH",
      generatedAt,
    );
  };
}
