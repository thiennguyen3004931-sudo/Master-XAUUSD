import type { Phase7CPerformanceIntelligenceSnapshot } from "./phase7c-performance-intelligence-types";

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

async function readJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "GET",
    cache: "no-store",
    headers: { accept: "application/json" },
  });
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
  return payload as T;
}

export function getPhase7CPerformanceIntelligence(
  days = 90,
  symbol = "XAUUSD",
): Promise<Phase7CPerformanceIntelligenceSnapshot> {
  const params = new URLSearchParams({ days: String(days), symbol });
  return readJson<Phase7CPerformanceIntelligenceSnapshot>(
    `/api/v1/phase7c/performance-intelligence?${params.toString()}`,
  );
}
