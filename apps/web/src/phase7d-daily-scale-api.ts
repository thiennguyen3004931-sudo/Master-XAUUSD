import type {
  Phase7DDailyScaleRequest,
  Phase7DDailyScaleResult,
} from "./phase7d-daily-scale-types";

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

export async function runPhase7DDailyScaleBacktest(
  input: Phase7DDailyScaleRequest,
): Promise<Phase7DDailyScaleResult> {
  const response = await fetch(`${API_BASE}/api/v1/phase7d/daily-scale-backtest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const payload = await response.json() as Phase7DDailyScaleResult | { error?: string };
  if (!response.ok) {
    throw new Error("error" in payload && payload.error ? payload.error : `HTTP ${response.status}`);
  }
  return payload as Phase7DDailyScaleResult;
}
