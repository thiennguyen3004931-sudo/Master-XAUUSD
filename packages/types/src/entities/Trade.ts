import type { Order } from "./Order";
import type { Position } from "./Position";

export interface Trade {
  order: Order;
  position?: Position;
  createdAt: number;
}
