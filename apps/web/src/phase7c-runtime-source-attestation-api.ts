import type { Phase7CRuntimeSourceAttestationSnapshot } from "./phase7c-runtime-source-attestation-types";

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

export async function getPhase7CRuntimeSourceAttestation(): Promise<Phase7CRuntimeSourceAttestationSnapshot> {
  const response = await fetch(`${API_BASE}/api/v1/phase7c/runtime-source-attestation`, {
    cache: "no-store",
  });
  const text = await response.text();
  let payload: unknown = null;
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("Runtime source attestation returned invalid JSON.");
    }
  }
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload
      ? String((payload as { error?: unknown }).error ?? "")
      : "";
    throw new Error(message || `Runtime source attestation HTTP ${response.status}.`);
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("Runtime source attestation returned an empty payload.");
  }
  return payload as Phase7CRuntimeSourceAttestationSnapshot;
}
