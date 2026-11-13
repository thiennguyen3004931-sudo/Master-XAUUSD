import { PositionSide } from "@xauusd/types";
import type { ExecutionEngineConfig } from "../config";
import type {
  ManagementCommand,
  PositionManagementContext,
  PositionManagementDecision,
  PositionManagementState,
  TrendStructureSnapshot,
} from "../models";
import { IdFactory, MarketMath, NumberUtils } from "../utils";
import { ManagementInputValidator } from "../validators";

const TREND_SNAPSHOT_MAX_AGE_MS = 5 * 60_000;
const TRAILING_ACTIVATION_MESSAGE =
  "Đã đủ điều kiện kích hoạt Trailing Stop.";

export class PositionManagementService {
  constructor(
    private readonly config: ExecutionEngineConfig,
    private readonly validator = new ManagementInputValidator(),
    private readonly ids = new IdFactory(),
  ) {}

  evaluate(
    context: PositionManagementContext,
  ): PositionManagementDecision {
    this.validator.validate(context);

    const generatedAt =
      context.evaluatedAt ?? Date.now();

    const currentPrice =
      MarketMath.currentExitPrice(
        context.position.side,
        context.quote.bid,
        context.quote.ask,
      );

    const currentRiskMultiple =
      MarketMath.riskMultiple(
        context.position.side,
        context.position.entry,
        context.plan.order.stopLoss,
        currentPrice,
      );

    const updatedState: PositionManagementState = {
      ...context.state,
      completedTargetLabels: [
        ...context.state.completedTargetLabels,
      ],
      lastManagedAt: generatedAt,
    };

    const commands: ManagementCommand[] = [];
    const notes: string[] = [];

    const terminal = this.createTerminalCommand(
      context,
      currentPrice,
      generatedAt,
    );

    if (terminal) {
      commands.push(terminal);
      notes.push(terminal.reason);

      return {
        commands,
        updatedState,
        currentRiskMultiple:
          NumberUtils.round(currentRiskMultiple),
        notes,
        generatedAt,
      };
    }

    for (
      const target of
      context.plan.management.partialTargets
    ) {
      if (
        updatedState.completedTargetLabels.includes(
          target.label,
        ) ||
        !MarketMath.hasReachedTarget(
          context.position.side,
          currentPrice,
          target.price,
        )
      ) {
        continue;
      }

      const requestedVolume =
        (
          updatedState.initialVolume *
          target.closePercent
        ) / 100;

      const volume = MarketMath.floorVolume(
        Math.min(
          requestedVolume,
          context.position.volume,
        ),
        context.spec.volumeStep,
      );

      if (volume >= context.spec.minVolume) {
        commands.push({
          type: "PARTIAL_CLOSE",
          commandId:
            this.ids.create(
              "partial",
              generatedAt,
            ),
          ticket: context.position.ticket,
          volume,
          targetLabel: target.label,
          reason:
            `${target.label} reached at ${target.price}.`,
          expiresAt:
            generatedAt +
            this.config.managementCommandTtlMs,
        });

        updatedState.completedTargetLabels.push(
          target.label,
        );

        notes.push(
          `${target.label} partial close scheduled.`,
        );
      }
    }

    const trailing =
      context.plan.management.trailingStop;

    if (trailing.mode === "TREND_STRUCTURE") {
      const favorableMove =
        this.favorablePriceMove(
          context,
          currentPrice,
        );

      const activateAt =
        trailing.activateAtProfitPrice ?? 6;

      if (
        favorableMove >= activateAt &&
        !updatedState.trailingActivated
      ) {
        updatedState.trailingActivated = true;
        notes.push(TRAILING_ACTIVATION_MESSAGE);
      }

      const stopCommand =
        this.createTrendProtectiveStopCommand(
          context,
          currentPrice,
          favorableMove,
          generatedAt,
        );

      if (stopCommand) {
        commands.push(stopCommand);

        if (
          stopCommand.reason === "BREAK_EVEN"
        ) {
          updatedState.breakEvenApplied = true;
        }
        else {
          updatedState.trailingStopPrice =
            stopCommand.stopLoss;
        }

        notes.push(
          `${stopCommand.reason} modification scheduled.`,
        );
      }

      return {
        commands,
        updatedState,
        currentRiskMultiple:
          NumberUtils.round(currentRiskMultiple),
        notes,
        generatedAt,
      };
    }

    // Legacy ATR/R management branch.
    const stopCommand =
      this.createLegacyProtectiveStopCommand(
        context,
        currentPrice,
        currentRiskMultiple,
        updatedState,
        generatedAt,
      );

    if (stopCommand) {
      commands.push(stopCommand);

      if (stopCommand.reason === "BREAK_EVEN") {
        updatedState.breakEvenApplied = true;
      }
      else {
        updatedState.trailingStopPrice =
          stopCommand.stopLoss;
      }

      notes.push(
        `${stopCommand.reason} modification scheduled.`,
      );
    }

    return {
      commands,
      updatedState,
      currentRiskMultiple:
        NumberUtils.round(currentRiskMultiple),
      notes,
      generatedAt,
    };
  }

