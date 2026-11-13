import {
  AnalysisPipeline,
} from "@xauusd/analysis-engine";

import {
  defaultExecutionEngineConfig,
  PositionManagementService,
  type ManagementCommand,
  type PositionManagementDecision,
  type PositionManagementState,
  type SymbolExecutionSpec,
  type TrendStructureSnapshot,
} from "@xauusd/execution-engine";

import {
  IndicatorPipeline,
} from "@xauusd/indicators";

import {
  Timeframe,
} from "@xauusd/market-data";

import {
  PositionSide,
  Trend,
  MarketStructure,
  type Position,
} from "@xauusd/types";

import {
  getControlState,
} from "./control.service";

import {
  getExecutionRepository,
} from "./execution-state.service";

import {
  getManagementStateRepository,
} from "./management-state.service";

import {
  getPhase7CSemiAdoptionStateRepository,
} from "./phase7c-semi-adoption-runtime.service";

import type {
  DurableManagementCommand,
  IManagementStateRepository,
} from "./sqlite-management-state.repository";

import {
  getMt5AllPositions,
  getMt5RealMarketData,
} from "./mt5-market.service";

import {
  buildMt5OpenRiskPositions,
} from "./mt5-portfolio-risk.service";

import {
  resolveTrendManagementOwner,
} from "./trend-management-owner.service";

const DEFAULT_SYMBOL = "XAUUSD";
const DEFAULT_CANDLE_COUNT = 320;
const MAX_CLOSED_M15_AGE_MS = 20 * 60_000;

export interface TrendManagementRuntimeConfig {
  enabled: boolean;
  executionEnabled: boolean;
  symbol: string;
  timeframe: Timeframe;
  candleCount: number;
}

export const defaultTrendManagementRuntimeConfig:
  Readonly<TrendManagementRuntimeConfig> =
  Object.freeze({
    enabled: false,
    executionEnabled: false,
    symbol: DEFAULT_SYMBOL,
    timeframe: Timeframe.M15,
    candleCount: DEFAULT_CANDLE_COUNT,
  });

export type TrendManagementRuntimeAction =
  | "DISABLED"
  | "BLOCKED"
  | "NO_POSITION"
  | "EVALUATED";

export interface TrendManagementRuntimeResult {
  action: TrendManagementRuntimeAction;
  reason: string;
  ticket?: string;
  marketTimestamp?: number;
  trendValid?: boolean;
  structureBroken?: boolean;
  commands: ManagementCommand[];
  durableCommands: DurableManagementCommand[];
  notes: string[];
  decision?: PositionManagementDecision;
  mutationPerformed: false;
  statePersistenceRequired: true;
  statePersisted: boolean;
  generatedAt: number;
}

export interface TrendManagementRuntimeDependencies {
  now: () => number;
  getControlState: typeof getControlState;
  getExecutionRepository:
    () => Pick<
      ReturnType<typeof getExecutionRepository>,
      "listOpen"
    >;
  getSemiAdoptionStateRepository:
    () => Pick<
      ReturnType<typeof getPhase7CSemiAdoptionStateRepository>,
      "listActive" | "save"
    >;
  getManagementStateRepository:
    () => IManagementStateRepository;
  getMt5AllPositions:
    typeof getMt5AllPositions;
  getMt5RealMarketData:
    typeof getMt5RealMarketData;
  buildMt5OpenRiskPositions:
    typeof buildMt5OpenRiskPositions;
  createAnalysisEngine:
    () => Pick<AnalysisPipeline, "analyze">;
  createIndicatorEngine:
    () => Pick<IndicatorPipeline, "calculate">;
  createPositionManagementService:
    () => Pick<
      PositionManagementService,
      "evaluate"
    >;
}

export const defaultTrendManagementRuntimeDependencies:
  Readonly<TrendManagementRuntimeDependencies> =
  Object.freeze({
    now: Date.now,
    getControlState,
    getExecutionRepository,
    getSemiAdoptionStateRepository:
      getPhase7CSemiAdoptionStateRepository,
    getManagementStateRepository,
    getMt5AllPositions,
    getMt5RealMarketData,
    buildMt5OpenRiskPositions,
    createAnalysisEngine:
      () => new AnalysisPipeline(),
    createIndicatorEngine:
      () => new IndicatorPipeline(),
    createPositionManagementService:
      () =>
        new PositionManagementService(
          defaultExecutionEngineConfig,
        ),
  });

