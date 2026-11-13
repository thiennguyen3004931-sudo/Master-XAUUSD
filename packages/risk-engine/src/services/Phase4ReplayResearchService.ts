import type { EntryCompressionRequest, EntryCompressionResult } from "../models";
import { EntryCompressionService } from "./EntryCompressionService";

export interface Phase4ReplayCase {
  id: string;
  request: EntryCompressionRequest;
}

export interface Phase4ReplayCounters {
  totalCases: number;
  canonicalMinLotFeasible: number;
  canonicalMinLotBlocked: number;
  compressionAttempted: number;
  candidateFound: number;
  candidateExpiredOnly: number;
  canonicalStopCrossedOnly: number;
  stillMinLotBlocked: number;
  minLotRescued: number;
  finalMinLotFeasible: number;
}

export interface Phase4ReplayCaseResult {
  id: string;
  compression: EntryCompressionResult;
}

export interface Phase4ReplayResearchResult {
  counters: Phase4ReplayCounters;
  cases: Phase4ReplayCaseResult[];
}

export class Phase4ReplayResearchService {
  constructor(
    private readonly compressionService = new EntryCompressionService(),
  ) {}

  run(cases: readonly Phase4ReplayCase[]): Phase4ReplayResearchResult {
    const counters: Phase4ReplayCounters = {
      totalCases: 0,
      canonicalMinLotFeasible: 0,
      canonicalMinLotBlocked: 0,
      compressionAttempted: 0,
      candidateFound: 0,
      candidateExpiredOnly: 0,
      canonicalStopCrossedOnly: 0,
      stillMinLotBlocked: 0,
      minLotRescued: 0,
      finalMinLotFeasible: 0,
    };

    const results = cases.map((item) => {
      const compression = this.compressionService.evaluate(item.request);
      counters.totalCases += 1;

      if (compression.canonicalFeasibleAtMinVolume) {
        counters.canonicalMinLotFeasible += 1;
        counters.finalMinLotFeasible += 1;
      } else {
        counters.canonicalMinLotBlocked += 1;
        counters.compressionAttempted += 1;
      }

      if (item.request.candidates.length > 0) {
        counters.candidateFound += 1;
      }

      if (!compression.canonicalFeasibleAtMinVolume) {
        if (compression.rescuedAtMinVolume) {
          counters.minLotRescued += 1;
          counters.finalMinLotFeasible += 1;
        } else {
          counters.stillMinLotBlocked += 1;
        }
      }

      if (
        item.request.candidates.length > 0 &&
        compression.assessments.every((assessment) =>
          assessment.rejectionCodes.includes("OUTSIDE_EXECUTION_WINDOW"),
        )
      ) {
        counters.candidateExpiredOnly += 1;
      }

      if (
        item.request.candidates.length > 0 &&
        compression.assessments.every((assessment) =>
          assessment.rejectionCodes.includes("CANONICAL_STOP_CROSSED"),
        )
      ) {
        counters.canonicalStopCrossedOnly += 1;
      }

      return { id: item.id, compression };
    });

    return { counters, cases: results };
  }

  formatCounters(counters: Phase4ReplayCounters): string[] {
    return [
      `PHASE4_TOTAL_CASES=${counters.totalCases}`,
      `PHASE4_CANONICAL_MINLOT_FEASIBLE=${counters.canonicalMinLotFeasible}`,
      `PHASE4_CANONICAL_MINLOT_BLOCKED=${counters.canonicalMinLotBlocked}`,
      `PHASE4_COMPRESSION_ATTEMPTED=${counters.compressionAttempted}`,
      `PHASE4_CANDIDATE_FOUND=${counters.candidateFound}`,
      `PHASE4_CANDIDATE_EXPIRED_ONLY=${counters.candidateExpiredOnly}`,
      `PHASE4_CANONICAL_STOP_CROSSED_ONLY=${counters.canonicalStopCrossedOnly}`,
      `PHASE4_STILL_MINLOT_BLOCKED=${counters.stillMinLotBlocked}`,
      `PHASE4_MINLOT_RESCUED=${counters.minLotRescued}`,
      `PHASE4_FINAL_MINLOT_FEASIBLE=${counters.finalMinLotFeasible}`,
    ];
  }
}
