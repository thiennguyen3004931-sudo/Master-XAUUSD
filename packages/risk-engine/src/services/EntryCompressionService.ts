import { OrderSide } from "@xauusd/types";
import type {
  EntryCompressionCandidateAssessment,
  EntryCompressionRequest,
  EntryCompressionResult,
  InstrumentRiskSpec,
} from "../models";
import { NumberUtils } from "../utils";

export class EntryCompressionService {
  evaluate(request: EntryCompressionRequest): EntryCompressionResult {
    this.validate(request);

    const canonicalRiskAtMinVolumeUsd = this.riskAtMinVolume(
      request.canonicalEntry,
      request.canonicalStopLoss,
      request.instrument,
    );
    const canonicalFeasibleAtMinVolume =
      canonicalRiskAtMinVolumeUsd <= request.effectiveRiskCapUsd;

    const assessments = request.candidates
      .map((candidate) => this.assessCandidate(request, candidate))
      .sort((left, right) => {
        if (left.feasibleAtMinVolume !== right.feasibleAtMinVolume) {
          return left.feasibleAtMinVolume ? -1 : 1;
        }
        if (left.entryImprovement !== right.entryImprovement) {
          return right.entryImprovement - left.entryImprovement;
        }
        return left.riskAtMinVolumeUsd - right.riskAtMinVolumeUsd;
      });

    const selected = assessments.find((assessment) =>
      assessment.feasibleAtMinVolume &&
      assessment.favorableRetracement &&
      assessment.canonicalStopPreserved &&
      assessment.withinExecutionWindow,
    ) ?? null;

    return {
      canonicalEntry: request.canonicalEntry,
      canonicalStopLoss: request.canonicalStopLoss,
      canonicalRiskAtMinVolumeUsd: NumberUtils.round(canonicalRiskAtMinVolumeUsd),
      canonicalFeasibleAtMinVolume,
      selectedEntry: selected?.candidate.price ?? null,
      selectedSource: selected?.candidate.source ?? null,
      selectedRiskAtMinVolumeUsd: selected
        ? NumberUtils.round(selected.riskAtMinVolumeUsd)
        : null,
      rescuedAtMinVolume: !canonicalFeasibleAtMinVolume && selected !== null,
      assessments,
    };
  }

  private assessCandidate(
    request: EntryCompressionRequest,
    candidate: EntryCompressionRequest["candidates"][number],
  ): EntryCompressionCandidateAssessment {
    const favorableRetracement = request.side === OrderSide.BUY
      ? candidate.price < request.canonicalEntry
      : candidate.price > request.canonicalEntry;
    const canonicalStopPreserved = request.side === OrderSide.BUY
      ? candidate.price > request.canonicalStopLoss
      : candidate.price < request.canonicalStopLoss;
    const withinExecutionWindow =
      candidate.timestamp >= request.canonicalSignalTime &&
      candidate.timestamp <= request.expiresAt;
    const entryImprovement = favorableRetracement
      ? Math.abs(request.canonicalEntry - candidate.price)
      : 0;
    const riskAtMinVolumeUsd = canonicalStopPreserved
      ? this.riskAtMinVolume(
          candidate.price,
          request.canonicalStopLoss,
          request.instrument,
        )
      : Number.POSITIVE_INFINITY;
    const feasibleAtMinVolume =
      canonicalStopPreserved &&
      riskAtMinVolumeUsd <= request.effectiveRiskCapUsd;

    const rejectionCodes: string[] = [];
    if (!favorableRetracement) rejectionCodes.push("NOT_FAVORABLE_RETRACEMENT");
    if (!canonicalStopPreserved) rejectionCodes.push("CANONICAL_STOP_CROSSED");
    if (!withinExecutionWindow) rejectionCodes.push("OUTSIDE_EXECUTION_WINDOW");
    if (canonicalStopPreserved && !feasibleAtMinVolume) {
      rejectionCodes.push("RISK_AT_MIN_VOLUME_BLOCKED");
    }

    return {
      candidate,
      favorableRetracement,
      canonicalStopPreserved,
      withinExecutionWindow,
      entryImprovement: NumberUtils.round(entryImprovement),
      riskAtMinVolumeUsd: Number.isFinite(riskAtMinVolumeUsd)
        ? NumberUtils.round(riskAtMinVolumeUsd)
        : riskAtMinVolumeUsd,
      feasibleAtMinVolume,
      rejectionCodes,
    };
  }

  private riskAtMinVolume(
    entry: number,
    stopLoss: number,
    instrument: InstrumentRiskSpec,
  ): number {
    const stopDistance = Math.abs(entry - stopLoss);
    const stopTicks = stopDistance / instrument.tickSize;
    const riskPerLot = stopTicks * instrument.tickValuePerLot;
    return riskPerLot * instrument.minVolume;
  }

  private validate(request: EntryCompressionRequest): void {
    if (!Number.isFinite(request.canonicalEntry) || !Number.isFinite(request.canonicalStopLoss)) {
      throw new Error("canonical entry and stop loss must be finite");
    }
    if (!Number.isFinite(request.effectiveRiskCapUsd) || request.effectiveRiskCapUsd <= 0) {
      throw new Error("effectiveRiskCapUsd must be positive");
    }
    if (request.expiresAt < request.canonicalSignalTime) {
      throw new Error("expiresAt must be >= canonicalSignalTime");
    }
    if (request.instrument.tickSize <= 0 || request.instrument.tickValuePerLot <= 0) {
      throw new Error("instrument tick size/value must be positive");
    }
    if (request.instrument.minVolume <= 0) {
      throw new Error("instrument minVolume must be positive");
    }

    const validStop = request.side === OrderSide.BUY
      ? request.canonicalStopLoss < request.canonicalEntry
      : request.canonicalStopLoss > request.canonicalEntry;
    if (!validStop) {
      throw new Error("canonical stop loss is invalid for order side");
    }
  }
}
