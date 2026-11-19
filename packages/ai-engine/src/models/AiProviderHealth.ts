export interface AiProviderHealth {
  providerId: string;
  state: "CLOSED" | "OPEN" | "HALF_OPEN";
  consecutiveFailures: number;
  openedAt?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
}
