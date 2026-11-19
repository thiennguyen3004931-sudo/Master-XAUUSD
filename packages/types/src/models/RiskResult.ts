export interface RiskResult<TPosition = unknown> {
  approved: boolean;
  reason?: string;
  riskAmount?: number;
  riskPercent?: number;
  positionSize?: number;
  position?: TPosition;
}
