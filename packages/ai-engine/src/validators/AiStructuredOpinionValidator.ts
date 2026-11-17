import type {
  AiAction,
  AiStructuredOpinion
} from "../models";

export class AiStructuredOpinionValidator {
  validate(
    value: unknown,
    expectedSchemaVersion: string
  ): AiStructuredOpinion {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value)
    ) {
      throw new TypeError(
        "AI response must be a JSON object."
      );
    }

    const record = value as Record<string, unknown>;
    const actions: AiAction[] = [
      "CONFIRM",
      "DOWNGRADE_TO_WAIT",
      "REJECT"
    ];

    if (
      record.schemaVersion !==
      expectedSchemaVersion
    ) {
      throw new Error(
        "AI response schemaVersion does not match."
      );
    }

    if (
      typeof record.action !== "string" ||
      !actions.includes(record.action as AiAction)
    ) {
      throw new Error(
        "AI response action is invalid."
      );
    }

    for (const field of [
      "confidence",
      "marketQualityScore",
      "executionQualityScore",
      "riskQualityScore"
    ]) {
      const value = record[field];
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > 100
      ) {
        throw new RangeError(
          `${field} must be between 0 and 100.`
        );
      }
    }

    for (const field of [
      "reasons",
      "warnings",
      "invalidationConditions",
      "featureContributions"
    ]) {
      if (!Array.isArray(record[field])) {
        throw new TypeError(
          `${field} must be an array.`
        );
      }
    }

    for (
      const contribution of
      record.featureContributions as unknown[]
    ) {
      if (
        contribution === null ||
        typeof contribution !== "object" ||
        Array.isArray(contribution)
      ) {
        throw new TypeError(
          "featureContributions contains an invalid item."
        );
      }

      const item = contribution as Record<
        string,
        unknown
      >;
      if (
        typeof item.feature !== "string" ||
        typeof item.impact !== "number" ||
        item.impact < -100 ||
        item.impact > 100 ||
        ![
          "SUPPORT",
          "OPPOSE",
          "NEUTRAL"
        ].includes(String(item.direction)) ||
        typeof item.explanation !== "string"
      ) {
        throw new Error(
          "featureContributions contains invalid fields."
        );
      }
    }

    return value as AiStructuredOpinion;
  }
}
