import type { Position } from "@xauusd/types";
import type {
  BrokerOrderReceipt,
  ExecutionQuote,
  ManagementCommandResult,
  NormalizedExecutionOrder,
  SymbolExecutionSpec,
} from "../models";

export interface IExecutionAdapter {
  isConnected(): Promise<boolean>;
  getQuote(symbol: string): Promise<ExecutionQuote>;
  getSymbolSpec(symbol: string): Promise<SymbolExecutionSpec>;
  placeOrder(order: NormalizedExecutionOrder): Promise<BrokerOrderReceipt>;
  cancelOrder(brokerOrderId: string): Promise<boolean>;
  closePosition(
    ticket: string,
    volume: number,
    commandId: string,
  ): Promise<ManagementCommandResult>;
  modifyPosition(
    ticket: string,
    stopLoss: number,
    takeProfit: number | undefined,
    commandId: string,
  ): Promise<ManagementCommandResult>;
  getOpenPositions(symbol?: string): Promise<Position[]>;
}
