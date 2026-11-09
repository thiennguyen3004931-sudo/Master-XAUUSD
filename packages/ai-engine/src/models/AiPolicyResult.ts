import type { Order } from "@xauusd/types";
import type { AiAction } from "./AiAction";

export interface AiPolicyResult {
  action: AiAction;
  executable: boolean;
  order: Order | null;
  originalStrategyConfidence: number;
  adjustedConfidence: number;
  policyReasons: string[];
  policyWarnings: string[];
}
