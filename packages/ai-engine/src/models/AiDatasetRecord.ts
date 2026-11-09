import type { AiAction } from "./AiAction";
import type { AiFeatureVector } from "./AiFeatureVector";

export interface AiDatasetLabel {
  realizedRMultiple: number;
  realizedNetPnl: number;
  profitable: boolean;
  exitReason: string;
}

export interface AiDatasetRecord {
  recordId: string;
  features: AiFeatureVector;
  aiAction?: AiAction;
  label?: AiDatasetLabel;
  createdAt: number;
}