  private createTerminalCommand(
    context: PositionManagementContext,
    currentPrice: number,
    generatedAt: number,
  ): ManagementCommand | null {
    const isLong =
      context.position.side === PositionSide.LONG;

    const invalidated = isLong
      ? currentPrice <=
        context.plan.management.hardInvalidationPrice
      : currentPrice >=
        context.plan.management.hardInvalidationPrice;

    if (invalidated) {
      return {
        type: "CLOSE_POSITION",
        commandId:
          this.ids.create(
            "close-invalid",
            generatedAt,
          ),
        ticket: context.position.ticket,
        volume: context.position.volume,
        reason: "HARD_INVALIDATION",
        expiresAt:
          generatedAt +
          this.config.managementCommandTtlMs,
      };
    }

    const trendHold =
      context.plan.management
        .trendHoldUntilStructureBreak === true;

    if (
      trendHold &&
      this.isFreshTrendSnapshot(
        context.trendStructure,
        generatedAt,
      ) &&
      context.trendStructure?.structureBroken === true
    ) {
      return {
        type: "CLOSE_POSITION",
        commandId:
          this.ids.create(
            "close-trend-break",
            generatedAt,
          ),
        ticket: context.position.ticket,
        volume: context.position.volume,
        reason: "TREND_STRUCTURE_BREAK",
        expiresAt:
          generatedAt +
          this.config.managementCommandTtlMs,
      };
    }

    if (
      generatedAt >=
      context.plan.management.timeStopAt
    ) {
      const freshTrendStillValid =
        trendHold &&
        this.isFreshTrendSnapshot(
          context.trendStructure,
          generatedAt,
        ) &&
        context.trendStructure?.trendValid === true &&
        context.trendStructure?.structureBroken === false;

      if (!freshTrendStillValid) {
        return {
          type: "CLOSE_POSITION",
          commandId:
            this.ids.create(
              "close-time",
              generatedAt,
            ),
          ticket: context.position.ticket,
          volume: context.position.volume,
          reason: "TIME_STOP",
          expiresAt:
            generatedAt +
            this.config.managementCommandTtlMs,
        };
      }
    }

    return null;
  }

  private favorablePriceMove(
    context: PositionManagementContext,
    currentPrice: number,
  ): number {
    const isLong =
      context.position.side === PositionSide.LONG;

    return Math.max(
      0,
      isLong
        ? currentPrice - context.position.entry
        : context.position.entry - currentPrice,
    );
  }

  private isFreshTrendSnapshot(
    snapshot:
      | TrendStructureSnapshot
      | undefined,
    generatedAt: number,
  ): boolean {
    if (
      !snapshot ||
      snapshot.assessedAt === undefined ||
      !Number.isFinite(snapshot.assessedAt)
    ) {
      return false;
    }

    if (snapshot.assessedAt > generatedAt) {
      return false;
    }

    return (
      generatedAt - snapshot.assessedAt <=
      TREND_SNAPSHOT_MAX_AGE_MS
    );
  }

