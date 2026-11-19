import type { AiEngineConfig } from "./AiEngineConfig";

export const defaultAiEngineConfig: AiEngineConfig = {
  promptVersion: "xauusd-ai-review-v1",
  schemaVersion: "1.0.0",
  providerTimeoutMs: 8_000,
  providerMaxRetries: 1,
  minimumProviderCount: 1,
  minimumAgreementRatio: 0.67,
  minimumOpinionConfidence: 70,
  maximumConfidenceAdjustment: 15,
  contextMaxAgeMs: 60_000,
  cacheTtlMs: 30_000,
  circuitBreakerFailureThreshold: 3,
  circuitBreakerResetMs: 60_000,
  maximumReasons: 8,
  maximumWarnings: 8,
  maximumTextLength: 500,
  failClosed: true,
  allowExternalProviders: false,
  auditEnabled: true
};
