import type {
  Phase7DManagementRequest,
  Phase7DManagementResult,
} from "./phase7d-management-types";

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

export async function runPhase7DManagementBacktest(
  input: Phase7DManagementRequest,
): Promise<Phase7DManagementResult> {
  const response = await fetch(`${API_BASE}/api/v1/phase7d/management-backtest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const payload = await response.json() as Phase7DManagementResult | { error?: unknown };
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload
      ? String(payload.error ?? `HTTP ${response.status}`)
      : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload as Phase7DManagementResult;
}
