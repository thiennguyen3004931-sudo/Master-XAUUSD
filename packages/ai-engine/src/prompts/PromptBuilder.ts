import type { AiEngineConfig } from "../config";
import type {
  AiFeatureVector,
  PromptMessage,
  PromptTemplate
} from "../models";
import { StableJson } from "../utils";

export class PromptBuilder {
  build(
    template: PromptTemplate,
    features: AiFeatureVector,
    config: AiEngineConfig
  ): PromptMessage[] {
    const responseContract = {
      schemaVersion: config.schemaVersion,
      action:
        "CONFIRM | DOWNGRADE_TO_WAIT | REJECT",
      confidence: "number 0..100",
      marketQualityScore: "number 0..100",
      executionQualityScore: "number 0..100",
      riskQualityScore: "number 0..100",
      reasons: ["string"],
      warnings: ["string"],
      invalidationConditions: ["string"],
      featureContributions: [
        {
          feature: "string",
          impact: "number -100..100",
          direction:
            "SUPPORT | OPPOSE | NEUTRAL",
          explanation: "string"
        }
      ]
    };

    return [
      {
        role: "system",
        content: `${template.system} Prompt version: ${config.promptVersion}.`
      },
      {
        role: "user",
        content: [
          template.user,
          `Response contract: ${StableJson.stringify(responseContract)}`,
          `Feature vector: ${StableJson.stringify(features)}`
        ].join("\n")
      }
    ];
  }
}