function deriveDigits(
  tickSize: number,
): number {
  if (
    !Number.isFinite(tickSize) ||
    tickSize <= 0
  ) {
    return 2;
  }

  const text = tickSize.toFixed(10)
    .replace(/0+$/, "");

  const dot = text.indexOf(".");

  return dot < 0
    ? 0
    : text.length - dot - 1;
}

function latestSwingPrice(
  swings: readonly {
    type: unknown;
    price: number;
    timestamp?: number;
    index?: number;
  }[],
  type: "LOW" | "HIGH",
): number | undefined {
  const candidates = swings
    .filter(
      (swing) =>
        String(swing.type) === type &&
        Number.isFinite(swing.price),
    )
    .sort(
      (left, right) =>
        Number(
          left.timestamp ??
          left.index ??
          0,
        ) -
        Number(
          right.timestamp ??
          right.index ??
          0,
        ),
    );

  return candidates.at(-1)?.price;
}

function createTrendSnapshot(
  position: Position,
  analysis: ReturnType<
    AnalysisPipeline["analyze"]
  >,
  assessedAt: number,
): TrendStructureSnapshot {
  const isLong =
    position.side === PositionSide.LONG;

  const alignedTrend = isLong
    ? analysis.trend === Trend.Bullish
    : analysis.trend === Trend.Bearish;

  const alignedStructure = isLong
    ? analysis.structure ===
      MarketStructure.Bullish
    : analysis.structure ===
      MarketStructure.Bearish;

  const opposingTrend = isLong
    ? Trend.Bearish
    : Trend.Bullish;

  const latestConfirmed =
    [...analysis.structureEvents]
      .filter((event) => event.confirmed)
      .sort(
        (left, right) =>
          left.timestamp - right.timestamp,
      )
      .at(-1);

  const structureBroken =
    latestConfirmed?.type === "CHOCH" &&
    latestConfirmed.direction === opposingTrend;

  return {
    trendValid:
      alignedTrend &&
      alignedStructure &&
      !structureBroken,
    structureBroken,
    latestSwingLow:
      latestSwingPrice(
        analysis.swings,
        "LOW",
      ),
    latestSwingHigh:
      latestSwingPrice(
        analysis.swings,
        "HIGH",
      ),
    assessedAt,
  };
}

function brokerProtectionState(
  position: Position,
): {
  protectedAtOrBeyondEntry: boolean;
  stopLoss?: number;
} {
  const isLong =
    position.side === PositionSide.LONG;

  const protectedAtOrBeyondEntry =
    position.stopLoss > 0 &&
    (
      isLong
        ? position.stopLoss >= position.entry
        : position.stopLoss <= position.entry
    );

  return {
    protectedAtOrBeyondEntry,
    stopLoss:
      protectedAtOrBeyondEntry
        ? position.stopLoss
        : undefined,
  };
}

function inferManagementState(
  position: Position,
): PositionManagementState {
  const protection =
    brokerProtectionState(position);

  return {
    initialVolume: position.volume,
    completedTargetLabels: [],
    breakEvenApplied:
      protection.protectedAtOrBeyondEntry,
    trailingActivated:
      protection.protectedAtOrBeyondEntry,
    trailingStopPrice:
      protection.stopLoss,
  };
}

function reconcileManagementState(
  position: Position,
  persisted:
    | PositionManagementState
    | undefined,
): PositionManagementState {
  const inferred =
    inferManagementState(position);

  if (!persisted) {
    return inferred;
  }

  return {
    ...persisted,
    initialVolume:
      persisted.initialVolume > 0
        ? persisted.initialVolume
        : position.volume,

    // Broker SL is authoritative for "applied" state.
    breakEvenApplied:
      inferred.breakEvenApplied,
    trailingStopPrice:
      inferred.trailingStopPrice,

    // Notification/activation state may survive restart.
    trailingActivated:
      Boolean(
        persisted.trailingActivated ||
        inferred.trailingActivated
      ),

    completedTargetLabels: [
      ...persisted.completedTargetLabels,
    ],
  };
}

function durableStateAfterEvaluation(
  position: Position,
  evaluated:
    PositionManagementState,
): PositionManagementState {
  const inferred =
    inferManagementState(position);

  return {
    ...evaluated,

    // Never mark a stop as applied before broker mutation.
    breakEvenApplied:
      inferred.breakEvenApplied,
    trailingStopPrice:
      inferred.trailingStopPrice,

    // This is a durable notification/arming state, not proof
    // that the broker stop was modified.
    trailingActivated:
      Boolean(
        evaluated.trailingActivated ||
        inferred.trailingActivated
      ),
  };
}

