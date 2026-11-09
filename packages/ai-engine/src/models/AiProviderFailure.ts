export interface AiProviderFailure {
  providerId: string;
  message: string;
  retryable: boolean;
  attempts: number;
  occurredAt: number;
}
