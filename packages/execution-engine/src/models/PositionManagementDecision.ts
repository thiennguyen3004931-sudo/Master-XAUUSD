import type { ManagementCommand } from "./ManagementCommand";
import type { PositionManagementState } from "./PositionManagementState";

export interface PositionManagementDecision {
  commands: ManagementCommand[];
  updatedState: PositionManagementState;
  currentRiskMultiple: number;
  notes: string[];
  generatedAt: number;
}
