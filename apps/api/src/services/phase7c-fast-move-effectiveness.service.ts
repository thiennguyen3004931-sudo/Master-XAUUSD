import type {
  Phase7CPerformanceFastMoveContract,
  Phase7CPerformanceSide,
  Phase7CPerformanceStrategy,
} from "../contracts/phase7c-performance-effectiveness.schema";

const MIN_RECOMMENDATION_SAMPLE = 30;
const ACTIVATION_PRICE = 10;

const CURRENT_GIVEBACK: Record<Phase7CPerformanceStrategy, number> = {
  TREND: 10,
  SIDEWAY: 10,
  REVERSAL: 10,
};

const SHADOW_GIVEBACK: Record<Phase7CPerformanceStrategy, readonly number[]> = {
  TREND: [4, 5, 7, 8],
  SIDEWAY: [3, 5, 6],
  REVERSAL: [4, 5, 7, 8],
};

export interface Phase7CFastMovePriceSample {
  timestamp: number;
  price: number;
}

export interface Phase7CFastMoveReplayResult {
  triggered: boolean;
  triggerTimestamp: number | null;
  peakPrice: number;
  peakFavorable: number;
  stopHit: boolean;
  stopTimestamp: number | null;
  stopPrice: number | null;
  lockedProfitPrice: number | null;
}

export interface Phase7CFastMoveEffectivenessInput {
  strategy: Phase7CPerformanceStrategy;
  side: Phase7CPerformanceSide;
  entry: number;
  prices: readonly Phase7CFastMovePriceSample[];
  sampleSize: number;
}

export interface Phase7CFastMoveEffectivenessResult {
  strategy: Phase7CPerformanceStrategy;
  side: Phase7CPerformanceSide;
  current: {
    mode: "CURRENT_OBSERVED_CONTRACT";
    contract: Phase7CPerformanceFastMoveContract;
    result: Phase7CFastMoveReplayResult;
  };
  shadow: Array<{
    mode: "SHADOW_ONLY";
    givebackPrice: number;
    result: Phase7CFastMoveReplayResult;
  }>;
  sample: {
    sampleSize: number;
    minimumRecommendationSample: 30;
    recommendationEligible: boolean;
  };
  safety: {
    readOnly: true;
    orderMutation: false;
    positionMutation: false;
    strategyMutation: false;
    riskMutation: false;
    autoApply: false;
  };
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function currentContract(strategy: Phase7CPerformanceStrategy): Phase7CPerformanceFastMoveContract {
  return {
    activationPrice: ACTIVATION_PRICE,
    givebackPrice: CURRENT_GIVEBACK[strategy],
    source: "LIVE_BID_ASK",
  };
}

function emptyReplay(entry: number): Phase7CFastMoveReplayResult {
  return {
    triggered: false,
    triggerTimestamp: null,
    peakPrice: entry,
    peakFavorable: 0,
    stopHit: false,
    stopTimestamp: null,
    stopPrice: null,
    lockedProfitPrice: null,
  };
}

function replay(
  side: Phase7CPerformanceSide,
  entry: number,
  prices: readonly Phase7CFastMovePriceSample[],
  givebackPrice: number,
): Phase7CFastMoveReplayResult {
  if (!(entry > 0) || !(givebackPrice >= 0) || !(ACTIVATION_PRICE >= givebackPrice)) {
    return emptyReplay(entry);
  }

  const ordered = [...prices]
    .filter((sample) => Number.isFinite(Number(sample.timestamp)) && Number(sample.price) > 0)
    .map((sample) => ({ timestamp: Number(sample.timestamp), price: Number(sample.price) }))
    .sort((left, right) => left.timestamp - right.timestamp);
  if (ordered.length === 0) return emptyReplay(entry);

  let peakPrice = entry;
  let peakFavorable = 0;
  let triggered = false;
  let triggerTimestamp: number | null = null;
  let stopPrice: number | null = null;
  let stopHit = false;
  let stopTimestamp: number | null = null;

  for (const sample of ordered) {
    if (side === "BUY") peakPrice = Math.max(peakPrice, sample.price);
    else peakPrice = Math.min(peakPrice, sample.price);

    peakFavorable = side === "BUY" ? peakPrice - entry : entry - peakPrice;
    if (peakFavorable + 1e-9 >= ACTIVATION_PRICE) {
      if (!triggered) {
        triggered = true;
        triggerTimestamp = sample.timestamp;
      }
      const candidate = side === "BUY" ? peakPrice - givebackPrice : peakPrice + givebackPrice;
      const locksProfit = side === "BUY" ? candidate > entry + 1e-9 : candidate < entry - 1e-9;
      if (locksProfit) {
        stopPrice = stopPrice === null
          ? candidate
          : side === "BUY"
            ? Math.max(stopPrice, candidate)
            : Math.min(stopPrice, candidate);
      }
    }

    if (stopPrice !== null) {
      const hit = side === "BUY" ? sample.price <= stopPrice : sample.price >= stopPrice;
      if (hit) {
        stopHit = true;
        stopTimestamp = sample.timestamp;
        break;
      }
    }
  }

  const lockedProfitPrice = stopPrice === null
    ? null
    : side === "BUY"
      ? stopPrice - entry
      : entry - stopPrice;

  return {
    triggered,
    triggerTimestamp,
    peakPrice: round(peakPrice),
    peakFavorable: round(Math.max(0, peakFavorable)),
    stopHit,
    stopTimestamp,
    stopPrice: stopPrice === null ? null : round(stopPrice),
    lockedProfitPrice: lockedProfitPrice === null ? null : round(Math.max(0, lockedProfitPrice)),
  };
}

export function evaluatePhase7CFastMoveEffectiveness(
  input: Phase7CFastMoveEffectivenessInput,
): Phase7CFastMoveEffectivenessResult {
  const strategy = input.strategy;
  const side = input.side;
  const entry = Number(input.entry);
  const sampleSize = Math.max(0, Math.trunc(Number(input.sampleSize) || 0));
  const contract = currentContract(strategy);

  return {
    strategy,
    side,
    current: {
      mode: "CURRENT_OBSERVED_CONTRACT",
      contract,
      result: replay(side, entry, input.prices, contract.givebackPrice),
    },
    shadow: SHADOW_GIVEBACK[strategy].map((givebackPrice) => ({
      mode: "SHADOW_ONLY" as const,
      givebackPrice,
      result: replay(side, entry, input.prices, givebackPrice),
    })),
    sample: {
      sampleSize,
      minimumRecommendationSample: MIN_RECOMMENDATION_SAMPLE,
      recommendationEligible: sampleSize >= MIN_RECOMMENDATION_SAMPLE,
    },
    safety: {
      readOnly: true,
      orderMutation: false,
      positionMutation: false,
      strategyMutation: false,
      riskMutation: false,
      autoApply: false,
    },
  };
}
