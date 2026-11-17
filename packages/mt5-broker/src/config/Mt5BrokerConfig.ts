export interface Mt5BrokerConfig {
  bridgeBaseUrl: string;
  apiKey: string;
  requestTimeoutMs: number;
  healthTimeoutMs: number;
  retryAttempts: number;
  retryBaseDelayMs: number;
  deviationPoints: number;
  magicNumber: number;
  requireTradingEnabled: boolean;
}
