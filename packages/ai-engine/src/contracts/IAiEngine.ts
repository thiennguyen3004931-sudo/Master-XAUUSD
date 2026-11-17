import type { AiContext, AiDecision } from "../models";

export interface IAiEngine {
  review(context: AiContext): Promise<AiDecision>;
}
