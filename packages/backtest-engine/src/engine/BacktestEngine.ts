import type { Candle } from "@xauusd/market-data";
import type { StrategyPlan } from "@xauusd/strategy-engine";
import { OrderSide } from "@xauusd/types";
import type {
  IBacktestEngine,
  ICommissionModel,
  ISlippageModel,
} from "../contracts";
import {
  defaultBacktestConfig,
  type BacktestConfig,
} from "../config";
import {
  FixedCommissionPerLotModel,
  FixedTickSlippageModel,
  ZeroCommissionModel,
  ZeroSlippageModel,
} from "../costs";
import type {
  BacktestDiagnostics,
  BacktestPosition,
  BacktestRequest,
  BacktestResult,
  BacktestTrade,
  IntrabarEvent,
  PartialExit,
  PendingBacktestOrder,
  TradeExitReason,
} from "../models";
import {
  AtrService,
  DrawdownService,
  EquityCurveService,
  ExecutionPriceService,
  IntrabarPathService,
  MetricsService,
  MonthlyReturnService,
} from "../services";
import {
  BacktestConfigValidator,
  CandleSeriesValidator,
  StrategyPlanValidator,
} from "../validators";
import {
  IdFactory,
  NumberUtils,
  TradeMath,
} from "../utils";

interface MutableState {
  balance: number;
  pendingOrder: PendingBacktestOrder | null;
  positions: BacktestPosition[];
  trades: BacktestTrade[];
}

export interface BacktestEngineOptions {
  commissionModel?: ICommissionModel;
  slippageModel?: ISlippageModel;
}

export class BacktestEngine implements IBacktestEngine {
  private readonly ids = new IdFactory();
  private readonly candleValidator =
    new CandleSeriesValidator();
  private readonly configValidator =
    new BacktestConfigValidator();
  private readonly planValidator =
    new StrategyPlanValidator();
  private readonly atrService = new AtrService();
  private readonly equityService =
    new EquityCurveService();
  private readonly drawdownService =
    new DrawdownService();
  private readonly metricsService =
    new MetricsService();
  private readonly monthlyReturnService =
    new MonthlyReturnService();
  private readonly intrabarPathService =
    new IntrabarPathService();
  private readonly commissionModel: ICommissionModel;
  private readonly slippageModel: ISlippageModel;

  constructor(options: BacktestEngineOptions = {}) {
    this.commissionModel =
      options.commissionModel ??
      new ZeroCommissionModel();
    this.slippageModel =
      options.slippageModel ??
      new ZeroSlippageModel();
  }

  static withFixedCosts(
    commissionPerLotPerSide: number,
    slippageTicks: number,
  ): BacktestEngine {
    return new BacktestEngine({
      commissionModel:
        new FixedCommissionPerLotModel(
          commissionPerLotPerSide,
        ),
      slippageModel:
        new FixedTickSlippageModel(slippageTicks),
    });
  }

