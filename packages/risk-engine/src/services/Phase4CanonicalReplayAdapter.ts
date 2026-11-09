import { OrderSide } from "@xauusd/types";
import type {
  EntryCompressionRequest,
  InstrumentRiskSpec,
  Phase4M5Bar,
  Phase4ShadowTradeCase,
} from "../models";
import { Phase4M5CandidateService } from "./Phase4M5CandidateService";
import {
  Phase4ReplayResearchService,
  type Phase4ReplayCase,
  type Phase4ReplayResearchResult,
} from "./Phase4ReplayResearchService";

export interface Phase4CanonicalReplayCaseInput {
  id: string;
  side: OrderSide;
  canonicalEntry: number;
  canonicalStopLoss: number;
  canonicalTakeProfit?: number;
  signalTimestamp: number;
  expiresAt: number;
  effectiveRiskCapUsd: number;
  instrument: InstrumentRiskSpec;
  m5Bars: readonly Phase4M5Bar[];
  maxM5Bars?: number;
}

type ShadowInput = Phase4CanonicalReplayCaseInput & {
  canonicalTakeProfit: number;
};

export class Phase4CanonicalReplayAdapter {
  private readonly cases: Phase4ReplayCase[] = [];
  private readonly shadowInputs = new Map<string, ShadowInput>();

  constructor(
    private readonly candidateService = new Phase4M5CandidateService(),
    private readonly researchService = new Phase4ReplayResearchService(),
  ) {}

  add(input: Phase4CanonicalReplayCaseInput): void {
    const side = input.side === OrderSide.BUY ? "BUY" : "SELL";
    const built = this.candidateService.build({
      bars: input.m5Bars,
      signalTimestamp: input.signalTimestamp,
      expiresAt: input.expiresAt,
      canonicalEntry: input.canonicalEntry,
      side,
      maxBars: input.maxM5Bars,
    });

    const request: EntryCompressionRequest = {
      side: input.side,
      canonicalEntry: input.canonicalEntry,
      canonicalStopLoss: input.canonicalStopLoss,
      canonicalSignalTime: input.signalTimestamp,
      expiresAt: input.expiresAt,
      effectiveRiskCapUsd: input.effectiveRiskCapUsd,
      instrument: input.instrument,
      candidates: built.candidates,
    };

    this.cases.push({ id: input.id, request });

    if (
      typeof input.canonicalTakeProfit === "number" &&
      Number.isFinite(input.canonicalTakeProfit)
    ) {
      this.shadowInputs.set(input.id, input as ShadowInput);
    }
  }

  result(): Phase4ReplayResearchResult {
    return this.researchService.run(this.cases);
  }

  shadowCases(): Phase4ShadowTradeCase[] {
    const research = this.result();
    const shadowCases: Phase4ShadowTradeCase[] = [];

    for (const item of research.cases) {
      const input = this.shadowInputs.get(item.id);
      if (!input) continue;

      const compression = item.compression;
      if (!compression.canonicalFeasibleAtMinVolume && !compression.rescuedAtMinVolume) {
        continue;
      }

      const entry = compression.canonicalFeasibleAtMinVolume
        ? compression.canonicalEntry
        : compression.selectedEntry;
      if (entry === null || !Number.isFinite(entry)) continue;

      shadowCases.push({
        id: item.id,
        side: input.side === OrderSide.BUY ? "BUY" : "SELL",
        signalTimestamp: input.signalTimestamp,
        entryExpiresAt: input.expiresAt,
        entry,
        stopLoss: input.canonicalStopLoss,
        takeProfit: input.canonicalTakeProfit,
        volume: input.instrument.minVolume,
        tickSize: input.instrument.tickSize,
        tickValuePerLot: input.instrument.tickValuePerLot,
        m5Bars: input.m5Bars,
        entrySource: compression.canonicalFeasibleAtMinVolume
          ? "CANONICAL"
          : (compression.selectedSource ?? "OTHER_STRUCTURAL"),
      });
    }

    return shadowCases;
  }

  formatCounters(): string[] {
    const result = this.result();
    return this.researchService.formatCounters(result.counters);
  }

  get size(): number {
    return this.cases.length;
  }
}
