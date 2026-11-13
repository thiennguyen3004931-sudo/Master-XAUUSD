import type { AiContext, AiFeatureVector } from "../models";

export interface IAiFeatureExtractor {
  extract(context: AiContext): AiFeatureVector;
}
