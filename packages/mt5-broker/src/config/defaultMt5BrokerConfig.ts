import type { Mt5BrokerConfig } from "./Mt5BrokerConfig";

export const defaultMt5BrokerConfig: Mt5BrokerConfig = {
  bridgeBaseUrl: "http://127.0.0.1:8765",
  apiKey: "",
  requestTimeoutMs: 10_000,
  healthTimeoutMs: 2_000,
  retryAttempts: 2,
  retryBaseDelayMs: 250,
  deviationPoints: 50,
  magicNumber: 260806,
  requireTradingEnabled: true,
};
