import type { Position } from "@xauusd/types";
import type {
  BrokerOrderReceipt,
  ExecutionQuote,
  IExecutionAdapter,
  ManagementCommandResult,
  NormalizedExecutionOrder,
  SymbolExecutionSpec,
} from "@xauusd/execution-engine";
import {
  defaultMt5BrokerConfig,
  type Mt5BrokerConfig,
} from "../config";
import type { IMt5BridgeClient } from "../contracts";
import { Mt5BrokerError } from "../errors";
import { Mt5Mapper } from "../mappers";
import { Mt5BrokerConfigValidator } from "../validators";

export class Mt5ExecutionAdapter implements IExecutionAdapter {
  private readonly config: Mt5BrokerConfig;

  constructor(
    private readonly client: IMt5BridgeClient,
    config: Partial<Mt5BrokerConfig> = {},
    private readonly mapper = new Mt5Mapper(),
    validator = new Mt5BrokerConfigValidator(),
  ) {
    this.config = { ...defaultMt5BrokerConfig, ...config };
    validator.validate(this.config);
  }

  async isConnected(): Promise<boolean> {
    try {
      const health = await this.client.health();
      return health.connected &&
        (!this.config.requireTradingEnabled || health.tradingEnabled) &&
        health.terminalTradeAllowed &&
        health.expertTradeAllowed;
    } catch {
      return false;
    }
  }

  async getQuote(symbol: string): Promise<ExecutionQuote> {
    return this.mapper.toQuote(await this.client.quote(symbol));
  }

  async getSymbolSpec(symbol: string): Promise<SymbolExecutionSpec> {
    return this.mapper.toSpec(await this.client.symbolSpec(symbol));
  }

  async placeOrder(order: NormalizedExecutionOrder): Promise<BrokerOrderReceipt> {
    const health = await this.client.health();
    if (!health.connected) {
      throw new Mt5BrokerError("BRIDGE_UNAVAILABLE", health.lastError ?? "MT5 terminal is disconnected.");
    }
    if (this.config.requireTradingEnabled && !health.tradingEnabled) {
      throw new Mt5BrokerError("TRADING_DISABLED", "MT5 bridge trading is disabled.");
    }
    return this.mapper.toReceipt(
      await this.client.placeOrder(this.mapper.toOrderRequest(order, this.config)),
    );
  }

  async cancelOrder(brokerOrderId: string): Promise<boolean> {
    return (await this.client.cancelOrder(brokerOrderId)).success;
  }

  async closePosition(ticket: string, volume: number, commandId: string): Promise<ManagementCommandResult> {
    return this.mapper.toCommandResult(await this.client.closePosition(ticket, volume, commandId));
  }

  async modifyPosition(
    ticket: string,
    stopLoss: number,
    takeProfit: number | undefined,
    commandId: string,
  ): Promise<ManagementCommandResult> {
    return this.mapper.toCommandResult(
      await this.client.modifyPosition(ticket, stopLoss, takeProfit, commandId),
    );
  }

  async getOpenPositions(symbol?: string): Promise<Position[]> {
    return (await this.client.openPositions(symbol)).map((position) => this.mapper.toPosition(position));
  }
}
