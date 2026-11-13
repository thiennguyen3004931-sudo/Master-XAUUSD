import {
  OrderSide,
  PositionSide,
  type Position,
} from "@xauusd/types";
import type { IClock, IExecutionAdapter } from "../contracts";
import type {
  BrokerOrderReceipt,
  ExecutionQuote,
  ManagementCommandResult,
  NormalizedExecutionOrder,
  SymbolExecutionSpec,
} from "../models";
import { IdFactory, SystemClock } from "../utils";

export interface SimulatedExecutionAdapterOptions {
  connected?: boolean;
  rejectOrders?: boolean;
  fillPriceOffset?: number;
}

export class SimulatedExecutionAdapter
  implements IExecutionAdapter
{
  private readonly positions = new Map<string, Position>();
  private readonly completedCommands = new Map<
    string,
    ManagementCommandResult
  >();
  private readonly ids = new IdFactory();
  private connected: boolean;
  private rejectOrders: boolean;
  private fillPriceOffset: number;

  public placeOrderCalls = 0;
  public closePositionCalls = 0;
  public modifyPositionCalls = 0;

  constructor(
    private quote: ExecutionQuote,
    private spec: SymbolExecutionSpec,
    options: SimulatedExecutionAdapterOptions = {},
    private readonly clock: IClock = new SystemClock(),
  ) {
    this.connected = options.connected ?? true;
    this.rejectOrders = options.rejectOrders ?? false;
    this.fillPriceOffset = options.fillPriceOffset ?? 0;
  }

  async isConnected(): Promise<boolean> {
    return this.connected;
  }

  async getQuote(symbol: string): Promise<ExecutionQuote> {
    if (symbol !== this.quote.symbol) {
      throw new Error(`No simulated quote for ${symbol}.`);
    }
    return { ...this.quote };
  }

  async getSymbolSpec(
    symbol: string,
  ): Promise<SymbolExecutionSpec> {
    if (symbol !== this.spec.symbol) {
      throw new Error(
        `No simulated symbol specification for ${symbol}.`,
      );
    }
    return { ...this.spec };
  }

  async placeOrder(
    order: NormalizedExecutionOrder,
  ): Promise<BrokerOrderReceipt> {
    this.placeOrderCalls += 1;
    const timestamp = this.clock.now();

    if (this.rejectOrders) {
      return {
        accepted: false,
        status: "REJECTED",
        message: "Simulated adapter rejected the order.",
        brokerTimestamp: timestamp,
      };
    }

    const baseFill =
      order.side === OrderSide.BUY
        ? this.quote.ask
        : this.quote.bid;
    const fillPrice =
      order.side === OrderSide.BUY
        ? baseFill + this.fillPriceOffset
        : baseFill - this.fillPriceOffset;
    const ticket = this.ids.create("ticket", timestamp);
    const position: Position = {
      ticket,
      symbol: order.symbol,
      side:
        order.side === OrderSide.BUY
          ? PositionSide.LONG
          : PositionSide.SHORT,
      volume: order.volume,
      entry: fillPrice,
      stopLoss: order.stopLoss,
      takeProfit: order.takeProfit,
      profit: 0,
      swap: 0,
      commission: 0,
      openedAt: timestamp,
    };
    this.positions.set(ticket, position);

    return {
      accepted: true,
      status: "FILLED",
      brokerOrderId: this.ids.create("broker-order", timestamp),
      ticket,
      position: { ...position },
      fillPrice,
      filledVolume: order.volume,
      message: "Simulated market order filled.",
      brokerTimestamp: timestamp,
    };
  }

  async cancelOrder(_brokerOrderId: string): Promise<boolean> {
    return true;
  }

  async closePosition(
    ticket: string,
    volume: number,
    commandId: string,
  ): Promise<ManagementCommandResult> {
    const duplicate = this.completedCommands.get(commandId);
    if (duplicate) return { ...duplicate };

    this.closePositionCalls += 1;
    const timestamp = this.clock.now();
    const position = this.positions.get(ticket);

    if (!position) {
      const result = {
        commandId,
        success: false,
        message: `Position ${ticket} was not found.`,
        executedAt: timestamp,
      };
      this.completedCommands.set(commandId, result);
      return result;
    }

    if (!Number.isFinite(volume) || volume <= 0) {
      const result = {
        commandId,
        success: false,
        message: "Close volume must be positive.",
        executedAt: timestamp,
      };
      this.completedCommands.set(commandId, result);
      return result;
    }

    if (volume >= position.volume - 1e-8) {
      this.positions.delete(ticket);
    } else {
      this.positions.set(ticket, {
        ...position,
        volume: position.volume - volume,
      });
    }

    const result = {
      commandId,
      success: true,
      message: `Closed ${volume} lots from ${ticket}.`,
      executedAt: timestamp,
    };
    this.completedCommands.set(commandId, result);
    return result;
  }

  async modifyPosition(
    ticket: string,
    stopLoss: number,
    takeProfit: number | undefined,
    commandId: string,
  ): Promise<ManagementCommandResult> {
    const duplicate = this.completedCommands.get(commandId);
    if (duplicate) return { ...duplicate };

    this.modifyPositionCalls += 1;
    const timestamp = this.clock.now();
    const position = this.positions.get(ticket);

    if (!position) {
      const result = {
        commandId,
        success: false,
        message: `Position ${ticket} was not found.`,
        executedAt: timestamp,
      };
      this.completedCommands.set(commandId, result);
      return result;
    }

    this.positions.set(ticket, {
      ...position,
      stopLoss,
      takeProfit: takeProfit ?? position.takeProfit,
    });

    const result = {
      commandId,
      success: true,
      message: `Modified protection for ${ticket}.`,
      executedAt: timestamp,
    };
    this.completedCommands.set(commandId, result);
    return result;
  }

  async getOpenPositions(symbol?: string): Promise<Position[]> {
    return [...this.positions.values()]
      .filter((position) =>
        symbol ? position.symbol === symbol : true,
      )
      .map((position) => ({ ...position }));
  }

  setQuote(quote: ExecutionQuote): void {
    this.quote = { ...quote };
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
  }

  setRejectOrders(rejectOrders: boolean): void {
    this.rejectOrders = rejectOrders;
  }

  setFillPriceOffset(offset: number): void {
    this.fillPriceOffset = offset;
  }
}