  async run(
    request: BacktestRequest,
  ): Promise<BacktestResult> {
    this.candleValidator.validate(request.candles);
    const config: BacktestConfig = {
      ...defaultBacktestConfig,
      ...request.config,
    };
    this.configValidator.validate(config);

    const candles = request.candles;
    const startedAt = Date.now();
    const runId =
      request.runId ??
      this.ids.create("backtest", startedAt);
    const executionPriceService =
      new ExecutionPriceService(
        this.commissionModel,
        this.slippageModel,
      );
    const state: MutableState = {
      balance: config.initialBalance,
      pendingOrder: null,
      positions: [],
      trades: [],
    };
    const equityCurve = [];
    const diagnostics: BacktestDiagnostics = {
      warnings: [],
      candlesProcessed: 0,
      strategyEvaluations: 0,
      executablePlans: 0,
      entriesFilled: 0,
      pendingOrdersExpired: 0,
      plansSkippedByCapacity: 0,
      invalidStrategyPlans: 0,
    };

    for (
      let index = 0;
      index < candles.length;
      index += 1
    ) {
      const candle = candles[index]!;
      diagnostics.candlesProcessed += 1;

      if (state.pendingOrder) {
        this.tryFillPendingOrder(
          state,
          candle,
          index,
          config,
          executionPriceService,
          diagnostics,
        );
      }

      const positionsAtBarOpen = new Set(
        state.positions.map((position) => position.id),
      );
      for (const position of [...state.positions]) {
        const canExit =
          config.allowSameBarExit ||
          positionsAtBarOpen.has(position.id) &&
            position.entryBarIndex < index;
        if (!canExit) continue;

        this.processPosition(
          state,
          position,
          candle,
          index,
          candles,
          config,
          executionPriceService,
        );
      }

      equityCurve.push(
        this.equityService.createPoint(
          candle,
          state.balance,
          state.positions,
          config,
        ),
      );

      if (
        index >= config.warmupBars &&
        (index - config.warmupBars) %
          config.evaluateEveryBars ===
          0
      ) {
        diagnostics.strategyEvaluations += 1;
        const currentEquity =
          equityCurve[equityCurve.length - 1]!.equity;
        const evaluation =
          await request.strategyEvaluator.evaluate({
            candles: candles.slice(0, index + 1),
            currentIndex: index,
            currentCandle: candle,
            balance: state.balance,
            equity: currentEquity,
            openPositions:
              this.equityService.snapshots(
                state.positions,
                candle.close,
                config,
              ),
            closedTrades: [...state.trades],
          });

        if (
          evaluation.action === "EXECUTE" &&
          evaluation.plan
        ) {
          diagnostics.executablePlans += 1;
          if (
            !this.planValidator.isValid(
              evaluation.plan,
              candle.symbol,
            )
          ) {
            diagnostics.invalidStrategyPlans += 1;
          } else if (
            state.positions.length >=
              config.maxConcurrentPositions ||
            state.pendingOrder !== null
          ) {
            diagnostics.plansSkippedByCapacity += 1;
          } else {
            state.pendingOrder = {
              id: this.ids.create(
                "pending",
                candle.closeTime,
              ),
              plan: evaluation.plan,
              createdBarIndex: index,
              createdAt: candle.closeTime,
              expiresAt: evaluation.plan.expiresAt,
            };
          }
        }
      }
    }

    if (config.forceCloseAtEnd) {
      const finalCandle = candles[candles.length - 1]!;
      for (const position of [...state.positions]) {
        this.closePosition(
          state,
          position,
          finalCandle.close,
          position.remainingVolume,
          finalCandle,
          config,
          executionPriceService,
          "END_OF_DATA",
          "END",
        );
      }
      if (equityCurve.length > 0) {
        equityCurve[equityCurve.length - 1] =
          this.equityService.createPoint(
            finalCandle,
            state.balance,
            state.positions,
            config,
          );
      }
    }

    const drawdownCurve =
      this.drawdownService.calculate(equityCurve);
    const monthlyReturns =
      this.monthlyReturnService.calculate(equityCurve);
    const metrics = this.metricsService.calculate(
      state.trades,
      equityCurve,
      drawdownCurve,
      config,
      candles[0]!.openTime,
      candles[candles.length - 1]!.closeTime,
    );

    if (state.pendingOrder) {
      diagnostics.warnings.push(
        "A pending order remained unfilled at the end of data.",
      );
    }

    return {
      runId,
      status: "COMPLETED",
      symbol: candles[0]!.symbol,
      timeframe: String(candles[0]!.timeframe),
      startedAt,
      completedAt: Date.now(),
      dataStartTime: candles[0]!.openTime,
      dataEndTime: candles[candles.length - 1]!.closeTime,
      config,
      trades: state.trades,
      equityCurve,
      drawdownCurve,
      monthlyReturns,
      metrics,
      diagnostics,
    };
  }