  private createTrendProtectiveStopCommand(
    context: PositionManagementContext,
    currentPrice: number,
    favorableMove: number,
    generatedAt: number,
  ): Extract<
    ManagementCommand,
    { type: "MODIFY_STOP" }
  > | null {
    const trailing =
      context.plan.management.trailingStop;

    if (!trailing.enabled) {
      return null;
    }

    const activateAt =
      trailing.activateAtProfitPrice ?? 6;

    if (favorableMove < activateAt) {
      return null;
    }

    const structureAt =
      trailing.structureTrailAtProfitPrice ?? 10;

    const positiveLock =
      trailing.positiveLockPrice ?? 0.5;

    const swingBufferAtr =
      trailing.swingBufferAtrMultiple ?? 0.25;

    const minimumDistanceAtr =
      trailing.minimumDistanceAtrMultiple ?? 0.5;

    const isLong =
      context.position.side === PositionSide.LONG;

    const tickSize = context.spec.tickSize;
    const positiveCandidate = isLong
      ? context.position.entry + positiveLock
      : context.position.entry - positiveLock;

    const freshTrend =
      this.isFreshTrendSnapshot(
        context.trendStructure,
        generatedAt,
      );

    const trendValid =
      freshTrend &&
      context.trendStructure?.trendValid === true &&
      context.trendStructure?.structureBroken === false;

    const swing = isLong
      ? context.trendStructure?.latestSwingLow
      : context.trendStructure?.latestSwingHigh;

    const swingUsable =
      trendValid &&
      typeof swing === "number" &&
      Number.isFinite(swing) &&
      swing > 0 &&
      (
        isLong
          ? swing < currentPrice
          : swing > currentPrice
      );

    const swingCandidate = swingUsable
      ? (
          isLong
            ? (
                swing as number
              ) - context.atr * swingBufferAtr
            : (
                swing as number
              ) + context.atr * swingBufferAtr
        )
      : null;

    const swingLocksPositive =
      swingCandidate !== null &&
      (
        isLong
          ? swingCandidate >= positiveCandidate
          : swingCandidate <= positiveCandidate
      );

    let candidate: number | null = null;
    let reason:
      | "BREAK_EVEN"
      | "TRAILING_STOP"
      | null = null;

    if (favorableMove < structureAt) {
      // +6 only ARMS trailing. Do not mechanically force the stop
      // to entry +/- 0.50. Between +6 and +10 we only protect the
      // trade when a fresh confirmed swing has moved far enough to
      // place a buffered stop on the profitable side of entry.
      if (!swingLocksPositive) {
        return null;
      }

      candidate = swingCandidate;
      reason = "BREAK_EVEN";
    }
    else {
      // From +10 onward, prefer the fresh protective swing.
      // If no usable swing exists, fall back to 1.5 ATR, but never
      // accept a fallback that gives up positive protection.
      const trailingCandidate =
        swingCandidate !== null
          ? swingCandidate
          : (
              isLong
                ? currentPrice -
                  context.atr * trailing.atrMultiple
                : currentPrice +
                  context.atr * trailing.atrMultiple
            );

      const trailingLocksPositive = isLong
        ? trailingCandidate >= positiveCandidate
        : trailingCandidate <= positiveCandidate;

      if (!trailingLocksPositive) {
        return null;
      }

      candidate = trailingCandidate;
      reason = "TRAILING_STOP";
    }

    if (
      candidate === null ||
      reason === null
    ) {
      return null;
    }

    const minimumDistance =
      Math.max(
        context.atr * minimumDistanceAtr,
        Math.max(
          this.config.minimumStopDistanceTicks,
          context.spec.stopsLevelTicks,
          context.spec.freezeLevelTicks,
        ) * tickSize,
      );

    const maximumProtectiveForLong =
      currentPrice - minimumDistance;

    const minimumProtectiveForShort =
      currentPrice + minimumDistance;

    const distanceSafeCandidate = isLong
      ? Math.min(
          candidate,
          maximumProtectiveForLong,
        )
      : Math.max(
          candidate,
          minimumProtectiveForShort,
        );

    // Never give up the +0.50 positive lock merely to force a
    // broker-distance-valid modification. If the market has not
    // moved far enough yet, wait and retry on a later management tick.
    const stillLocksPositive = isLong
      ? distanceSafeCandidate >= positiveCandidate
      : distanceSafeCandidate <= positiveCandidate;

    if (!stillLocksPositive) {
      return null;
    }

    const normalized =
      MarketMath.normalizePrice(
        distanceSafeCandidate,
        tickSize,
        context.spec.digits,
      );

    const remainsProtective = isLong
      ? normalized <=
        currentPrice - minimumDistance + tickSize / 2
      : normalized >=
        currentPrice + minimumDistance - tickSize / 2;

    if (!remainsProtective) {
      return null;
    }

    const improvementTicks = isLong
      ? (
          normalized -
          context.position.stopLoss
        ) / tickSize
      : (
          context.position.stopLoss -
          normalized
        ) / tickSize;

    if (
      improvementTicks <
      this.config.minimumStopImprovementTicks
    ) {
      return null;
    }

    return {
      type: "MODIFY_STOP",
      commandId:
        this.ids.create(
          "modify-stop",
          generatedAt,
        ),
      ticket: context.position.ticket,
      stopLoss: normalized,
      // Preserve the canonical broker TP. This patch changes
      // management behavior, not the execution-order contract.
      takeProfit: context.position.takeProfit,
      reason,
      expiresAt:
        generatedAt +
        this.config.managementCommandTtlMs,
    };
  }

