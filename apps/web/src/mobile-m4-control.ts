export type MobileM4Mode = "AUTO" | "SEMI" | "TREND" | "SIDEWAY" | "PAUSE";
export type MobileM4ArmAction = "ARM_LIVE" | "DISARM_LIVE";

type FetchLike = typeof fetch;

export type MobileM4State = {
  operator: string;
  mode: string;
  auto: {
    approved: boolean;
    accountMode: string | null;
    botMode: string;
    liveArmRequired: boolean;
    liveArmStatus: string | null;
    checks: Record<string, boolean>;
    blockedBy: string[];
  };
  arm: {
    accountMode: string | null;
    botMode: string;
    liveArmStatus: string | null;
    liveExecutionArmed: boolean;
    bridgeSessionId: string | null;
    openXauusdPositions: number;
    canArm: boolean;
    canDisarm: boolean;
    armChecks: Record<string, boolean>;
    armBlockedBy: string[];
    disarmChecks: Record<string, boolean>;
    disarmBlockedBy: string[];
  };
};

export type MobileM4ModeResult = {
  action: string;
  outcome: "PASS" | "FAIL" | "AMBIGUOUS";
  httpStatus?: number;
  message?: string;
  auditDegraded?: boolean;
  result?: unknown;
};

export type MobileM4ArmPreflight = {
  action: MobileM4ArmAction;
  phase: "PREFLIGHT";
  approved: boolean;
  transactionId?: string;
  expiresAt?: number | null;
  checks?: Record<string, boolean>;
  blockedBy?: string[];
  bridgeSessionId?: string | null;
  liveArmStatus?: string;
};

export type MobileM4ArmExecute = {
  action: MobileM4ArmAction;
  transactionId: string;
  requestId?: string;
  outcome: "RUNNING" | "FAIL" | "AMBIGUOUS";
  message?: string;
  auditDegraded?: boolean;
};

export type MobileM4ArmStatus = {
  transactionId: string;
  action: MobileM4ArmAction;
  requestId?: string;
  status: "PREFLIGHT_READY" | "RUNNING" | "PASS" | "FAIL" | "AMBIGUOUS";
  phase?: string;
  message?: string;
  finalArmStatus: string | null;
};

async function requestJson<T>(path: string, init: RequestInit, fetchImpl: FetchLike): Promise<T> {
  if (!path.startsWith("/__m4/")) throw new Error("M4_SAME_ORIGIN_PATH_REQUIRED");
  const response = await fetchImpl(path, { cache: "no-store", ...init });
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`M4 trả JSON không hợp lệ (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    const errorPayload = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const message = typeof errorPayload.error === "string"
      ? errorPayload.error
      : typeof errorPayload.message === "string"
        ? errorPayload.message
        : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

export function getMobileM4State(fetchImpl: FetchLike = fetch) {
  return requestJson<MobileM4State>("/__m4/state", { method: "GET" }, fetchImpl);
}

export function executeMobileMode(mode: MobileM4Mode, fetchImpl: FetchLike = fetch) {
  const action = `MODE_${mode}` as const;
  return requestJson<MobileM4ModeResult>("/__m4/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, confirmation: action }),
  }, fetchImpl);
}

export function preflightMobileArm(action: MobileM4ArmAction, fetchImpl: FetchLike = fetch) {
  return requestJson<MobileM4ArmPreflight>("/__m4/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, phase: "PREFLIGHT" }),
  }, fetchImpl);
}

export function executeMobileArm(action: MobileM4ArmAction, transactionId: string, fetchImpl: FetchLike = fetch) {
  return requestJson<MobileM4ArmExecute>("/__m4/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, phase: "EXECUTE", transactionId, confirmation: action }),
  }, fetchImpl);
}

export function getMobileArmStatus(transactionId: string, fetchImpl: FetchLike = fetch) {
  return requestJson<MobileM4ArmStatus>(
    `/__m4/status?transactionId=${encodeURIComponent(transactionId)}`,
    { method: "GET" },
    fetchImpl,
  );
}
