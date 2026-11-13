import type { Position } from "@xauusd/types";
import type { ExecutionRecord } from "./ExecutionRecord";

export interface VolumeMismatch {
  ticket: string;
  localVolume: number;
  brokerVolume: number;
}

export interface ReconciliationResult {
  missingAtBroker: ExecutionRecord[];
  missingLocally: Position[];
  volumeMismatches: VolumeMismatch[];
  consistent: boolean;
  generatedAt: number;
}
