import type { SignalDirection } from "./SignalDirection";

export interface SignalRuleResult {
  rule: string;
  direction: SignalDirection;
  bullishPoints: number;
  bearishPoints: number;
  maximumPoints: number;
  reason: string;
  evidence?: Record<string, number | string | boolean | null>;
}
