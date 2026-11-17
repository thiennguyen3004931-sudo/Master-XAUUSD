export interface PositionSizing {
  entry: number;
  stopLoss: number;
  stopDistance: number;
  stopTicks: number;
  riskPerLot: number;
  rawVolume: number;
  volume: number;
  actualRiskAmount: number;
  actualRiskPercent: number;
  cappedAtMaximum: boolean;
  belowMinimum: boolean;
}
