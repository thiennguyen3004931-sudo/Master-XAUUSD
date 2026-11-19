export interface PositionManagementState {
  initialVolume: number;
  completedTargetLabels: string[];
  breakEvenApplied: boolean;
  trailingActivated?: boolean;
  trailingStopPrice?: number;
  lastManagedAt?: number;
}