import type { IAiResponseParser } from "../contracts";
import type {
  AiOpinion,
  AiProviderResponse
} from "../models";
import type { AiEngineConfig } from "../config";
import {
  AiStructuredOpinionValidator
} from "../validators";
import { TextSanitizer } from "../utils";

export class AiResponseParser
  implements IAiResponseParser
{
  constructor(
    private readonly config: AiEngineConfig,
    private readonly validator =
      new AiStructuredOpinionValidator(),
    private readonly sanitizer =
      new TextSanitizer()
  ) {}

  parse(response: AiProviderResponse): AiOpinion {
    let parsed: unknown;

    try {
      parsed = JSON.parse(response.content);
    } catch {
      throw new Error(
        `Provider ${response.providerId} returned invalid JSON.`
      );
    }

    const validated = this.validator.validate(
      parsed,
      this.config.schemaVersion
    );

    return {
      ...validated,
      reasons: this.sanitizer.sanitizeMany(
        validated.reasons,
        this.config.maximumReasons,
        this.config.maximumTextLength
      ),
      warnings: this.sanitizer.sanitizeMany(
        validated.warnings,
        this.config.maximumWarnings,
        this.config.maximumTextLength
      ),
      invalidationConditions:
        this.sanitizer.sanitizeMany(
          validated.invalidationConditions,
          this.config.maximumReasons,
          this.config.maximumTextLength
        ),
      featureContributions:
        validated.featureContributions
          .slice(0, this.config.maximumReasons)
          .map((item) => ({
            ...item,
            feature: this.sanitizer.sanitize(
              item.feature,
              100
            ),
            explanation:
              this.sanitizer.sanitize(
                item.explanation,
                this.config.maximumTextLength
              )
          })),
      providerId: response.providerId,
      providerKind: response.providerKind,
      model: response.model,
      requestId: response.requestId,
      usage: response.usage,
      latencyMs: response.latencyMs,
      receivedAt: response.createdAt
    };
  }
}
