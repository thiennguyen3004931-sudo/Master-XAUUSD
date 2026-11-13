import type { ExecutionEngineConfig } from "../config";
import type { IExecutionRule } from "../contracts";
import type {
  ExecutionPreflightDraft,
  ExecutionRequest,
  ExecutionRuleResult,
} from "../models";

export class VolumeRule implements IExecutionRule {
  readonly name = "volume";

  evaluate(
    _request: ExecutionRequest,
    draft: ExecutionPreflightDraft,
    _config: ExecutionEngineConfig,
  ): ExecutionRuleResult {
    const volume = draft.normalizedOrder?.volume ?? 0;
    const minimum = draft.spec?.minVolume ?? Number.POSITIVE_INFINITY;
    const maximum = draft.spec?.maxVolume ?? 0;
    const passed =
      Number.isFinite(volume) &&
      volume >= minimum &&
      volume <= maximum;

    return {
      rule: this.name,
      passed,
      code: passed ? undefined : "VOLUME_INVALID",
      message: passed
        ? "Normalized order volume is valid."
        : "Normalized order volume falls outside broker limits.",
      metrics: {
        volume,
        minimumVolume: minimum,
        maximumVolume: maximum,
      },
    };
  }
}
