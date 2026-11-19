import type { AiFeatureVector } from "../models";
import {
  SimpleHash,
  StableJson
} from "../utils";

export class CacheKeyService {
  create(
    promptVersion: string,
    schemaVersion: string,
    features: AiFeatureVector
  ): string {
    return [
      "ai-review",
      promptVersion,
      schemaVersion,
      SimpleHash.hash(
        StableJson.stringify(features)
      )
    ].join(":");
  }
}
