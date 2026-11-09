export interface Mt5BridgeCommandResponse {
  commandId: string;
  success: boolean;
  message: string;
  retcode?: number;
  executedAt: number;
  idempotentReplay: boolean;
}
