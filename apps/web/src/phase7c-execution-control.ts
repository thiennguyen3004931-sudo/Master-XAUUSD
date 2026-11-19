import { requestLocalControlJson } from "./local-control-request";

const LIVE_ARM_BASE = "/api/v1/phase7c-live-arm-control";
const AUTO_BASE = "/api/v1/phase7c-auto-activation";

export type Phase7CLiveArmAction = "ARM_LIVE" | "DISARM_LIVE";
export type Phase7CBotExecutionMode = "AUTO" | "TREND" | "SIDEWAY" | "SEMI" | "PAUSE";
export type Phase7CBooleanChecks = Record<string, boolean>;

export type Phase7CLiveArmControlCapability = {
  taskInstalled: boolean;
  accountMode: "DEMO" | "LIVE";
  botMode: string;
  liveArmStatus: string;
  liveExecutionArmed: boolean;
  bridgeSessionId: string | null;
  openXauusdPositions: number;
  canArm: boolean;
  canDisarm: boolean;
  armChecks: Phase7CBooleanChecks;
  armBlockedBy: string[];
  disarmChecks: Phase7CBooleanChecks;
  disarmBlockedBy: string[];
  safety: {
    localOnly: true;
    elevatedTaskName: string;
    canonicalArmScript: string;
    canonicalDisarmScript: string;
    orderSend: false;
    autoAfterArm: false;
  };
};

export type Phase7CLiveArmPreflight = {
  approved: boolean;
  action: Phase7CLiveArmAction;
  accountMode: string;
  botMode: string;
  liveArmStatus: string;
  liveExecutionArmed: boolean;
  bridgeSessionId: string | null;
  openXauusdPositions: number;
  taskInstalled: boolean;
  checks: Phase7CBooleanChecks;
  blockedBy: string[];
  preflightToken: string | null;
  expiresAt: number | null;
};

export type Phase7CLiveArmExecuteResponse = {
  accepted: true;
  requestId: string;
  action: Phase7CLiveArmAction;
  status: "RUNNING";
  message: string;
};

export type Phase7CLiveArmControlStatus = {
  requestId: string;
  action: Phase7CLiveArmAction;
  status: "RUNNING" | "PASS" | "FAIL";
  phase: string;
  message: string;
  finalArmStatus: string;
};

export type Phase7CAutoActivationStatus = {
  approved: boolean;
  accountMode: "DEMO" | "LIVE";
  brokerAccountMode: string | null;
  botMode: string;
  liveArmRequired: boolean;
  liveArmStatus: string | null;
  checks: Phase7CBooleanChecks;
  blockedBy: string[];
};

export type Phase7CAutoEnableResponse = Phase7CAutoActivationStatus & {
  state: {
    mode: Phase7CBotExecutionMode;
    updatedAt: string;
    updatedBy: string;
  };
  options: Phase7CBotExecutionMode[];
};

export function getPhase7CLiveArmControlCapability() {
  return requestLocalControlJson<Phase7CLiveArmControlCapability>(`${LIVE_ARM_BASE}/capability`);
}

export function createPhase7CLiveArmPreflight(action: Phase7CLiveArmAction) {
  return requestLocalControlJson<Phase7CLiveArmPreflight>(`${LIVE_ARM_BASE}/preflight`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action }),
  });
}

export function executePhase7CLiveArmAction(
  action: Phase7CLiveArmAction,
  preflightToken: string,
) {
  return requestLocalControlJson<Phase7CLiveArmExecuteResponse>(`${LIVE_ARM_BASE}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, preflightToken, confirmation: action }),
  });
}

export function getPhase7CLiveArmControlStatus(requestId: string) {
  return requestLocalControlJson<Phase7CLiveArmControlStatus>(
    `${LIVE_ARM_BASE}/status?requestId=${encodeURIComponent(requestId)}`,
  );
}

export function getPhase7CAutoActivationStatus() {
  return requestLocalControlJson<Phase7CAutoActivationStatus>(`${AUTO_BASE}/status`);
}

export async function enablePhase7CAuto(): Promise<Phase7CAutoEnableResponse> {
  const payload = await requestLocalControlJson<Omit<Phase7CAutoEnableResponse, "options">>(`${AUTO_BASE}/enable`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  return {
    ...payload,
    options: ["AUTO", "TREND", "SIDEWAY", "SEMI", "PAUSE"],
  };
}