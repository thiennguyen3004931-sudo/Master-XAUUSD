import type { SignalDirection, SignalRuleResult } from "../models";
import { NumberUtils } from "./NumberUtils";

export class RuleResultFactory {
  static create(
    rule: string,
    maximumPoints: number,
    direction: SignalDirection,
    strength: number,
    reason: string,
    evidence?: Record<string, number | string | boolean | null>,
  ): SignalRuleResult {
    const normalizedStrength = NumberUtils.clamp(strength, 0, 1);
    const points = NumberUtils.round(maximumPoints * normalizedStrength, 4);

    return {
      rule,
      direction,
      bullishPoints: direction === "BULLISH" ? points : 0,
      bearishPoints: direction === "BEARISH" ? points : 0,
      maximumPoints,
      reason,
      evidence,
    };
  }

  static neutral(
    rule: string,
    maximumPoints: number,
    reason: string,
    evidence?: Record<string, number | string | boolean | null>,
  ): SignalRuleResult {
    return this.create(rule, maximumPoints, "NEUTRAL", 0, reason, evidence);
  }
}
