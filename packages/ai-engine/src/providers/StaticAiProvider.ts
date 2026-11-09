import type { IAiProvider, IClock } from "../contracts";
import type {
  AiProviderKind,
  AiProviderRequest,
  AiProviderResponse,
  AiStructuredOpinion
} from "../models";
import { SystemClock } from "../utils";

export class StaticAiProvider
  implements IAiProvider
{
  constructor(
    readonly id: string,
    readonly model: string,
    private readonly opinion:
      AiStructuredOpinion,
    readonly kind:
      AiProviderKind = "LOCAL",
    private readonly clock:
      IClock = new SystemClock()
  ) {}

  async generate(
    request: AiProviderRequest
  ): Promise<AiProviderResponse> {
    return {
      providerId: this.id,
      providerKind: this.kind,
      model: this.model,
      requestId: request.requestId,
      content: JSON.stringify(this.opinion),
      latencyMs: 0,
      createdAt: this.clock.now()
    };
  }
}
