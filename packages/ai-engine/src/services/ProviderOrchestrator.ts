import type {
  IAiProvider,
  IAiResponseParser,
  IClock
} from "../contracts";
import type { AiEngineConfig } from "../config";
import type {
  AiOpinion,
  AiProviderFailure,
  AiProviderRequest
} from "../models";
import {
  SystemClock,
  Timeout
} from "../utils";
import {
  CircuitBreakerRegistry
} from "./CircuitBreakerRegistry";

export interface ProviderRunResult {
  opinions: AiOpinion[];
  failures: AiProviderFailure[];
}

export class ProviderOrchestrator {
  constructor(
    private readonly providers:
      readonly IAiProvider[],
    private readonly parser: IAiResponseParser,
    private readonly config: AiEngineConfig,
    private readonly circuitBreakers =
      new CircuitBreakerRegistry(config),
    private readonly clock: IClock =
      new SystemClock()
  ) {}

  async run(
    request: AiProviderRequest
  ): Promise<ProviderRunResult> {
    const results = await Promise.all(
      this.providers.map((provider) =>
        this.callProvider(provider, request)
      )
    );

    return {
      opinions: results.flatMap((result) =>
        "opinion" in result
          ? [result.opinion]
          : []
      ),
      failures: results.flatMap((result) =>
        "failure" in result
          ? [result.failure]
          : []
      )
    };
  }

  private async callProvider(
    provider: IAiProvider,
    request: AiProviderRequest
  ): Promise<
    | { opinion: AiOpinion }
    | { failure: AiProviderFailure }
  > {
    const now = this.clock.now();

    if (
      provider.kind === "REMOTE" &&
      !this.config.allowExternalProviders
    ) {
      return {
        failure: {
          providerId: provider.id,
          message:
            "External providers are disabled by configuration.",
          retryable: false,
          attempts: 0,
          occurredAt: now
        }
      };
    }

    if (
      !this.circuitBreakers.canCall(
        provider.id,
        now
      )
    ) {
      return {
        failure: {
          providerId: provider.id,
          message: "Provider circuit breaker is open.",
          retryable: true,
          attempts: 0,
          occurredAt: now
        }
      };
    }

    let lastError: unknown;
    const maximumAttempts =
      this.config.providerMaxRetries + 1;

    for (
      let attempt = 1;
      attempt <= maximumAttempts;
      attempt += 1
    ) {
      try {
        const response =
          await Timeout.withTimeout(
            provider.generate(request),
            this.config.providerTimeoutMs,
            `Provider ${provider.id} timed out.`
          );
        const opinion = this.parser.parse(response);
        this.circuitBreakers.recordSuccess(
          provider.id,
          this.clock.now()
        );
        return { opinion };
      } catch (error) {
        lastError = error;
      }
    }

    this.circuitBreakers.recordFailure(
      provider.id,
      this.clock.now()
    );

    return {
      failure: {
        providerId: provider.id,
        message:
          lastError instanceof Error
            ? lastError.message
            : "Unknown provider failure.",
        retryable: true,
        attempts: maximumAttempts,
        occurredAt: this.clock.now()
      }
    };
  }
}