function toExecutionSpec(
  spec: Awaited<
    ReturnType<typeof getMt5RealMarketData>
  >["spec"],
): SymbolExecutionSpec {
  return {
    symbol: spec.symbol,
    tickSize: spec.tickSize,
    digits: deriveDigits(spec.tickSize),
    minVolume: spec.minVolume,
    maxVolume: spec.maxVolume,
    volumeStep: spec.volumeStep,
    maxSpread: spec.maxSpread,
    stopsLevelTicks:
      spec.stopsLevelTicks,
    freezeLevelTicks:
      spec.freezeLevelTicks,
  };
}

function result(
  action: TrendManagementRuntimeAction,
  reason: string,
  generatedAt: number,
  extra: Partial<
    Omit<
      TrendManagementRuntimeResult,
      | "action"
      | "reason"
      | "mutationPerformed"
      | "statePersistenceRequired"
      | "generatedAt"
    >
  > = {},
): TrendManagementRuntimeResult {
  return {
    action,
    reason,
    commands: [],
    durableCommands: [],
    notes: [],
    mutationPerformed: false,
    statePersistenceRequired: true,
    statePersisted: false,
    generatedAt,
    ...extra,
  };
}

export function createTrendManagementRuntimeEvaluator(
  dependencies: Partial<
    TrendManagementRuntimeDependencies
  > = {},
) {
  const deps: TrendManagementRuntimeDependencies = {
    ...defaultTrendManagementRuntimeDependencies,
    ...dependencies,
  };

  return async function evaluateTrendManagementRuntimeWithDependencies(
    override: Partial<
      TrendManagementRuntimeConfig
    > = {},
  ): Promise<TrendManagementRuntimeResult> {
    const config: TrendManagementRuntimeConfig = {
      ...defaultTrendManagementRuntimeConfig,
      ...override,
    };

    const generatedAt = deps.now();

    if (!config.enabled) {
      return result(
        "DISABLED",
        "Trend management runtime is dormant.",
        generatedAt,
      );
    }

    if (config.executionEnabled) {
      return result(
        "BLOCKED",
        "3E.5ZE refuses executionEnabled=true.",
        generatedAt,
      );
    }

    const symbol =
      config.symbol.trim().toUpperCase();

    if (
      symbol !== DEFAULT_SYMBOL ||
      config.timeframe !== Timeframe.M15 ||
      !Number.isInteger(config.candleCount) ||
      config.candleCount < 200
    ) {
      return result(
        "BLOCKED",
        "Only XAUUSD M15 with at least 200 candles is allowed.",
        generatedAt,
      );
    }

    const control = deps.getControlState();

    if (
      control.mode !== "DEMO" ||
      !control.tradingEnabled ||
      control.liveUnlockAvailable !== false
    ) {
      return result(
        "BLOCKED",
        "DEMO control mode is required; LIVE remains unavailable.",
        generatedAt,
      );
    }

    const repository =
      deps.getExecutionRepository();
    const semiRepository =
      deps.getSemiAdoptionStateRepository();

    const [
      openExecutionRecords,
      semiAdoptions,
    ] = await Promise.all([
      repository.listOpen(),
      semiRepository.listActive(),
    ]);

    const ownership =
      resolveTrendManagementOwner({
        symbol,
        openExecutionRecords,
        semiAdoptions,
      });

    if (ownership.status === "NONE") {
      return result(
        "NO_POSITION",
        ownership.reason,
        generatedAt,
      );
    }

    if (ownership.status === "BLOCKED") {
      return result(
        "BLOCKED",
        ownership.reason,
        generatedAt,
      );
    }

    const owner = ownership.owner;
    const plan = owner.plan;
    const ticket = owner.ticket;
    const ownerId = owner.ownerId;

    const [
      market,
      bridgePositions,
    ] = await Promise.all([
      deps.getMt5RealMarketData(
        symbol,
        config.timeframe,
        config.candleCount,
      ),
      deps.getMt5AllPositions(),
    ]);

    const xauPositions =
      bridgePositions.filter(
        (position) =>
          position.symbol === symbol,
      );

    if (xauPositions.length !== 1) {
      return result(
        "BLOCKED",
        `Expected exactly one broker XAUUSD position; found ${xauPositions.length}.`,
        generatedAt,
        { ticket },
      );
    }

    const canonicalPositions =
      deps.buildMt5OpenRiskPositions(
        xauPositions,
        market.spec,
        market.quote.bid,
        market.quote.ask,
        market.account.equity,
      ).map(
        (entry) => entry.position,
      );

    const position =
      canonicalPositions.find(
        (candidate) =>
          candidate.ticket === ticket,
      );

    if (!position) {
      return result(
        "BLOCKED",
        "Broker ticket does not match the durable management owner ticket.",
        generatedAt,
        { ticket },
      );
    }

    const latestCandle =
      market.candles.at(-1);

    if (!latestCandle) {
      return result(
        "BLOCKED",
        "No M15 candle is available.",
        generatedAt,
        { ticket },
      );
    }

    const marketTimestamp =
      latestCandle.closeTime;

    const candleAge =
      generatedAt - marketTimestamp;

    if (
      candleAge < 0 ||
      candleAge > MAX_CLOSED_M15_AGE_MS
    ) {
      return result(
        "BLOCKED",
        `Closed M15 candle is stale or invalid: ageMs=${candleAge}.`,
        generatedAt,
        {
          ticket,
          marketTimestamp,
        },
      );
    }

    const analysis =
      deps.createAnalysisEngine().analyze(
        symbol,
        config.timeframe,
        market.candles,
      );

    const indicators =
      deps.createIndicatorEngine().calculate(
        market.candles,
      );

    const atr =
      indicators.latest.atr ??
      analysis.metrics.averageTrueRange;

    if (
      !Number.isFinite(atr) ||
      atr <= 0
    ) {
      return result(
        "BLOCKED",
        "ATR is unavailable for management.",
        generatedAt,
        {
          ticket,
          marketTimestamp,
        },
      );
    }

    const managementRepository =
      deps.getManagementStateRepository();

    const persisted =
      await managementRepository
        .findPositionState(ticket);

    if (
      persisted &&
      persisted.executionRecordId !== ownerId
    ) {
      return result(
        "BLOCKED",
        "Durable management state ownership does not match selected owner.",
        generatedAt,
        {
          ticket,
          marketTimestamp,
        },
      );
    }

    const managementState =
      reconcileManagementState(
        position,
        persisted?.state,
      );

    const trendStructure =
      createTrendSnapshot(
        position,
        analysis,
        marketTimestamp,
      );

    const decision =
      deps.createPositionManagementService()
        .evaluate({
          plan,
          position,
          quote: {
            symbol,
            bid: market.quote.bid,
            ask: market.quote.ask,
            spread: market.quote.spread,
            timestamp:
              market.quote.timestamp,
          },
          spec:
            toExecutionSpec(market.spec),
          atr,
          state:
            managementState,
          trendStructure,
          evaluatedAt: generatedAt,
        });

    const stateToPersist =
      durableStateAfterEvaluation(
        position,
        decision.updatedState,
      );

    await managementRepository
      .savePositionState({
        ticket,
        executionRecordId: ownerId,
        state: stateToPersist,
        lastMarketTimestamp:
          marketTimestamp,
        updatedAt:
          generatedAt,
      });

    const durableCommands:
      DurableManagementCommand[] = [];

    const reviewCommands:
      ManagementCommand[] = [];

    for (const command of decision.commands) {
      const prepared =
        await managementRepository
          .prepareCommand(
            ownerId,
            command,
            generatedAt,
          );

      durableCommands.push(prepared);

      if (prepared.status === "PENDING") {
        reviewCommands.push(
          structuredClone(prepared.command),
        );
      }
    }

    if (
      owner.kind === "MANUAL_SEMI" &&
      owner.semiAdoption.protectionStatus === "PROTECTED"
    ) {
      await semiRepository.save({
        ...owner.semiAdoption,
        protectionStatus: "MANAGED",
        protectionReason: "TREND_MANAGEMENT_ACTIVE",
        updatedAt: generatedAt,
      });
    }

    return result(
      "EVALUATED",
      reviewCommands.length > 0
        ? "Durable management commands are ready for review only."
        : "No new pending management command is required.",
      generatedAt,
      {
        ticket,
        marketTimestamp,
        trendValid:
          trendStructure.trendValid,
        structureBroken:
          trendStructure.structureBroken,
        commands:
          reviewCommands,
        durableCommands,
        notes: [
          ...decision.notes,
          owner.kind === "MANUAL_SEMI"
            ? `Management owner=MANUAL_SEMI:${ownerId}.`
            : `Management owner=SYSTEM:${ownerId}.`,
          "3E.5ZE durable preview only: commands were NOT claimed or executed.",
        ],
        decision,
        statePersisted: true,
      },
    );
  };
}

/**
 * Production/default export stays dormant.
 * No scheduler/route imports this function.
 */
export const evaluateTrendManagementRuntime =
  createTrendManagementRuntimeEvaluator();