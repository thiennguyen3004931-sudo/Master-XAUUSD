import type {
  AiConsensus,
  AiContext,
  AiPolicyResult
} from "../models";

export interface IAiPolicy {
  apply(
    context: AiContext,
    consensus: AiConsensus | null
  ): AiPolicyResult;
}
