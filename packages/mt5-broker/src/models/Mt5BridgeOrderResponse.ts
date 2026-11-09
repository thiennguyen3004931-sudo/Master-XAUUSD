import type { Mt5BridgePosition } from "./Mt5BridgePosition";

export interface Mt5BridgeOrderResponse {
  accepted: boolean;
  status:
    | "REJECTED"
    | "SUBMITTING"
    | "FILLED"
    | "PARTIALLY_FILLED"
    | "CANCELLED"
    | "FAILED";
  brokerOrderId?: string;
  ticket?: string;
  position?: Mt5BridgePosition;
  fillPrice?: number;
  filledVolume?: number;
  message: string;
  retcode?: number;
  brokerTimestamp: number;
  idempotentReplay: boolean;
}