  private createLegacyProtectiveStopCommand(
    context: PositionManagementContext,
    currentPrice: number,
    currentRiskMultiple: number,
    state: PositionManagementState,
    generatedAt: number,
  ): Extract<
    ManagementCommand,
    { type: "MODIFY_STOP" }
  > | null {
    const isLong =
      context.position.side === PositionSide.LONG;

    const tickSize = context.spec.tickSize;

    let candidate: number | null = null;

    let reason:
      | "BREAK_EVEN"
      | "TRAILING_STOP"
      | null = null;

    if (
      !state.breakEvenApplied &&
      currentRiskMultiple >=
        context.plan.management
          .moveStopToBreakEvenAtR
    ) {
      candidate = isLong
        ? context.position.entry +
          this.config.breakEvenOffsetTicks *
            tickSize
        : context.position.entry -
          this.config.breakEvenOffsetTicks *
            tickSize;

      reason = "BREAK_EVEN";
    }

    const trailing =
      context.plan.management.trailingStop;

    if (
      trailing.enabled &&
      currentRiskMultiple >= trailing.startAtR
    ) {
      const trailingCandidate = isLong
        ? currentPrice -
          context.atr * trailing.atrMultiple
        : currentPrice +
          context.atr * trailing.atrMultiple;

      const shouldUseTrailing =
        candidate === null ||
        (
          isLong
            ? trailingCandidate > candidate
            : trailingCandidate < candidate
        );

      if (shouldUseTrailing) {
        candidate = trailingCandidate;
        reason = "TRAILING_STOP";
      }
    }

    if (
      candidate === null ||
      reason === null
    ) {
      return null;
    }

    const normalized =
      MarketMath.normalizePrice(
        candidate,
        tickSize,
        context.spec.digits,
      );

    const improvementTicks = isLong
      ? (
          normalized -
          context.position.stopLoss
        ) / tickSize
      : (
          context.position.stopLoss -
          normalized
        ) / tickSize;

    const remainsProtective = isLong
      ? normalized < currentPrice
      : normalized > currentPrice;

    if (
      improvementTicks <
        this.config.minimumStopImprovementTicks ||
      !remainsProtective
    ) {
      return null;
    }

    return {
      type: "MODIFY_STOP",
      commandId:
        this.ids.create(
          "modify-stop",
          generatedAt,
        ),
      ticket: context.position.ticket,
      stopLoss: normalized,
      takeProfit: context.position.takeProfit,
      reason,
      expiresAt:
        generatedAt +
        this.config.managementCommandTtlMs,
    };
  }
}