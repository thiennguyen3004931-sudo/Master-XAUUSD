import type { ExecutionEngineConfig } from "../config";
import type { IExecutionRule } from "../contracts";
import type {
  ExecutionPreflightDraft,
  ExecutionRequest,
  ExecutionRuleResult,
} from "../models";

export class StopsDistanceRule implements IExecutionRule {
  readonly name = "stops-distance";

  evaluate(
    _request: ExecutionRequest,
    draft: ExecutionPreflightDraft,
    config: ExecutionEngineConfig,
  ): ExecutionRuleResult {
    const order = draft.normalizedOrder;
    const tickSize = draft.spec?.tickSize ?? 0;
    const brokerMinimum =
      draft.spec?.stopsLevelTicks ?? 0;
    const minimumStopTicks = Math.max(
      brokerMinimum,
      config.minimumStopDistanceTicks,
    );
    const minimumTargetTicks = Math.max(
      brokerMinimum,
      config.minimumTargetDistanceTicks,
    );
    const stopTicks =
      order && tickSize > 0
        ? Math.abs(order.requestedPrice - order.stopLoss) /
          tickSize
        : 0;
    const targetTicks =
      order && tickSize > 0
        ? Math.abs(order.takeProfit - order.requestedPrice) /
          tickSize
        : 0;
    const stopPassed = stopTicks >= minimumStopTicks;
    const targetPassed = targetTicks >= minimumTargetTicks;
    const passed = stopPassed && targetPassed;

    return {
      rule: this.name,
      passed,
      code: !stopPassed
        ? "STOPS_TOO_CLOSE"
        : !targetPassed
          ? "TARGET_TOO_CLOSE"
          : undefined,
      message: passed
        ? "Stop loss and take profit satisfy distance limits."
        : !stopPassed
          ? "Stop loss is too close to the requested price."
          : "Take profit is too close to the requested price.",
      metrics: {
        stopTicks,
        targetTicks,
        minimumStopTicks,
        minimumTargetTicks,
      },
    };
  }
}
