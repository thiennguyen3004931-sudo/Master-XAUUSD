import type {
  Phase7BInitialEntryDecision,
  Phase7BInitialEntryInput,
  Phase7BPullbackEvaluation,
  Phase7BPullbackEvaluationInput,
} from "../models/Phase7BPullbackEntry";

const EPSILON = 1e-9;

export class Phase7BPullbackEntryService {
  decideInitial(input: Phase7BInitialEntryInput): Phase7BInitialEntryDecision {
    const maxStopDistancePrice = input.maxStopDistancePrice ?? 10;
    const waitMinutes = input.waitMinutes ?? 0;
    this.validatePositive("maxStopDistancePrice", maxStopDistancePrice);

    const structuralStopDistance = this.distance(
      input.side,
      input.referenceEntryPrice,
      input.structuralStopPrice,
    );
    this.validatePositive("structuralStopDistance", structuralStopDistance);

    if (structuralStopDistance <= maxStopDistancePrice + EPSILON) {
      return {
        state: "ENTRY_IMMEDIATE",
        structuralStopDistance,
        structuralStopPrice: input.structuralStopPrice,
        pending: null,
      };
    }

    this.validatePositive("waitMinutes", waitMinutes);
    return {
      state: "WAIT_PULLBACK",
      structuralStopDistance,
      structuralStopPrice: input.structuralStopPrice,
      pending: {
        signalId: input.signalId,
        side: input.side,
        pattern: input.pattern,
        signalTimestamp: input.signalTimestamp,
        expiresAt: input.signalTimestamp + waitMinutes * 60_000,
        structuralStopPrice: input.structuralStopPrice,
        structuralStopDistanceAtSignal: structuralStopDistance,
        maxStopDistancePrice,
      },
    };
  }

  evaluatePullback(input: Phase7BPullbackEvaluationInput): Phase7BPullbackEvaluation {
    const { pending } = input;
    const structuralStopDistance = this.distance(
      pending.side,
      input.candidateEntryPrice,
      pending.structuralStopPrice,
    );

    // Conservative same-bar policy: structural invalidation wins over a possible pullback fill.
    const structureBroken = pending.side === "BUY"
      ? input.barLow <= pending.structuralStopPrice + EPSILON
      : input.barHigh >= pending.structuralStopPrice - EPSILON;
    if (structureBroken || !input.setupStillValid) {
      return this.terminal("PULLBACK_SETUP_INVALIDATED", structuralStopDistance, pending.structuralStopPrice);
    }
    if (!input.m15SupertrendAligned) {
      return this.terminal("PULLBACK_M15_ST_INVALIDATED", structuralStopDistance, pending.structuralStopPrice);
    }
    if (!input.m5SupertrendAligned) {
      return this.terminal("PULLBACK_M5_ST_INVALIDATED", structuralStopDistance, pending.structuralStopPrice);
    }
    if (input.timestamp >= pending.expiresAt) {
      return this.terminal("PULLBACK_EXPIRED", structuralStopDistance, pending.structuralStopPrice);
    }
    if (!(structuralStopDistance > 0)) {
      return this.terminal("PULLBACK_SETUP_INVALIDATED", structuralStopDistance, pending.structuralStopPrice);
    }
    if (structuralStopDistance > pending.maxStopDistancePrice + EPSILON) {
      return {
        state: "PULLBACK_STILL_TOO_WIDE",
        structuralStopDistance,
        structuralStopPrice: pending.structuralStopPrice,
        entryPrice: null,
        terminal: false,
      };
    }

    return {
      state: "PULLBACK_ENTRY",
      structuralStopDistance,
      structuralStopPrice: pending.structuralStopPrice,
      entryPrice: input.candidateEntryPrice,
      terminal: true,
    };
  }

  private distance(side: "BUY" | "SELL", entry: number, stop: number): number {
    return side === "BUY" ? entry - stop : stop - entry;
  }

  private terminal(
    state: "PULLBACK_SETUP_INVALIDATED" | "PULLBACK_M15_ST_INVALIDATED" | "PULLBACK_M5_ST_INVALIDATED" | "PULLBACK_EXPIRED",
    structuralStopDistance: number,
    structuralStopPrice: number,
  ): Phase7BPullbackEvaluation {
    return {
      state,
      structuralStopDistance,
      structuralStopPrice,
      entryPrice: null,
      terminal: true,
    };
  }

  private validatePositive(name: string, value: number): void {
    if (!Number.isFinite(value) || !(value > 0)) {
      throw new Error(`Phase7BPullbackEntryService ${name} must be > 0.`);
    }
  }
}
