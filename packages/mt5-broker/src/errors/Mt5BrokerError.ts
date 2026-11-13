export type Mt5BrokerErrorCode =
  | "CONFIGURATION_ERROR"
  | "TRANSPORT_ERROR"
  | "AUTHENTICATION_ERROR"
  | "BRIDGE_UNAVAILABLE"
  | "TRADING_DISABLED"
  | "BRIDGE_REJECTED"
  | "INVALID_RESPONSE";

export class Mt5BrokerError extends Error {
  constructor(
    public readonly code: Mt5BrokerErrorCode,
    message: string,
    public readonly status?: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "Mt5BrokerError";
  }
}
