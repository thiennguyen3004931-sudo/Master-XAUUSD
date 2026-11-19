export interface PartialCloseCommand {
  type: "PARTIAL_CLOSE";
  commandId: string;
  ticket: string;
  volume: number;
  targetLabel: string;
  reason: string;
  expiresAt: number;
}

export interface ModifyStopCommand {
  type: "MODIFY_STOP";
  commandId: string;
  ticket: string;
  stopLoss: number;
  takeProfit?: number;
  reason: "BREAK_EVEN" | "TRAILING_STOP";
  expiresAt: number;
}

export interface ClosePositionCommand {
  type: "CLOSE_POSITION";
  commandId: string;
  ticket: string;
  volume: number;
  reason:
    | "TIME_STOP"
    | "HARD_INVALIDATION"
    | "TREND_STRUCTURE_BREAK";
  expiresAt: number;
}

export type ManagementCommand =
  | PartialCloseCommand
  | ModifyStopCommand
  | ClosePositionCommand;