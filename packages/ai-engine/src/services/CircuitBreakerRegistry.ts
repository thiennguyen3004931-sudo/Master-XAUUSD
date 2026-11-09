import type { AiEngineConfig } from "../config";
import type {
  AiProviderHealth
} from "../models";

export class CircuitBreakerRegistry {
  private readonly health =
    new Map<string, AiProviderHealth>();

  constructor(
    private readonly config: AiEngineConfig
  ) {}

  canCall(
    providerId: string,
    now: number
  ): boolean {
    const health = this.get(providerId);

    if (health.state !== "OPEN") {
      return true;
    }

    if (
      health.openedAt !== undefined &&
      now - health.openedAt >=
        this.config.circuitBreakerResetMs
    ) {
      this.health.set(providerId, {
        ...health,
        state: "HALF_OPEN"
      });
      return true;
    }

    return false;
  }

  recordSuccess(
    providerId: string,
    now: number
  ): void {
    this.health.set(providerId, {
      providerId,
      state: "CLOSED",
      consecutiveFailures: 0,
      lastSuccessAt: now
    });
  }

  recordFailure(
    providerId: string,
    now: number
  ): void {
    const current = this.get(providerId);
    const consecutiveFailures =
      current.consecutiveFailures + 1;
    const shouldOpen =
      consecutiveFailures >=
      this.config.circuitBreakerFailureThreshold;

    this.health.set(providerId, {
      providerId,
      state: shouldOpen
        ? "OPEN"
        : current.state,
      consecutiveFailures,
      openedAt: shouldOpen ? now : current.openedAt,
      lastFailureAt: now
    });
  }

  get(providerId: string): AiProviderHealth {
    return (
      this.health.get(providerId) ?? {
        providerId,
        state: "CLOSED",
        consecutiveFailures: 0
      }
    );
  }

  list(): AiProviderHealth[] {
    return [...this.health.values()].map(
      (item) => ({ ...item })
    );
  }
}