  private tryFillPendingOrder(
    state: MutableState,
    candle: Candle,
    index: number,
    config: BacktestConfig,
    executionPriceService: ExecutionPriceService,
    diagnostics: BacktestDiagnostics,
  ): void {
    const pending = state.pendingOrder;
    if (!pending) return;

    if (
      candle.openTime > pending.expiresAt ||
      index <= pending.createdBarIndex
    ) {
      if (candle.openTime > pending.expiresAt) {
        state.pendingOrder = null;
        diagnostics.pendingOrdersExpired += 1;
      }
      return;
    }

    const plannedEntry = pending.plan.order.entry;
    const touched =
      candle.low <= plannedEntry &&
      candle.high >= plannedEntry;

    if (
      config.entryFillMode === "PLANNED_PRICE_TOUCH" &&
      !touched
    ) {
      if (candle.closeTime >= pending.expiresAt) {
        state.pendingOrder = null;
        diagnostics.pendingOrdersExpired += 1;
      }
      return;
    }

    const referencePrice =
      config.entryFillMode === "NEXT_BAR_OPEN"
        ? candle.open
        : plannedEntry;
    const spread =
      candle.spread ?? config.fallbackSpread;
    const fill = executionPriceService.createFill(
      pending.plan.order.symbol,
      pending.plan.order.side,
      "ENTRY",
      referencePrice,
      pending.plan.order.volume,
      spread,
      config.tickSize,
      config.contractSize,
      candle.openTime,
      config.priceDigits,
    );

    state.balance -= fill.commission;
    state.positions.push({
      id: this.ids.create(
        "position",
        candle.openTime,
      ),
      symbol: pending.plan.order.symbol,
      side: pending.plan.order.side,
      strategyId:
        pending.plan.selectedStrategy.strategyId,
      plan: pending.plan,
      entryBarIndex: index,
      entryTime: candle.openTime,
      entryPrice: fill.fillPrice,
      initialVolume: pending.plan.order.volume,
      remainingVolume: pending.plan.order.volume,
      initialStopLoss: pending.plan.order.stopLoss,
      stopLoss: pending.plan.order.stopLoss,
      takeProfit: pending.plan.order.takeProfit,
      initialRiskDistance: Math.abs(
        fill.fillPrice - pending.plan.order.stopLoss,
      ),
      entryCommission: fill.commission,
      realizedGrossPnl: 0,
      exitCommission: 0,
      partialExits: [],
      completedTargetLabels: [],
      breakEvenApplied: false,
      highestPrice: candle.high,
      lowestPrice: candle.low,
    });
    state.pendingOrder = null;
    diagnostics.entriesFilled += 1;
  }

