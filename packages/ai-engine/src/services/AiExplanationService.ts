import type { AiDecision } from "../models";

export class AiExplanationService {
  summarize(decision: AiDecision): string {
    const lines = [
      `AI action: ${decision.policy.action}`,
      `Executable: ${decision.executable ? "YES" : "NO"}`,
      `Original strategy confidence: ${decision.policy.originalStrategyConfidence.toFixed(2)}`,
      `Adjusted confidence: ${decision.policy.adjustedConfidence.toFixed(2)}`
    ];

    if (decision.consensus) {
      lines.push(
        `Provider agreement: ${(decision.consensus.agreementRatio * 100).toFixed(2)}%`,
        `Consensus confidence: ${decision.consensus.confidence.toFixed(2)}`
      );
    }

    for (
      const reason of decision.policy.policyReasons
    ) {
      lines.push(`Reason: ${reason}`);
    }

    return lines.join("\n");
  }
}
