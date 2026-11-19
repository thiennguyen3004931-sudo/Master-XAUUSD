import type { Mt5BrokerConfig } from "../config";
import { Mt5BrokerError } from "../errors";

export class Mt5BrokerConfigValidator {
  validate(config: Mt5BrokerConfig): void {
    let url: URL;
    try {
      url = new URL(config.bridgeBaseUrl);
    } catch {
      throw new Mt5BrokerError("CONFIGURATION_ERROR", "bridgeBaseUrl must be a valid URL.");
    }

    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Mt5BrokerError("CONFIGURATION_ERROR", "bridgeBaseUrl must use HTTP or HTTPS.");
    }

    if (!config.apiKey.trim()) {
      throw new Mt5BrokerError("CONFIGURATION_ERROR", "MT5 bridge API key is required.");
    }

    const positive: Array<keyof Mt5BrokerConfig> = [
      "requestTimeoutMs",
      "healthTimeoutMs",
      "retryBaseDelayMs",
      "deviationPoints",
      "magicNumber",
    ];
    for (const field of positive) {
      const value = config[field];
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new Mt5BrokerError("CONFIGURATION_ERROR", `${field} must be a finite positive number.`);
      }
    }

    if (!Number.isInteger(config.retryAttempts) || config.retryAttempts < 0 || config.retryAttempts > 5) {
      throw new Mt5BrokerError("CONFIGURATION_ERROR", "retryAttempts must be an integer between 0 and 5.");
    }
  }
}