  private processPosition(
    state: MutableState,
    position: BacktestPosition,
    candle: Candle,
    index: number,
    candles: readonly Candle[],
    config: BacktestConfig,
    executionPriceService: ExecutionPriceService,
  ): void {
    position.highestPrice = Math.max(
      position.highestPrice,
      candle.high,
    );
    position.lowestPrice = Math.min(
      position.lowestPrice,
      candle.low,
    );

    const events = this.createIntrabarEvents(position);
    const ordered =
      this.intrabarPathService.orderEvents(
        candle,
        position,
        events,
        config.intrabarPriority,
      );

    for (const event of ordered) {
      if (!state.positions.includes(position)) return;

      if (
        event.type === "STOP" ||
        event.type === "HARD_INVALIDATION"
      ) {
        const referencePrice =
          this.intrabarPathService.resolveReferencePrice(
            candle,
            position,
            event,
          );
        this.closePosition(
          state,
          position,
          referencePrice,
          position.remainingVolume,
          candle,
          config,
          executionPriceService,
          event.reason,
          event.label ?? event.type,
        );
        return;
      }

      const isFinal =
        event.label === "FINAL" ||
        event.closePercent === undefined;
      const requestedVolume = isFinal
        ? position.remainingVolume
        : TradeMath.floorVolume(
            position.initialVolume *
              ((event.closePercent ?? 0) / 100),
            config.volumeStep,
          );
      const volume = Math.min(
        requestedVolume,
        position.remainingVolume,
      );

      if (volume < config.minVolume) continue;

      const referencePrice =
        this.intrabarPathService.resolveReferencePrice(
          candle,
          position,
          event,
        );
      this.closePosition(
        state,
        position,
        referencePrice,
        volume,
        candle,
        config,
        executionPriceService,
        isFinal ? "TAKE_PROFIT" : "PARTIAL_TARGET",
        event.label ?? "TARGET",
      );

      if (!state.positions.includes(position)) return;
    }

    if (!state.positions.includes(position)) return;

    if (
      candle.closeTime >=
      position.plan.management.timeStopAt
    ) {
      this.closePosition(
        state,
        position,
        candle.close,
        position.remainingVolume,
        candle,
        config,
        executionPriceService,
        "TIME_STOP",
        "TIME_STOP",
      );
      return;
    }

    this.updateProtectiveStop(
      position,
      candle,
      index,
      candles,
      config,
    );
  }

  private createIntrabarEvents(
    position: BacktestPosition,
  ): IntrabarEvent[] {
    const events: IntrabarEvent[] = [
      {
        id: `${position.id}:stop`,
        type: "STOP",
        price: position.stopLoss,
        reason: "STOP_LOSS",
      },
      {
        id: `${position.id}:invalidation`,
        type: "HARD_INVALIDATION",
        price:
          position.plan.management.hardInvalidationPrice,
        reason: "HARD_INVALIDATION",
      },
    ];

    const remainingTargets =
      position.plan.management.partialTargets.filter(
        (target) =>
          !position.completedTargetLabels.includes(
            target.label,
          ),
      );

    for (const target of remainingTargets) {
      events.push({
        id: `${position.id}:${target.label}`,
        type: "TARGET",
        price: target.price,
        label: target.label,
        closePercent: target.closePercent,
        reason: "PARTIAL_TARGET",
      });
    }

    const targetPercent = position.plan.management
      .partialTargets.reduce(
        (sum, target) => sum + target.closePercent,
        0,
      );
    if (
      position.plan.management.partialTargets.length === 0 ||
      targetPercent < 99.999
    ) {
      events.push({
        id: `${position.id}:final`,
        type: "TARGET",
        price: position.takeProfit,
        label: "FINAL",
        reason: "TAKE_PROFIT",
      });
    }

    return events;
  }

