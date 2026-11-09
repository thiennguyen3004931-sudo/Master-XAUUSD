export interface Mt5TransportRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  timeoutMs?: number;
  idempotent?: boolean;
}

export interface IMt5Transport {
  request<T>(request: Mt5TransportRequest): Promise<T>;
}
