import type {
  AiProviderKind,
  AiProviderRequest,
  AiProviderResponse
} from "../models";

export interface IAiProvider {
  readonly id: string;
  readonly kind: AiProviderKind;
  readonly model: string;

  generate(
    request: AiProviderRequest
  ): Promise<AiProviderResponse>;
}
