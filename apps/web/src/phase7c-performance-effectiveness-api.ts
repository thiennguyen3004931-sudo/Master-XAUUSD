import type { Phase7CPerformanceEffectivenessSnapshot } from "./phase7c-performance-effectiveness-types";

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

export async function getPhase7CPerformanceEffectiveness(
  days = 90,
  symbol = "XAUUSD",
  limit = 100,
): Promise<Phase7CPerformanceEffectivenessSnapshot> {
  const params = new URLSearchParams({
    days: String(days),
    symbol,
    limit: String(limit),
  });
  const response = await fetch(
    `${API_BASE}/api/v1/phase7c/performance-effectiveness?${params.toString()}`,
    {
      method: "GET",
      cache: "no-store",
      headers: { accept: "application/json" },
    },
  );
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error?: unknown }).error ?? response.statusText)
        : response.statusText;
    throw new Error(message || `HTTP ${response.status}`);
  }
  return payload as Phase7CPerformanceEffectivenessSnapshot;
}
