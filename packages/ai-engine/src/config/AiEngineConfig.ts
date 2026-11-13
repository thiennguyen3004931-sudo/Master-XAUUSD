export interface AiEngineConfig {
  promptVersion: string;
  schemaVersion: string;
  providerTimeoutMs: number;
  providerMaxRetries: number;
  minimumProviderCount: number;
  minimumAgreementRatio: number;
  minimumOpinionConfidence: number;
  maximumConfidenceAdjustment: number;
  contextMaxAgeMs: number;
  cacheTtlMs: number;
  circuitBreakerFailureThreshold: number;
  circuitBreakerResetMs: number;
  maximumReasons: number;
  maximumWarnings: number;
  maximumTextLength: number;
  failClosed: boolean;
  allowExternalProviders: boolean;
  auditEnabled: boolean;
}
