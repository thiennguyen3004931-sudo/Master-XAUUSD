import type { Position } from "@xauusd/types";
import type { ExecutionStatus } from "./ExecutionStatus";

export interface BrokerOrderReceipt {
  accepted: boolean;
  status: ExecutionStatus;
  brokerOrderId?: string;
  ticket?: string;
  position?: Position;
  fillPrice?: number;
  filledVolume?: number;
  message: string;
  brokerTimestamp: number;
}
