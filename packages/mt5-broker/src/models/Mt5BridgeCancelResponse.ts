export interface Mt5BridgeCancelResponse {
  success: boolean;
  message: string;
  retcode?: number;
  executedAt: number;
  idempotentReplay: boolean;
}
