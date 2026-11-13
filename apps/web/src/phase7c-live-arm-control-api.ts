import { requestLocalControlJson } from "./local-control-request";

export type Phase7CLiveArmControlCapability = {
  taskInstalled: boolean;
  accountMode: string;
  botMode: string;
  liveArmStatus: string;
  liveExecutionArmed: boolean;
  bridgeSessionId: string | null;
  openXauusdPositions: number;
  orphanedControlRequest: boolean;
  canArm: boolean;
  canDisarm: boolean;
  armChecks: Record<string, boolean>;
  armBlockedBy: string[];
  disarmChecks: Record<string, boolean>;
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

const LIVE_ARM_CONTROL_BASE = "/api/v1/phase7c/live-arm-control";

export function getPhase7CLiveArmControlCapability() {
  return requestLocalControlJson<Phase7CLiveArmControlCapability>(
    `${LIVE_ARM_CONTROL_BASE}/capability`,
  );
}
