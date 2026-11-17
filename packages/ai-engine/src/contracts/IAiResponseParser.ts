import type {
  AiOpinion,
  AiProviderResponse
} from "../models";

export interface IAiResponseParser {
  parse(response: AiProviderResponse): AiOpinion;
}
