import type { Order } from "../entities/Order";
import type { ExecutionResult } from "../models/ExecutionResult";

export interface Broker<TOrder = Order, TResult = ExecutionResult> {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendOrder(order: TOrder): Promise<TResult>;
}
