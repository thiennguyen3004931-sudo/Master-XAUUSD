import type { Order } from "../entities/Order";
import type { Position } from "../entities/Position";

export interface ExecutionProvider<TOrder = Order, TPosition = Position> {
  open(order: TOrder): Promise<TPosition>;
  close(ticket: string): Promise<boolean>;
}
