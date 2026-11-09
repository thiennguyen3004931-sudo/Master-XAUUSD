import type { IAiProvider, IClock } from "../contracts";
import type {
  AiProviderKind,
  AiProviderRequest,
  AiProviderResponse
} from "../models";
import { SystemClock } from "../utils";

export interface JsonHttpAiProviderConfig {
  id: string;
  kind?: Exclude<
    AiProviderKind,
    "DETERMINISTIC"
  >;
  model: string;
  endpoint: string;
  headers?: Readonly<Record<string, string>>;
  buildBody?: (
    request: AiProviderRequest
  ) => unknown;
  extractContent?: (
    response: unknown
  ) => string;
}

export class JsonHttpAiProvider
  implements IAiProvider
{
  readonly id: string;
  readonly kind: Exclude<
    AiProviderKind,
    "DETERMINISTIC"
  >;
  readonly model: string;

  constructor(
    private readonly config:
      JsonHttpAiProviderConfig,
    private readonly clock: IClock = new SystemClock()
  ) {
    this.id = config.id;
    this.kind = config.kind ?? "REMOTE";
    this.model = config.model;
  }

  async generate(
    request: AiProviderRequest
  ): Promise<AiProviderResponse> {
    const startedAt = this.clock.now();
    const response = await fetch(
      this.config.endpoint,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...this.config.headers
        },
        body: JSON.stringify(
          this.config.buildBody
            ? this.config.buildBody(request)
            : {
                model: this.model,
                messages: request.messages,
                response_format: {
                  type: "json_object"
                },
                metadata: request.metadata
              }
        )
      }
    );

    if (!response.ok) {
      throw new Error(
        `AI provider ${this.id} returned HTTP ${response.status}.`
      );
    }

    const body: unknown = await response.json();
    const content = this.config.extractContent
      ? this.config.extractContent(body)
      : this.defaultExtract(body);

    return {
      providerId: this.id,
      providerKind: this.kind,
      model: this.model,
      requestId: request.requestId,
      content,
      latencyMs:
        Math.max(0, this.clock.now() - startedAt),
      createdAt: this.clock.now()
    };
  }

  private defaultExtract(body: unknown): string {
    if (
      body !== null &&
      typeof body === "object"
    ) {
      const record =
        body as Record<string, unknown>;
      if (typeof record.content === "string") {
        return record.content;
      }
      if (typeof record.output_text === "string") {
        return record.output_text;
      }
    }

    throw new Error(
      "AI provider response does not contain content or output_text."
    );
  }
}
