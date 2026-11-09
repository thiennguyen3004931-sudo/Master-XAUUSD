import type { Mt5BrokerConfig } from "../config";
import type { IMt5Transport, Mt5TransportRequest } from "../contracts";
import { Mt5BrokerError } from "../errors";
import type { Mt5BridgeErrorPayload } from "../models";

export class HttpMt5Transport implements IMt5Transport {
  constructor(private readonly config: Mt5BrokerConfig) {}

  async request<T>(request: Mt5TransportRequest): Promise<T> {
    const attempts = request.idempotent === false ? 1 : this.config.retryAttempts + 1;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        request.timeoutMs ?? this.config.requestTimeoutMs,
      );

      try {
        const response = await fetch(new URL(request.path, this.normalizedBaseUrl()), {
          method: request.method,
          headers: {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "X-MT5-API-Key": this.config.apiKey,
          },
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
          signal: controller.signal,
        });

        const payload = await this.readPayload(response);
        if (!response.ok) {
          throw this.httpError(response.status, payload);
        }
        return payload as T;
      } catch (error) {
        lastError = error;
        if (error instanceof Mt5BrokerError && !this.isRetryable(error)) {
          throw error;
        }
        if (attempt + 1 < attempts) {
          await this.sleep(this.config.retryBaseDelayMs * 2 ** attempt);
        }
      } finally {
        clearTimeout(timeout);
      }
    }

    if (lastError instanceof Mt5BrokerError) throw lastError;
    throw new Mt5BrokerError(
      "TRANSPORT_ERROR",
      lastError instanceof Error ? lastError.message : "MT5 bridge request failed.",
      undefined,
      lastError,
    );
  }

  private normalizedBaseUrl(): string {
    return this.config.bridgeBaseUrl.endsWith("/")
      ? this.config.bridgeBaseUrl
      : `${this.config.bridgeBaseUrl}/`;
  }

  private async readPayload(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Mt5BrokerError("INVALID_RESPONSE", "MT5 bridge returned non-JSON data.", response.status, text);
    }
  }

  private httpError(status: number, payload: unknown): Mt5BrokerError {
    const body = payload as Mt5BridgeErrorPayload;
    const detail = typeof body.detail === "string"
      ? body.detail
      : body.detail?.message;
    const message = detail ?? body.message ?? `MT5 bridge returned HTTP ${status}.`;
    const code = status === 401 || status === 403
      ? "AUTHENTICATION_ERROR"
      : status === 503
        ? "BRIDGE_UNAVAILABLE"
        : status === 423
          ? "TRADING_DISABLED"
          : "BRIDGE_REJECTED";
    return new Mt5BrokerError(code, message, status, payload);
  }

  private isRetryable(error: Mt5BrokerError): boolean {
    return error.status === undefined ||
      error.status >= 500 ||
      [408, 409, 425, 429].includes(error.status);
  }

  private sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
