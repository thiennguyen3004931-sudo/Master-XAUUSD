import type {
  Phase7CObservedExitSidePrice,
  Phase7COrderedExitSideEvidenceResult,
} from "./phase7c-ordered-exit-side-evidence.service";

type Phase7CSide = "BUY" | "SELL";

export interface Phase7CBrokerTick {
  timestamp: number;
  sequence: number;
  bid: number;
  ask: number;
}

export interface Phase7CFastMoveReplayBrokerTick extends Phase7CBrokerTick {
  price: number;
}

export interface Phase7CFastMoveReplayEvidenceInput {
  side: Phase7CSide;
  openedAt: number;
  closedAt: number;
  observed: Phase7COrderedExitSideEvidenceResult;
  brokerTicks: readonly Phase7CBrokerTick[];
  boundaryToleranceMs?: number;
  sampleMatchToleranceMs?: number;
  priceTolerance?: number;
}

export interface Phase7CFastMoveReplayEvidenceResult {
  verdict: "EXACT_PATH" | "UNAVAILABLE";
  complete: boolean;
  managementSamples: Phase7CObservedExitSidePrice[];
  brokerTicks: Phase7CFastMoveReplayBrokerTick[];
  warnings: string[];
}

function finitePositive(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteNonNegative(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function unavailable(
  managementSamples: Phase7CObservedExitSidePrice[],
  brokerTicks: Phase7CFastMoveReplayBrokerTick[],
  warnings: string[],
): Phase7CFastMoveReplayEvidenceResult {
  return {
    verdict: "UNAVAILABLE",
    complete: false,
    managementSamples,
    brokerTicks,
    warnings: [...new Set(warnings)],
  };
}

export function buildPhase7CFastMoveReplayEvidence(
  input: Phase7CFastMoveReplayEvidenceInput,
): Phase7CFastMoveReplayEvidenceResult {
  const openedAt = finiteNonNegative(input.openedAt);
  const closedAt = finiteNonNegative(input.closedAt);
  const boundaryToleranceMs = Math.max(
    0,
    Math.trunc(Number(input.boundaryToleranceMs ?? 15_000)),
  );
  const sampleMatchToleranceMs = Math.max(
    0,
    Math.trunc(Number(input.sampleMatchToleranceMs ?? 0)),
  );
  const priceTolerance = Math.max(
    0,
    Number(input.priceTolerance ?? 1e-9),
  );

  if (
    openedAt === null ||
    closedAt === null ||
    closedAt <= openedAt ||
    !Number.isFinite(boundaryToleranceMs) ||
    !Number.isFinite(sampleMatchToleranceMs) ||
    !Number.isFinite(priceTolerance)
  ) {
    return unavailable([], [], ["INVALID_REPLAY_WINDOW"]);
  }

  const managementSamples = input.observed.prices.map((sample) => ({
    timestamp: Number(sample.timestamp),
    price: Number(sample.price),
    sequence: Number(sample.sequence),
  }));

  if (
    input.observed.complete !== true ||
    input.observed.verdict !== "COMPLETE_OBSERVED_WINDOW"
  ) {
    return unavailable(managementSamples, [], ["MANAGEMENT_OBSERVED_WINDOW_INCOMPLETE"]);
  }

  if (
    managementSamples.length === 0 ||
    managementSamples.some(
      (sample) =>
        !Number.isFinite(sample.timestamp) ||
        finitePositive(sample.price) === null ||
        !Number.isInteger(sample.sequence) ||
        sample.sequence < 0,
    )
  ) {
    return unavailable(managementSamples, [], ["MANAGEMENT_SAMPLE_INVALID"]);
  }

  for (let index = 1; index < managementSamples.length; index += 1) {
    const previous = managementSamples[index - 1]!;
    const current = managementSamples[index]!;
    if (
      current.timestamp <= previous.timestamp ||
      current.sequence <= previous.sequence
    ) {
      return unavailable(managementSamples, [], ["MANAGEMENT_SAMPLE_ORDER_INVALID"]);
    }
  }

  const brokerTicks: Phase7CFastMoveReplayBrokerTick[] = [];
  for (const tick of input.brokerTicks) {
    const timestamp = Number(tick.timestamp);
    const sequence = Number(tick.sequence);
    const bid = finitePositive(tick.bid);
    const ask = finitePositive(tick.ask);
    if (
      !Number.isFinite(timestamp) ||
      !Number.isInteger(sequence) ||
      sequence < 0 ||
      bid === null ||
      ask === null ||
      ask + priceTolerance < bid
    ) {
      return unavailable(managementSamples, brokerTicks, ["BROKER_TICK_PATH_INVALID"]);
    }
    brokerTicks.push({
      timestamp,
      sequence,
      bid,
      ask,
      price: input.side === "BUY" ? bid : ask,
    });
  }

  if (brokerTicks.length === 0) {
    return unavailable(managementSamples, brokerTicks, ["BROKER_TICK_PATH_INVALID"]);
  }

  for (let index = 1; index < brokerTicks.length; index += 1) {
    const previous = brokerTicks[index - 1]!;
    const current = brokerTicks[index]!;
    if (
      current.timestamp < previous.timestamp ||
      current.sequence <= previous.sequence
    ) {
      return unavailable(managementSamples, brokerTicks, ["BROKER_TICK_ORDER_INVALID"]);
    }
  }

  const firstTick = brokerTicks[0]!;
  const lastTick = brokerTicks.at(-1)!;
  const warnings: string[] = [];
  if (Math.abs(firstTick.timestamp - openedAt) > boundaryToleranceMs) {
    warnings.push("BROKER_OPEN_BOUNDARY_MISSING");
  }
  if (Math.abs(lastTick.timestamp - closedAt) > boundaryToleranceMs) {
    warnings.push("BROKER_CLOSE_BOUNDARY_MISSING");
  }

  let searchFrom = 0;
  for (const sample of managementSamples) {
    let matchedIndex = -1;
    for (let index = searchFrom; index < brokerTicks.length; index += 1) {
      const tick = brokerTicks[index]!;
      if (tick.timestamp < sample.timestamp - sampleMatchToleranceMs) continue;
      if (tick.timestamp > sample.timestamp + sampleMatchToleranceMs) break;
      if (Math.abs(tick.price - sample.price) <= priceTolerance) {
        matchedIndex = index;
        break;
      }
    }
    if (matchedIndex < 0) {
      warnings.push("MANAGEMENT_SAMPLE_NOT_IN_BROKER_TICKS");
      break;
    }
    searchFrom = matchedIndex + 1;
  }

  if (warnings.length > 0) {
    return unavailable(managementSamples, brokerTicks, warnings);
  }

  return {
    verdict: "EXACT_PATH",
    complete: true,
    managementSamples,
    brokerTicks,
    warnings: [],
  };
}