  private closePosition(
    state: MutableState,
    position: BacktestPosition,
    referencePrice: number,
    volume: number,
    candle: Candle,
    config: BacktestConfig,
    executionPriceService: ExecutionPriceService,
    reason: TradeExitReason,
    label: string,
  ): void {
    const exitVolume = Math.min(
      volume,
      position.remainingVolume,
    );
    if (exitVolume <= 0) return;

    const spread =
      candle.spread ?? config.fallbackSpread;
    const transactionSide =
      TradeMath.oppositeSide(position.side);
    const fill = executionPriceService.createFill(
      position.symbol,
      transactionSide,
      reason === "PARTIAL_TARGET"
        ? "PARTIAL_EXIT"
        : "EXIT",
      referencePrice,
      exitVolume,
      spread,
      config.tickSize,
      config.contractSize,
      candle.closeTime,
      config.priceDigits,
    );
    const grossPnl = TradeMath.grossPnl(
      position.side,
      position.entryPrice,
      fill.fillPrice,
      exitVolume,
      config.contractSize,
    );

    state.balance += grossPnl - fill.commission;
    position.realizedGrossPnl += grossPnl;
    position.exitCommission += fill.commission;
    position.remainingVolume = NumberUtils.round(
      position.remainingVolume - exitVolume,
    );

    const partial: PartialExit = {
      label,
      timestamp: candle.closeTime,
      price: fill.fillPrice,
      volume: exitVolume,
      grossPnl,
      commission: fill.commission,
      reason,
    };
    position.partialExits.push(partial);
    if (reason === "PARTIAL_TARGET") {
      position.completedTargetLabels.push(label);
    }

    if (
      position.remainingVolume >= config.minVolume
    ) {
      return;
    }

    const totalVolume = position.partialExits.reduce(
      (sum, exit) => sum + exit.volume,
      0,
    );
    const averageExitPrice =
      totalVolume > 0
        ? position.partialExits.reduce(
            (sum, exit) =>
              sum + exit.price * exit.volume,
            0,
          ) / totalVolume
        : fill.fillPrice;
    const commission =
      position.entryCommission + position.exitCommission;
    const netPnl =
      position.realizedGrossPnl - commission;
    const initialRiskAmount =
      position.initialRiskDistance *
      position.initialVolume *
      config.contractSize;
    const trade: BacktestTrade = {
      id: this.ids.create(
        "trade",
        candle.closeTime,
      ),
      symbol: position.symbol,
      side: position.side,
      strategyId: position.strategyId,
      entryTime: position.entryTime,
      exitTime: candle.closeTime,
      entryPrice: position.entryPrice,
      averageExitPrice:
        NumberUtils.round(averageExitPrice),
      initialVolume: position.initialVolume,
      grossPnl:
        NumberUtils.round(position.realizedGrossPnl),
      commission: NumberUtils.round(commission),
      netPnl: NumberUtils.round(netPnl),
      rMultiple:
        initialRiskAmount > 0
          ? NumberUtils.round(
              netPnl / initialRiskAmount,
            )
          : 0,
      durationMinutes: NumberUtils.round(
        (candle.closeTime - position.entryTime) /
          60_000,
      ),
      exitReason: reason,
      partialExits: [...position.partialExits],
    };
    state.trades.push(trade);
    state.positions = state.positions.filter(
      (item) => item.id !== position.id,
    );
  }

  private updateProtectiveStop(
    position: BacktestPosition,
    candle: Candle,
    index: number,
    candles: readonly Candle[],
    config: BacktestConfig,
  ): void {
    const currentR = TradeMath.riskMultiple(
      position.side,
      position.entryPrice,
      position.initialStopLoss,
      candle.close,
    );
    const isBuy = position.side === OrderSide.BUY;
    let candidate = position.stopLoss;

    if (
      !position.breakEvenApplied &&
      currentR >=
        position.plan.management.moveStopToBreakEvenAtR
    ) {
      const breakEven = isBuy
        ? position.entryPrice +
          config.breakEvenOffsetTicks * config.tickSize
        : position.entryPrice -
          config.breakEvenOffsetTicks * config.tickSize;
      candidate = isBuy
        ? Math.max(candidate, breakEven)
        : Math.min(candidate, breakEven);
      position.breakEvenApplied = true;
    }

    const trailing =
      position.plan.management.trailingStop;
    if (trailing.enabled && currentR >= trailing.startAtR) {
      const atr = this.atrService.calculate(
        candles,
        index,
        config.trailingAtrPeriod,
      );
      if (atr > 0) {
        const trailingCandidate = isBuy
          ? candle.close - atr * trailing.atrMultiple
          : candle.close + atr * trailing.atrMultiple;
        candidate = isBuy
          ? Math.max(candidate, trailingCandidate)
          : Math.min(candidate, trailingCandidate);
      }
    }

    const normalized = NumberUtils.round(
      Math.round(candidate / config.tickSize) *
        config.tickSize,
      config.priceDigits,
    );
    const remainsProtective = isBuy
      ? normalized < candle.close
      : normalized > candle.close;
    if (remainsProtective) {
      position.stopLoss = normalized;
    }
  }
}
