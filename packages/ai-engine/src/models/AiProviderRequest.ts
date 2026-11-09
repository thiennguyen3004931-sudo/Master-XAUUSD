import type { AiFeatureVector } from "./AiFeatureVector";
import type { PromptMessage } from "./PromptMessage";

export interface AiProviderRequest {
  requestId: string;
  promptVersion: string;
  schemaVersion: string;
  messages: PromptMessage[];
  features: AiFeatureVector;
  metadata: Readonly<Record<string, string | number | boolean>>;
  createdAt: number;
}
